    // ============================================================
    // 19-seq-pad.js — "Seq" mode: a clip-launcher grid of saved sequences
    // ============================================================
    // The seventh per-lane mode (Grid → Graph → Game → Prog → Bloom → TEXT →
    // Seq). Each grid square is one saved sequence from the bank. With Keep OFF
    // you AUDITION sequences (clip launcher); with Keep ON a press silently
    // appends that sequence to the active lane as one compact subsequence chip.
    //
    // Audition toggles (Keep OFF):
    //   • Loop  — off: a triggered clip plays once; on: it loops indefinitely.
    //   • Gate  — off: a press triggers playback (click-and-go); on: a clip
    //             plays only while the pad is held, releasing stops it.
    //   • Layer ⇄ Queue —
    //       Layer: a new press plays immediately, layered over what's playing.
    //       Queue: a new press lines up to start when the current clip ends
    //              (each plays once and chains; Loop is ignored in Queue).
    // Every audition is recorded in trigger order; "→ Lane" commits the whole
    // run into the active lane in that order.
    //
    // Playback is a self-contained setTimeout walker (its own clock at the
    // saved sequence's own BPM), independent of the main transport — so a clip
    // can sound whether or not the global ▶ is running. Stopping clears pending
    // step timers; the currently-sounding note tails out on its own envelope
    // (a soft gate — no per-clip voice tracking in this version).

    let _seqInited = false;
    let _seqLoop = false;            // loop a triggered clip indefinitely
    let _seqGate = false;            // play-while-held
    let _seqOverlap = 'layer';       // 'layer' | 'queue'
    let _seqActiveClips = [];        // running clip handles (Layer / Gate)
    let _seqQueue = [];              // pending saved-indexes (Queue mode)
    let _seqCurrent = null;          // { idx, handle } currently playing (Queue)
    let _seqOrder = [];              // saved-indexes in the order they were triggered
    const _seqGateHandles = new Map(); // pointerId → clip handle (Gate)

    function _seqGet(id) { return document.getElementById(id); }

    // ---- Clip playback engine ------------------------------------------
    function _seqBpm(saved) {
      const b = saved && parseInt(saved.bpm, 10);
      if (Number.isFinite(b) && b > 0) return b;
      const live = (typeof tempoInput !== 'undefined' && tempoInput) ? parseInt(tempoInput.value, 10) : 0;
      return (Number.isFinite(live) && live > 0) ? live : 120;
    }
    function _seqStepWaitMs(s, bpm) {
      const dur = s.duration || 1;
      const sub = (s.subdivision != null) ? s.subdivision
                : (typeof stepSubdivision === 'number' ? stepSubdivision : 0.5);
      return Math.round(60000 / bpm * sub) * dur;
    }
    // Flatten a step list into ordered leaf events (notes / chords / rests),
    // expanding subsequences so the clip plays exactly as the sequence reads.
    function _seqFlatten(steps) {
      const out = [];
      const walk = (arr) => {
        for (const s of (arr || [])) {
          if (s && s.isSub && Array.isArray(s.subSteps) && s.subSteps.length) walk(s.subSteps);
          else if (s) out.push(s);
        }
      };
      walk(steps);
      return out;
    }
    function _seqVoiceParams(n, size, step) {
      let p = n.params || n.sound || 'sine';
      try { if (size > 1 && typeof chordVoiceParams === 'function') p = chordVoiceParams(n.params || n.sound || 'sine', size, step); } catch (e) {}
      try { if (typeof paramsWithBend === 'function') p = paramsWithBend(p, step && step.bend); } catch (e) {}
      return p;
    }
    function _seqFireStep(s, bpm) {
      const waitMs = _seqStepWaitMs(s, bpm);
      try {
        if (s.chord && Array.isArray(s.chord)) {
          const size = s.chord.length;
          s.chord.forEach(n => { if (n && n.freq != null) playNote(n.freq, _seqVoiceParams(n, size, s), waitMs); });
        } else if (s.freq != null) {
          playNote(s.freq, _seqVoiceParams(s, 1, s), waitMs);
        }
      } catch (e) {}
      return waitMs;
    }
    // Start playing `steps` at `bpm`. Returns a handle with .stop(); loops if
    // opts.loop; calls opts.onEnd() when a non-looping run finishes.
    function _seqPlayClip(steps, opts) {
      opts = opts || {};
      const bpm = opts.bpm || 120;
      const flat = _seqFlatten(steps);
      const handle = { stopped: false, timers: [], square: opts.square || null };
      const pass = () => {
        if (handle.stopped) return;
        let t = 0;
        for (const s of flat) {
          const w = _seqStepWaitMs(s, bpm);
          const id = setTimeout(() => { if (!handle.stopped) _seqFireStep(s, bpm); }, t);
          handle.timers.push(id);
          t += w;
        }
        const endId = setTimeout(() => {
          handle.timers = [];
          if (handle.stopped) return;
          if (opts.loop) pass();
          else { handle.stopped = true; _seqMarkSquare(handle.square, false); if (opts.onEnd) opts.onEnd(); }
        }, Math.max(1, t));
        handle.timers.push(endId);
      };
      handle.stop = () => {
        if (handle.stopped) return;
        handle.stopped = true;
        handle.timers.forEach(clearTimeout);
        handle.timers = [];
        _seqMarkSquare(handle.square, false);
      };
      if (!flat.length) { handle.stopped = true; if (opts.onEnd) opts.onEnd(); return handle; }
      _seqMarkSquare(handle.square, true);
      pass();
      return handle;
    }
    function _seqMarkSquare(sq, on) { if (sq) sq.classList.toggle('playing', !!on); }

    function _seqStopAll() {
      _seqActiveClips.forEach(h => { try { h.stop(); } catch (e) {} });
      _seqActiveClips = [];
      _seqGateHandles.forEach(h => { try { h.stop(); } catch (e) {} });
      _seqGateHandles.clear();
      if (_seqCurrent && _seqCurrent.handle) { try { _seqCurrent.handle.stop(); } catch (e) {} }
      _seqCurrent = null;
      _seqQueue = [];
    }

    // ---- Trigger / release (Keep OFF audition) -------------------------
    function _seqSavedAt(idx) {
      return (typeof savedSequences !== 'undefined' && Array.isArray(savedSequences)) ? savedSequences[idx] : null;
    }
    function _seqRecordOrder(idx) { _seqOrder.push(idx); _seqRefreshCommit(); }

    function _seqTrigger(idx, pointerId, square) {
      const saved = _seqSavedAt(idx);
      if (!saved || !Array.isArray(saved.steps) || !saved.steps.length) return;
      try { Tone.start(); } catch (e) {}
      _seqRecordOrder(idx);
      const bpm = _seqBpm(saved);
      if (_seqGate) {
        const h = _seqPlayClip(saved.steps, { bpm, loop: _seqLoop, square });
        if (pointerId != null) _seqGateHandles.set(pointerId, h); else _seqActiveClips.push(h);
        return;
      }
      if (_seqOverlap === 'queue') {
        if (_seqCurrent) { _seqQueue.push({ idx, square }); }
        else _seqStartQueued(idx, square);
        return;
      }
      // Layer: independent, overlapping clip.
      const h = _seqPlayClip(saved.steps, {
        bpm, loop: _seqLoop, square,
        onEnd: () => { _seqActiveClips = _seqActiveClips.filter(x => x !== h); }
      });
      _seqActiveClips.push(h);
    }
    function _seqStartQueued(idx, square) {
      const saved = _seqSavedAt(idx);
      if (!saved) { _seqAdvanceQueue(); return; }
      const h = _seqPlayClip(saved.steps, {
        bpm: _seqBpm(saved), loop: false, square,
        onEnd: () => { _seqCurrent = null; _seqAdvanceQueue(); }
      });
      _seqCurrent = { idx, handle: h };
    }
    function _seqAdvanceQueue() {
      if (!_seqQueue.length) return;
      const next = _seqQueue.shift();
      _seqStartQueued(next.idx, next.square);
    }
    function _seqRelease(pointerId) {
      if (pointerId == null) return;
      const h = _seqGateHandles.get(pointerId);
      if (h) { try { h.stop(); } catch (e) {} _seqGateHandles.delete(pointerId); }
    }

    // ---- Append to lane (Keep ON, or "→ Lane" commit) ------------------
    function _seqClipStep(saved) {
      const sub = (saved.steps || []).map(s => (typeof cloneStep === 'function') ? cloneStep(s) : JSON.parse(JSON.stringify(s)));
      return {
        isSub: true,
        subSteps: sub,
        _seqClip: true,                       // compact lane chip (see stepLengthFactor)
        _seqName: saved.name || 'Seq',
        duration: 1,
        subdivision: (typeof stepSubdivision === 'number' ? stepSubdivision : 0.5),
      };
    }
    function _seqAppendToLane(idx) {
      const saved = _seqSavedAt(idx);
      if (!saved || !Array.isArray(saved.steps) || !saved.steps.length) return;
      if (typeof addToSequence === 'function') addToSequence(_seqClipStep(saved));
    }
    function _seqCommitOrder() {
      if (!_seqOrder.length) return;
      const order = _seqOrder.slice();
      _seqOrder = [];
      _seqRefreshCommit();
      order.forEach(idx => _seqAppendToLane(idx));
    }
    function _seqRefreshCommit() {
      const btn = _seqGet('seq-commit-btn');
      if (btn) {
        btn.textContent = '→ Lane (' + _seqOrder.length + ')';
        btn.disabled = _seqOrder.length === 0;
      }
    }

    // ---- UI -------------------------------------------------------------
    function _seqRenderControls() {
      const loopB = _seqGet('seq-loop-btn'); if (loopB) loopB.classList.toggle('active', _seqLoop);
      const gateB = _seqGet('seq-gate-btn'); if (gateB) gateB.classList.toggle('active', _seqGate);
      const ovB = _seqGet('seq-overlap-btn');
      if (ovB) { ovB.textContent = (_seqOverlap === 'queue') ? 'Queue' : 'Layer'; ovB.classList.toggle('queue', _seqOverlap === 'queue'); }
      _seqRefreshCommit();
    }
    function _seqRenderGrid() {
      const grid = _seqGet('seq-grid');
      if (!grid) return;
      grid.innerHTML = '';
      const list = (typeof savedSequences !== 'undefined' && Array.isArray(savedSequences)) ? savedSequences : [];
      let any = false;
      list.forEach((saved, idx) => {
        if (!saved || saved.type === 'audio' || !Array.isArray(saved.steps) || !saved.steps.length) return;
        any = true;
        const sq = document.createElement('button');
        sq.type = 'button';
        sq.className = 'seq-square';
        sq.dataset.idx = String(idx);
        sq.innerHTML = '<span class="seq-square-name"></span><span class="seq-square-meta">' + saved.steps.length + '</span>';
        sq.querySelector('.seq-square-name').textContent = saved.name || ('Seq ' + (idx + 1));
        sq.addEventListener('contextmenu', (e) => e.preventDefault());
        sq.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          if (typeof keepMode !== 'undefined' && keepMode) { _seqAppendToLane(idx); return; }
          _seqTrigger(idx, e.pointerId, sq);
        });
        const up = (e) => _seqRelease(e.pointerId);
        sq.addEventListener('pointerup', up);
        sq.addEventListener('pointercancel', up);
        sq.addEventListener('pointerleave', up);
        grid.appendChild(sq);
      });
      if (!any) {
        const empty = document.createElement('div');
        empty.className = 'seq-empty-note';
        empty.textContent = 'No saved sequences yet — build one in Grid mode and press Save, then it appears here.';
        grid.appendChild(empty);
      }
    }
    function _seqInit() {
      if (_seqInited) { _seqRenderGrid(); _seqRenderControls(); return; }
      const host = _seqGet('seq-inner');
      if (!host) return;
      host.innerHTML =
        '<div class="seq-toolbar">' +
          '<button type="button" class="seq-toggle" id="seq-loop-btn" title="Loop a triggered clip indefinitely (off = play once)">Loop</button>' +
          '<button type="button" class="seq-toggle" id="seq-gate-btn" title="Gate — clip plays only while the pad is held">Gate</button>' +
          '<button type="button" class="seq-toggle seq-overlap" id="seq-overlap-btn" title="Layer = overlap; Queue = chain one after another">Layer</button>' +
          '<span class="seq-toolbar-spacer"></span>' +
          '<button type="button" class="seq-commit" id="seq-commit-btn" title="Append every auditioned sequence to the active lane, in the order you played them" disabled>→ Lane (0)</button>' +
        '</div>' +
        '<div class="seq-grid" id="seq-grid"></div>';
      const loopB = _seqGet('seq-loop-btn');
      if (loopB) loopB.addEventListener('click', () => { _seqLoop = !_seqLoop; _seqRenderControls(); });
      const gateB = _seqGet('seq-gate-btn');
      if (gateB) gateB.addEventListener('click', () => { _seqGate = !_seqGate; _seqStopAll(); _seqRenderControls(); });
      const ovB = _seqGet('seq-overlap-btn');
      if (ovB) ovB.addEventListener('click', () => { _seqOverlap = (_seqOverlap === 'queue') ? 'layer' : 'queue'; _seqStopAll(); _seqRenderControls(); });
      const commitB = _seqGet('seq-commit-btn');
      if (commitB) commitB.addEventListener('click', () => _seqCommitOrder());
      _seqInited = true;
      _seqRenderGrid();
      _seqRenderControls();
    }
    // Called by _syncFluidGridToActiveLane when a lane enters/leaves Seq mode.
    function _onSeqModeChanged(active) {
      if (active) { _seqInit(); }
      else { _seqStopAll(); }
    }
    // Re-render the grid when the bank changes while Seq mode is showing.
    function _seqRefreshIfActive() {
      if (_seqInited && document.body.classList.contains('seq-mode')) _seqRenderGrid();
    }
