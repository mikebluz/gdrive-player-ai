    // ---- Sequence display ----

    // Visual width of a step chip. The reference unit is "length 1, step 1/1"
    // (subdivision value 4) → 80 px. Anything shorter shrinks proportionally;
    // anything longer grows. A subsequence's width is the sum of its subSteps.
    const STEP_BASE_PX = 80;
    function stepLengthFactor(step) {
      // Seq-pad clip chips render compact (one tidy block) instead of expanding
      // to the saved sequence's full internal length — coarser than a Grid note.
      // Visual only: the scheduler still unrolls subSteps for correct timing.
      if (step._seqClip) return 0.25;
      if (step.isSub && Array.isArray(step.subSteps)) {
        if (step.subSteps.length === 0) return 1;
        return step.subSteps.reduce((sum, s) => sum + stepLengthFactor(s), 0);
      }
      const dur = step.duration || 1;
      const sub = (step.subdivision != null) ? step.subdivision : stepSubdivision;
      return dur * sub / 4;
    }
    function stepWidthPx(step) {
      return STEP_BASE_PX * stepLengthFactor(step);
    }
    // ---- Bar grid (1 row = 1 bar) ------------------------------------------
    // Lane chips render as a CSS grid (.lane-chips: repeat(32, 1fr)) where one
    // row = one 4/4 bar = _BAR_SUBCELLS sub-cells, so the lane fits the strip
    // width with no horizontal scroll. A step spans round(stepLengthFactor ×
    // _BAR_SUBCELLS) cells; one whole note (factor 1) = a full bar/row. Steps
    // that cross a bar line split into continuation segments. _barGridPlan walks
    // one step from the current 1-based column cursor and returns its first-row
    // span, the spans of any continuation segments (one per extra row), and the
    // next column cursor.
    const _BAR_SUBCELLS = 32;
    function _barGridPlan(naturalSpan, startCol) {
      const N = _BAR_SUBCELLS;
      const capacity = N - (startCol - 1);
      if (naturalSpan <= capacity) {
        let nc = startCol + naturalSpan; if (nc > N) nc = 1;
        return { firstSpan: naturalSpan, continuations: [], newCol: nc };
      }
      const continuations = []; let rem = naturalSpan - capacity;
      while (rem > 0) { const seg = Math.min(N, rem); continuations.push(seg); rem -= seg; }
      const last = continuations[continuations.length - 1];
      const nc = (last === N) ? 1 : last + 1;
      return { firstSpan: capacity, continuations, newCol: nc };
    }
    function _barGridSpan(step) {
      return Math.max(1, Math.round(stepLengthFactor(step) * _BAR_SUBCELLS));
    }
    // A step is "off-grid" (a triplet or other non-binary value) when its
    // natural span in 32-cells isn't (close to) an integer — 32 isn't
    // divisible by 3, so triplets round to the nearest cell and drift. The
    // grid stays 32-cell (per the design decision); such chips are MARKED
    // (a ³ badge + accent, and a bracket over each group of 3) so the user
    // can see they're triplets even though the width is approximate.
    function _isTripletStep(step) {
      if (!step || step.isSub) return false;
      const raw = stepLengthFactor(step) * _BAR_SUBCELLS;
      return raw > 0 && Math.abs(raw - Math.round(raw)) > 0.04;
    }
    // ---- Subsequence extirpation -------------------------------------------
    // The "subsequence" step (isSub + subSteps[]) is being removed: a run of
    // notes is now just a series of INDIVIDUAL steps. These helpers expand any
    // isSub step into its leaf steps (recursively), preserving order and each
    // child's own duration/subdivision — which yields byte-identical playback
    // timing because the scheduler already times every step by its own
    // subdivision × duration and a subsequence's length is the sum of its
    // children. Parent-level keyContext / wrap-tone are carried onto children
    // that lack their own. Used at every step-creation funnel + on project load.
    function _flattenSubStep(step) {
      if (!step) return [];
      if (step.isSub && Array.isArray(step.subSteps)) {
        const kc = step.keyContext;
        return step.subSteps.flatMap(_flattenSubStep).map(s => {
          const o = { ...s };
          if (kc && !o.keyContext) o.keyContext = kc;
          return o;
        });
      }
      return [step];
    }
    function _flattenStepList(steps) {
      if (!Array.isArray(steps)) return steps;
      if (!steps.some(s => s && s.isSub)) return steps;   // fast path: nothing to do
      return steps.flatMap(_flattenSubStep);
    }
    // Single-row lane timeline: chip width ∝ duration at a larger base than the
    // legacy STEP_BASE_PX so chips stay readable/tappable on the scrolling row.
    // A 1/4 note ≈ 70px, 1/8 ≈ 35px; floored so very short steps don't vanish.
    const LANE_SCROLL_BASE_PX = 280;
    // User-adjustable horizontal zoom for the lane step-timeline. 1 = the
    // default LANE_SCROLL_BASE_PX density; <1 zooms out (more steps fit on the
    // row), >1 zooms in (each step wider). Persisted globally; the zoom slider
    // in the banner row writes it via setLaneViewScale, which re-renders lanes.
    let laneViewScale = (() => {
      try { const v = parseFloat(localStorage.getItem('lane-view-scale')); return (Number.isFinite(v) && v >= 0.05 && v <= 4) ? v : 1; }
      catch (e) { return 1; }
    })();
    function _laneViewBasePx() { return LANE_SCROLL_BASE_PX * laneViewScale; }
    function setLaneViewScale(s) {
      s = (typeof s === 'number' && isFinite(s)) ? s : 1;
      s = Math.max(0.05, Math.min(4, s));
      laneViewScale = s;
      try { localStorage.setItem('lane-view-scale', String(s)); } catch (e) {}
      if (typeof renderSequence === 'function') renderSequence();
    }
    function laneChipWidthPx(step) {
      return Math.max(10, Math.round(_laneViewBasePx() * stepLengthFactor(step)));
    }
    // Static left padding of .lane-chips (CSS: padding 4px 6px) — the content
    // origin when not playing. During playback _followChipInLane swaps in a
    // half-viewport padding to center the cursor; the bar overlay's left tracks
    // whichever is active.
    const _LANE_CHIPS_PAD_L = 6;
    // Add / refresh the faint bar-line overlay for one .lane-chips strip.
    // `totalPx` is the strip's content width (the layout total). The overlay
    // draws OVER the opaque chips and scrolls with them (abs child); its left is
    // pinned to the content origin so bars line up with the chip boundaries.
    function _addLaneBars(chipsEl, totalPx) {
      if (!chipsEl) return;
      // Bar grid: each ROW is already one bar, so the old vertical bar-line
      // overlay (for the horizontal timeline) is no longer drawn.
      { const old = chipsEl.querySelector(':scope > .lane-bars'); if (old) old.remove(); chipsEl._laneBars = null; return; }
      let bars = chipsEl.querySelector(':scope > .lane-bars');
      const basePx = _laneViewBasePx();
      if (!(totalPx > 4) || !(basePx > 0)) {        // truly empty lane
        if (bars) bars.remove();
        chipsEl._laneBars = null;
        return;
      }
      if (!bars) { bars = document.createElement('div'); bars.className = 'lane-bars'; chipsEl.appendChild(bars); }
      chipsEl._laneBars = bars;
      const padL = parseFloat(chipsEl.style && chipsEl.style.paddingLeft) || _LANE_CHIPS_PAD_L;
      chipsEl._barsBaseLeft = padL;
      // Extend the bar grid to cover whole bars AND fill the visible strip, so a
      // line shows at each bar boundary even when the sequence stops short of
      // one (e.g. a 3-beat lane still shows the end-of-bar line ahead of it).
      let gridW = Math.max(basePx, Math.ceil((totalPx - 0.5) / basePx) * basePx);
      const visW = (chipsEl.clientWidth || 0) - padL * 2;
      if (visW > gridW) gridW = Math.ceil(visW / basePx) * basePx;
      bars.style.left = padL + 'px';
      bars.style.width = gridW + 'px';
    }
    // Lane-timeline width allocator. Returns { widths, gap, total } where each
    // step's RIGHT EDGE is placed at the exact proportional pixel
    //   edge_k = round(LANE_SCROLL_BASE_PX · Σ factor up to step k)
    // and width_i = edge_i − edge_{i-1}. Two consequences, both wanted:
    //
    //  • ALIGNMENT across lanes — any boundary at the same cumulative musical
    //    position lands on the SAME pixel regardless of how a lane subdivides
    //    its steps (one ¼-note ends exactly where another lane's two ⅛-notes
    //    do). This is why there is NO inter-chip gap: a positive gap would push
    //    each successive edge right by gap·index, and a lane with more steps
    //    would drift out of alignment. Chips separate visually via their 1px
    //    borders instead (same trick grid-mode uses).
    //  • EQUAL TOTALS → EQUAL WIDTH — the last edge is round(BASE·Σfactor), a
    //    function of the total alone, so two lanes whose steps sum to the same
    //    numeric total are exactly the same width. Cumulative rounding (diffing
    //    successive rounded edges) keeps Σwidths == total with no drift, and no
    //    per-step min-width floor (which would inflate many-tiny-step lanes).
    function laneTimelineLayout(steps, skip) {
      const n = steps.length;
      if (n === 0) return { widths: [], gap: 0, total: 0 };
      const widths = new Array(n);
      let cum = 0, prevEdge = 0;
      for (let i = 0; i < n; i++) {
        const f = (skip && skip(steps[i])) ? 0 : Math.max(0, stepLengthFactor(steps[i]));
        cum += f;
        const edge = Math.round(_laneViewBasePx() * cum); // proportional boundary
        widths[i] = edge - prevEdge;
        prevEdge = edge;
      }
      return { widths, gap: 0, total: prevEdge };
    }

    // Render a semitone count as a traditional chromatic interval name
    // (P1, m2, M2, m3, M3, P4, TT, P5, m6, M6, m7, M7, P8 …) with a
    // direction sign so descending vs. ascending is unambiguous on the
    // visual bar. Compound intervals (>12 semitones) extend the
    // 9th/10th/… naming up through P15 (two octaves), and anything
    // bigger falls back to "Noct + base" (e.g. "3oct+M3") so it stays
    // readable instead of overflowing.
    const _SEMI_NAMES_SIMPLE   = ['P1','m2','M2','m3','M3','P4','TT','P5','m6','M6','m7','M7'];
    const _SEMI_NAMES_COMPOUND = ['P8','m9','M9','m10','M10','P11','TT','P12','m13','M13','m14','M14'];
    function semitoneIntervalName(semis) {
      if (semis === 0) return 'P1';
      const sign = semis > 0 ? '+' : '-';
      const n = Math.abs(semis);
      if (n <= 11) return sign + _SEMI_NAMES_SIMPLE[n];
      if (n <= 23) return sign + _SEMI_NAMES_COMPOUND[n - 12];
      if (n === 24) return sign + 'P15';
      const oct = Math.floor(n / 12);
      const rem = n % 12;
      const base = rem === 0 ? 'P8' : _SEMI_NAMES_SIMPLE[rem];
      return sign + oct + 'oct' + (rem === 0 ? '' : '+' + base);
    }

    // Pick the "headline" frequency for a step so we can compute an
    // interval to the next step. Chord steps use the lowest voice
    // (closest to a root); subsequences walk in to the first audible
    // subStep; rests have no pitch.
    function primaryStepFreq(step) {
      if (!step) return null;
      if (step.isSub && Array.isArray(step.subSteps)) {
        for (const s of step.subSteps) {
          const f = primaryStepFreq(s);
          if (f != null) return f;
        }
        return null;
      }
      if (Array.isArray(step.chord) && step.chord.length > 0) {
        let lo = Infinity;
        step.chord.forEach(n => {
          if (n && Number.isFinite(n.freq) && n.freq < lo) lo = n.freq;
        });
        return Number.isFinite(lo) ? lo : null;
      }
      return Number.isFinite(step.freq) ? step.freq : null;
    }

    // Draw a small "+N / -N" semitone-gap indicator under each pair of
    // adjacent chips that share a row. Runs after renderSequence has put
    // chips in the DOM so we can read getBoundingClientRect for layout.
    // Skips pairs where either side is a rest (no pitch to subtract).
    function renderIntervalBars(display) {
      // Clear stale markers from the previous render.
      display.querySelectorAll('.row-interval').forEach(el => el.remove());
      // Filter out pendingChord preview chips (.chord-pending) — those
      // sit after the real sequence chips in the DOM but aren't part of
      // `sequence`, so any interval drawn between them would be bogus.
      const chips = Array.from(display.querySelectorAll('.seq-step:not(.chord-pending):not(.cont-segment)'));
      if (chips.length < 2) return;
      const dispRect = display.getBoundingClientRect();
      const ROW_TOL = 4; // px slop when deciding if two chips share a row
      const limit = Math.min(chips.length, sequence.length) - 1;
      for (let i = 0; i < limit; i++) {
        const a = chips[i], b = chips[i + 1];
        if (!a || !b) continue;
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        // Different rows → no bar (the interval would arc visually
        // across the row break and confuse more than it informs).
        if (Math.abs(aRect.top - bRect.top) > ROW_TOL) continue;
        const fA = primaryStepFreq(sequence[i]);
        const fB = primaryStepFreq(sequence[i + 1]);
        if (fA == null || fB == null) continue;
        const semis = Math.round(12 * Math.log2(fB / fA));
        const label = semitoneIntervalName(semis);
        const left = (aRect.right - dispRect.left) + display.scrollLeft;
        const right = (bRect.left - dispRect.left) + display.scrollLeft;
        const top = (aRect.bottom - dispRect.top) + display.scrollTop;
        const bar = document.createElement('div');
        bar.className = 'row-interval';
        bar.innerHTML = `<span>${label}</span>`;
        bar.style.left = left + 'px';
        bar.style.top = top + 'px';
        // When chips touch (column-gap: 0) the marker has zero geometric
        // width — give it a min so the label and connector line are
        // visible spanning the chip edge.
        const w = Math.max(20, right - left);
        bar.style.width = w + 'px';
        // If the chips are touching, center the marker on the boundary
        // by shifting half its width to the left.
        if (right - left < 20) bar.style.marginLeft = -(w / 2) + 'px';
        display.appendChild(bar);
      }
    }

    // Lane-step drag mode: 'reorder' (drag chips to rearrange — the default) or
    // 'resize' (drag chips to change length). Toggled by #lane-drag-mode-btn.
    // The two gestures conflict if both are live, so only ONE is bound per chip.
    let _laneDragMode = (() => {
      try { return localStorage.getItem('lane-drag-mode') === 'resize' ? 'resize' : 'reorder'; }
      catch (e) { return 'reorder'; }
    })();
    function setLaneDragMode(mode) {
      _laneDragMode = (mode === 'resize') ? 'resize' : 'reorder';
      try { localStorage.setItem('lane-drag-mode', _laneDragMode); } catch (e) {}
      const btn = document.getElementById('lane-drag-mode-btn');
      if (btn) {
        const resize = _laneDragMode === 'resize';
        btn.textContent = resize ? '⇥ Resize' : '↔ Reorder';
        btn.classList.toggle('active', resize);
      }
      try { renderSequence(); } catch (e) {}
    }
    // ---- Resize settings (persisted) ----
    // _resizeIncr32 = snap increment in 1/32-units (= grid cells): 8=1/4, 4=1/8,
    // 2=1/16, 1=1/32. _resizeBothEdges = allow dragging the LEFT edge too.
    // _resizeKeepTotal = the adjacent step absorbs the change so the sequence's
    // overall length stays constant (else only the dragged step changes and the
    // sequence reflows). All settable from the lane ☰ menu.
    let _resizeIncr32 = (() => { try { const v = parseInt(localStorage.getItem('resize-incr32'), 10); return [1, 2, 4, 8].includes(v) ? v : 2; } catch (e) { return 2; } })();
    let _resizeBothEdges = (() => { try { return localStorage.getItem('resize-both-edges') === '1'; } catch (e) { return false; } })();
    let _resizeKeepTotal = (() => { try { return localStorage.getItem('resize-keep-total') === '1'; } catch (e) { return false; } })();
    function _setResizeIncr32(n) { _resizeIncr32 = [1, 2, 4, 8].includes(n) ? n : 2; try { localStorage.setItem('resize-incr32', String(_resizeIncr32)); } catch (e) {} }
    function _setResizeBothEdges(b) { _resizeBothEdges = !!b; try { localStorage.setItem('resize-both-edges', b ? '1' : '0'); } catch (e) {} try { renderSequence(); } catch (e) {} }
    function _setResizeKeepTotal(b) { _resizeKeepTotal = !!b; try { localStorage.setItem('resize-keep-total', b ? '1' : '0'); } catch (e) {} }
    // Step length in 1/32-units (= bar-grid cells). _setStepLen32 writes a length
    // back, keeping the step's subdivision when the length is a whole multiple of
    // it (else falling to 1/32 so duration stays integer). _fmtLen32 renders a
    // readable note value for the hover readout.
    const _stepLen32 = (s) => Math.max(1, Math.round(stepLengthFactor(s) * _BAR_SUBCELLS));
    function _setStepLen32(s, n) {
      n = Math.max(1, Math.round(n));
      const unit = ((s.subdivision != null ? s.subdivision : stepSubdivision) * 8);
      if (unit > 0 && (n % unit) === 0) { s.duration = n / unit; }
      else { s.subdivision = 0.125; s.duration = n; }
    }
    function _mkRestStep(n) { return { freq: null, label: '—', cellIndex: null, duration: Math.max(1, Math.round(n)), subdivision: 0.125 }; }
    function _fmtLen32(n) {
      const M = { 1: '1/32', 2: '1/16', 3: '1/16.', 4: '1/8', 6: '1/8.', 8: '1/4', 12: '1/4.', 16: '1/2', 24: '1/2.', 32: '1 bar' };
      if (M[n]) return M[n];
      if (n % 32 === 0) return (n / 32) + ' bars';
      return n + '/32';
    }
    function _resizeReadoutEl() {
      let el = document.getElementById('_resize-readout');
      if (!el) { el = document.createElement('div'); el.id = '_resize-readout'; el.className = 'resize-readout'; document.body.appendChild(el); }
      return el;
    }
    // Apply a resized length to `step` from the given edge. Right edge changes the
    // boundary with the NEXT step; left edge the boundary with the PREVIOUS step.
    // Keep-total (right edge) makes the next step absorb the change; left edge is
    // inherently length-preserving (the previous step or a leading rest absorbs).
    function _applyResize(step, edge, newLen) {
      const i = sequence.indexOf(step); if (i < 0) return;
      const incr = _resizeIncr32;
      const cur = _stepLen32(step);
      newLen = Math.max(incr, newLen);
      if (edge === 'right') {
        let d = newLen - cur;
        const next = sequence[i + 1];
        if (_resizeKeepTotal && next && !next.isSub) {
          const nl = _stepLen32(next);
          if (nl - d < incr) d = nl - incr;          // keep next ≥ one increment
          _setStepLen32(step, cur + d);
          _setStepLen32(next, nl - d);
        } else {
          _setStepLen32(step, newLen);                // sequence reflows
        }
      } else {
        let d = cur - newLen;                          // >0 shrink from front, <0 grow
        const prev = sequence[i - 1];
        if (prev && !prev.isSub) {
          const pl = _stepLen32(prev);
          if (pl + d < incr) d = incr - pl;            // keep prev ≥ one increment
          _setStepLen32(step, cur - d);
          _setStepLen32(prev, pl + d);
        } else if (d > 0) {
          _setStepLen32(step, newLen);                 // no prev: a leading rest absorbs
          sequence.splice(i, 0, _mkRestStep(d));
        }
      }
    }
    // Begin a handle-driven resize for `edge` ('right'|'left'). Pointer-captured
    // (so the strip can't scroll), snaps to _resizeIncr32, shows a live size
    // readout near the cursor, and commits with one undo entry on release.
    function _startStepResize(chip, step, edge, e, handle) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const host = chip.closest('.lane-chips');
      const cellPx = host ? Math.max(2, host.clientWidth / _BAR_SUBCELLS) : 12;
      const startX = e.clientX;
      const startLen = _stepLen32(step);
      const incr = _resizeIncr32;
      const snap = (v) => Math.max(incr, Math.round(v / incr) * incr);
      const _clampSpan = (v) => Math.max(1, Math.min(_BAR_SUBCELLS, v));
      let newLen = startLen;
      chip.classList.add('resizing');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      // Adjacent step that compensates when "keeps length" is on — found so it
      // can resize LIVE alongside the dragged chip (right → next, left → prev).
      let nbChip = null, nbStartLen = 0;
      if (_resizeKeepTotal) {
        const myIdx = sequence.indexOf(step);
        const nIdx = (edge === 'right') ? myIdx + 1 : myIdx - 1;
        const nStep = sequence[nIdx];
        if (nStep && !nStep.isSub) {
          const heads = host ? Array.from(host.querySelectorAll('.seq-step:not(.cont-segment):not(.chord-pending)')) : [];
          nbChip = heads[nIdx] || null;
          nbStartLen = _stepLen32(nStep);
        }
      }
      const readout = _resizeReadoutEl();
      const showReadout = (ev) => {
        readout.textContent = _fmtLen32(newLen) + (nbChip ? '  ·  ⇄ ' + _fmtLen32(Math.max(incr, nbStartLen - (newLen - startLen))) : '');
        readout.style.left = (ev.clientX + 12) + 'px';
        readout.style.top  = (ev.clientY - 30) + 'px';
        readout.classList.add('show');
      };
      const onMove = (ev) => {
        const dCells = Math.round((ev.clientX - startX) / cellPx);
        newLen = snap(edge === 'right' ? startLen + dCells : startLen - dCells);
        // Clamp so a compensating neighbor never shrinks below one increment
        // (mirrors _applyResize), keeping the live preview and the commit equal.
        if (nbChip) {
          const d = (edge === 'right') ? (newLen - startLen) : (startLen - newLen);
          const maxD = nbStartLen - incr;          // neighbor can give up at most this much
          if (d > maxD) newLen = (edge === 'right') ? (startLen + maxD) : (startLen - maxD);
        }
        if (edge === 'right' || nbChip) chip.style.gridColumn = 'span ' + _clampSpan(newLen);
        if (nbChip) {
          const d = (edge === 'right') ? (newLen - startLen) : (startLen - newLen);
          // Right: next shrinks by d. Left: prev GROWS by d, which shoves the
          // dragged chip rightward (a correct left-edge preview).
          const nl = (edge === 'right') ? (nbStartLen - d) : (nbStartLen + d);
          nbChip.style.gridColumn = 'span ' + _clampSpan(Math.max(incr, nl));
        }
        showReadout(ev);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        chip.classList.remove('resizing');
        readout.classList.remove('show');
        // Swallow the click that follows the handle release so it doesn't select.
        const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
        chip.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => { try { chip.removeEventListener('click', swallow, true); } catch (_) {} }, 60);
        if (newLen !== startLen) {
          snapshotForUndo('Resize step');
          _applyResize(step, edge, newLen);
          renderSequence();
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (_) {}
          const sv = document.getElementById('save-btn'); if (sv) sv.disabled = sequence.length === 0;
        } else {
          renderSequence();
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
      showReadout(e);
    }
    // Resize mode: give a chip a right-edge handle (and a left-edge handle when
    // _resizeBothEdges). Tapping the chip BODY still selects the step.
    function _attachStepResize(chip, step) {
      chip.classList.add('resize-target');
      const addHandle = (cls, edge) => {
        const h = document.createElement('span');
        h.className = 'seq-resize-handle ' + cls;
        h.addEventListener('pointerdown', (e) => _startStepResize(chip, step, edge, e, h));
        chip.appendChild(h);
      };
      addHandle('seq-resize-r', 'right');
      if (_resizeBothEdges) addHandle('seq-resize-l', 'left');
    }

    function renderSequence(activeIndex = -1) {
      // Subsequence extirpation — normalize any isSub step in the active
      // sequence into individual steps. Done here (the funnel every edit calls)
      // so the direct-to-sequence creators (grid Run mode, multi-select Wrap,
      // Consolidate, etc.) all collapse to individual steps without editing each
      // site. GUARDED to STOPPED only: the scheduler reads the live lane.steps
      // array by reference, so mutating it mid-playback would desync the stream
      // (the kept subStack fallback plays any transient isSub correctly anyway).
      if (typeof sequenceTimer !== 'undefined' && sequenceTimer === null
          && Array.isArray(sequence) && sequence.some(s => s && s.isSub)) {
        const flat = _flattenStepList(sequence);
        sequence.length = 0;
        Array.prototype.push.apply(sequence, flat);
      }
      // Keep the add-lane-row's lane-menu button showing the active lane's name.
      try {
        const lmb = document.getElementById('lane-menu-btn');
        if (lmb && typeof lanes !== 'undefined' && lanes[activeLaneIdx]) {
          lmb.textContent = '☰ ' + lanes[activeLaneIdx].name;
        }
      } catch (e) {}
      // In Poly, ensure the active lane's `steps` always points at the
      // current `sequence` array. Anything that did `sequence = [new array]`
      // (Clear, Reverse, Shuffle, Random, Seed, etc.) would otherwise
      // leave the lane referencing the old populated array — switching
      // lanes after such an op would silently restore the pre-mutation
      // content.
      if (polyMode && activeLaneIdx >= 0 && activeLaneIdx < lanes.length) {
        lanes[activeLaneIdx].steps = sequence;
      }
      // Keep the saved-actions bar in sync on every render so it reliably
      // hides when no saved sequence is selected (activeSeqIndex === null),
      // even on the deselect paths that don't re-render the saved-bank list.
      try { if (typeof refreshSavedActionsBar === 'function') refreshSavedActionsBar(); } catch (e) {}
      // The chip-highlight caches hold direct DOM refs that this
      // re-render is about to replace. Clear them so the next
      // setActiveChipForLane / setActiveSequenceChip looks up fresh
      // chips instead of holding onto detached ones.
      _activeChipMono = null;
      _activeChipsByLane.clear();
      clampSelectionToSequence();
      // Sweep orphan touch-drag chip clones — bindStepDragTouch appends a
      // position:fixed clone to <body> while dragging, and on a few iOS
      // event-flow paths the cleanup didn't fire (manifested as a chip
      // floating across rows after Modulate / context-menu actions).
      // Cleaning here guarantees a clean slate before re-render.
      document.querySelectorAll('body > .seq-step').forEach(el => el.remove());
      const display = document.getElementById('sequence-display');
      // Bar grid: one 4/4 bar = one whole note = exactly _laneViewBasePx() px in
      // the proportional timeline. Expose it so every .lane-chips strip can draw
      // faint bar lines via a scrolling repeating-gradient (see CSS). Updates
      // here so it tracks the lane-view zoom (setLaneViewScale re-renders).
      if (display) display.style.setProperty('--lane-bar-px', _laneViewBasePx() + 'px');

      // Grid layout: rows × cols input is always-on now (no "Off"), so
      // the grid-mode CSS class is on whenever cols ≥ 1.
      //
      // Sub-cell model: every chip's span is sized in fixed musical
      // units (one sub-cell = 1/32, so a 1/8 chip is always 4 sub-cells
      // and a 1/1 chip is always 32). The Grid (cols) setting controls
      // the row's musical duration: each "natural" cell = 1/8 = 4
      // sub-cells, so subCols = cols × 4. With cols=8 a row holds one
      // full measure (32 sub-cells); with cols=4 a row holds half a
      // measure (16 sub-cells), making the same 1/8 chip look twice as
      // wide relative to its row. SPAN_PER_MEASURE stays fixed so chip
      // widths in absolute musical units never change with cols.
      const cols = effectiveGridCols();
      const SUBCELL_MULT = 4;
      const SPAN_PER_MEASURE = 32;
      const subCols = cols * SUBCELL_MULT;

      // chipHost is where the active sequence's chips render — the
      // sequence-display always renders the lane rows; the active
      // lane's chip strip is the chip host for the workspace's
      // chip-level operations below.
      let chipHost = display;

      // Preserve each lane strip's horizontal scroll across this rebuild so a
      // user who side-scrolled a lane to edit a far step doesn't get yanked
      // back to step 0 every time the display re-renders. Captured by document
      // order (collapsed lanes route to the menubar strip and are excluded from
      // both capture and restore, so indices stay aligned) and re-applied
      // (clamped) once the new strips exist. Skipped for the active lane when
      // an append/active-index scroll-into-view is about to take over below.
      const _prevLaneScroll = [];
      display.querySelectorAll('.lane-chips').forEach((s) => _prevLaneScroll.push(s.scrollLeft));
      const _restorePrevLaneScroll = () => {
        if (!_prevLaneScroll.length) return;
        display.querySelectorAll('.lane-chips').forEach((s, i) => {
          const v = _prevLaneScroll[i];
          if (!v) return;
          const max = s.scrollWidth - s.clientWidth;
          s.scrollLeft = max > 0 ? Math.min(v, max) : 0;
        });
      };

      {
        display.classList.add('polymode');
        display.classList.remove('grid-mode');
        display.style.removeProperty('--grid-cols');
        // Park the lane-expander back into its stash BEFORE wiping the
        // display. Otherwise display.innerHTML = '' orphans the
        // expander node — getElementById would no longer find it on
        // the next _placeLaneExpander call (orphaned nodes are
        // unreachable via document queries), and the grid + voice
        // pills would silently drop out. Stashing first preserves
        // the reference so _placeLaneExpander can re-insert it.
        const stash0 = document.getElementById('lane-expander-stash');
        const exp0 = document.getElementById('lane-expander');
        if (stash0 && exp0 && exp0.parentNode !== stash0) {
          stash0.appendChild(exp0);
        }
        // The step-edit-row lives below the active lane row (inside the
        // display) between renders — rescue it into the stash too before
        // the wipe, or display.innerHTML = '' would orphan/destroy it.
        const editRow0 = document.getElementById('step-edit-row');
        if (stash0 && editRow0 && editRow0.parentNode !== stash0) {
          stash0.appendChild(editRow0);
        }
        display.innerHTML = '';

        let activeLaneChipsEl = null;
        // Collapsed lanes get parked into a single strip up in the
        // menubar so the editor area below only carries expanded
        // lanes — minimised lanes shouldn't burn vertical space when
        // there's empty menubar room above. The strip is created
        // lazily on the first collapsed lane and the slot is hidden
        // when no lane is collapsed.
        const menubarLanes = document.getElementById('menubar-lanes');
        if (menubarLanes) {
          menubarLanes.innerHTML = '';
          menubarLanes.hidden = true;
        }
        let collapsedStrip = null;
        lanes.forEach((lane, laneIdx) => {
          const isActiveLane = laneIdx === activeLaneIdx;
          const row = document.createElement('div');
          row.className = 'lane-row'
            + (isActiveLane ? ' active' : '')
            + (lane.muted   ? ' muted'  : '')
            + (lane.solo    ? ' soloed' : '')
            + (lane.collapsed ? ' collapsed' : '')
            // Drifting OR locked → keep the orange styling so the user
            // sees the lane has a drift offset. Reset clears both.
            + (lane.driftMs > 0 || lane.driftLocked ? ' drifting' : '')
            // Steps don't all share one Tone → flag so mixed-tone lanes read
            // differently from uniform-tone ones (pitch differences ignored).
            + (_laneToneMixed(lane) ? ' lane-tone-mixed' : '');

          // Lane-controls removed — a lane row is now just its steps viewer.
          // The active lane's name + menu live in the add-lane-row's ☰ Lane
          // button (which carries Show/Hide grid + Collapse/Expand); lane
          // switching is a click on a non-active lane's row (handler below).

          const chipsEl = document.createElement('div');
          chipsEl.className = 'lane-chips';
          // Single-row scrolling timeline (no grid-mode wrap): chips fill
          // logically to the right at proportional widths; the strip scrolls
          // horizontally and auto-follows the playhead. See CLAUDE.md §1 carve-out.
          row.appendChild(chipsEl);

          if (isActiveLane) {
            activeLaneChipsEl = chipsEl;
          } else {
            // Non-active lanes render simple read-only preview chips.
            // Sidescroll is handled by .lane-chips's overflow-x.
            const steps = lane.steps || [];
            if (steps.length === 0) {
              chipsEl.innerHTML = '<span class="seq-empty">Empty</span>';
            } else {
              // Pixel-perfect proportional widths: Σ widths + gaps depends only
              // on the lane's total step length, so equal totals → equal width.
              const _pvLayout = laneTimelineLayout(steps);
              chipsEl.style.gap = _pvLayout.gap + 'px';
              let _previewCol = 1;
              steps.forEach((step, stepIdx) => {
                const chip = document.createElement('div');
                const isSub  = !!step.isSub;
                const isCh   = Array.isArray(step.chord);
                const isRest = !isSub && !isCh && step.freq == null;
                chip.className = 'seq-step preview'
                  + (isSub  ? ' subseq' : '')
                  + (isCh   ? ' chord'  : '')
                  + (isRest ? ' rest'   : '');
                let label = '';
                if (isSub)       label = step._seqClip ? ('▤ ' + (step._seqName || 'Seq')) : '▤';
                else if (isCh)   label = step.chord.map(n => n.label).join('·');
                else if (isRest) label = '—';
                else             label = step.label || '';
                chip.textContent = label;
                // Bar grid: span sub-cells; split across rows at bar lines.
                const _pvPlan = _barGridPlan(_barGridSpan(step), _previewCol);
                _previewCol = _pvPlan.newCol;
                chip.style.gridColumn = 'span ' + _pvPlan.firstSpan;
                if (_pvPlan.continuations.length > 0) chip.classList.add('cont-start');
                {
                  const pc = stepColorPitchClass(step);
                  if (pc != null && chipPalette[pc]) {
                    const c = chipPalette[pc];
                    chip.style.borderColor = c;
                    chip.style.background = tintHsl(c, 0.5);
                    chip.style.color = c;
                  }
                }
                // Suppress browser context menu / text-selection
                // callout on preview chips so a long-press doesn't
                // bring up the native menu. The step menu is now
                // accessed via the Edit button, not via long-press.
                chip.addEventListener('contextmenu', (e) => e.preventDefault());
                chip.addEventListener('selectstart',  (e) => e.preventDefault());
                chipsEl.appendChild(chip);
                // Visual-only continuation segments for steps crossing bars.
                _pvPlan.continuations.forEach((segSpan, idx) => {
                  const cont = chip.cloneNode(true);
                  cont.classList.remove('cont-start', 'active', 'selected');
                  cont.classList.add(idx === _pvPlan.continuations.length - 1 ? 'cont-end' : 'cont-mid', 'cont-segment');
                  cont.style.gridColumn = 'span ' + segSpan;
                  cont.textContent = '';
                  chipsEl.appendChild(cont);
                });
              });
              _addLaneBars(chipsEl, _pvLayout.total);
            }
          }

          row.addEventListener('click', (e) => {
            if (e.target.closest('#lane-expander')) return;
            if (isActiveLane) {
              // Active lane: its chips are interactive (select / resize /
              // reorder) and the collapse toggle has its own handler — clicking
              // the row background does nothing.
              if (e.target.closest('.seq-step')) return;
              return;
            }
            // Non-active lane: the status button is gone, so clicking ANYWHERE
            // on the row — including its read-only preview chips — focuses the
            // lane (the collapse toggle stops propagation, so it only collapses).
            _laneExpanderOpen = true;
            activateLane(laneIdx);
          });

          if (lane.collapsed) {
            // A collapsed lane hides its chips, so (with the controls gone) it
            // would be an empty box — give it a small name label so it stays
            // identifiable + clickable in the menubar strip.
            const mini = document.createElement('span');
            mini.className = 'lane-mini-label';
            mini.textContent = lane.name;
            row.insertBefore(mini, row.firstChild);
            // Collapsed lanes route up to the menubar strip. One
            // strip holds every collapsed lane; expanded lanes still
            // render below in the editor in their original order.
            if (!collapsedStrip && menubarLanes) {
              collapsedStrip = document.createElement('div');
              collapsedStrip.className = 'lane-row-collapsed-strip';
              menubarLanes.appendChild(collapsedStrip);
              menubarLanes.hidden = false;
            }
            (collapsedStrip || display).appendChild(row);
          } else {
            // Expanded lane: append as its own row in the editor.
            display.appendChild(row);
          }
        });

        chipHost = activeLaneChipsEl || display;
        _placeLaneExpander();
        _placeStepEditRow();
      }

      // Pixel-perfect proportional widths for the active lane (same invariant as
      // the preview lanes above): Σ widths + gap·(n−1) == round(BASE · Σ factor),
      // independent of step count, so equal totals render to equal width. Skip
      // the transient wrap-edit stash step (it isn't rendered as a chip).
      const _activeLayout = laneTimelineLayout(sequence, (s) => s && s._wrapEditing);
      if (chipHost && chipHost.classList && chipHost.classList.contains('lane-chips')) {
        chipHost.style.gap = _activeLayout.gap + 'px';
      }

      const isEmpty = sequence.length === 0 && pendingChord.length === 0;
      if (isEmpty) {
        chipHost.innerHTML = '<span class="seq-empty">Click notes or REST to build a sequence…</span>';
        const revBtn = document.getElementById('reverse-btn');
        if (revBtn) revBtn.disabled = true;
        const shuffBtn = document.getElementById('shuffle-btn');
        if (shuffBtn) shuffBtn.disabled = true;
        const rotateBtn = document.getElementById('rotate-btn');
        if (rotateBtn) rotateBtn.disabled = true;
        const shiftUpBtn = document.getElementById('shift-up-btn');
        if (shiftUpBtn) shiftUpBtn.disabled = true;
        const shiftDownBtn = document.getElementById('shift-down-btn');
        if (shiftDownBtn) shiftDownBtn.disabled = true;
        const repeatBtn = document.getElementById('repeat-btn');
        if (repeatBtn) repeatBtn.disabled = true;
        // Active lane is empty, but the other lanes' preview strips were just
        // rebuilt — restore their scroll so they don't snap to 0.
        _restorePrevLaneScroll();
        // Keep the always-on cursor drawn on the other lanes (no scroll —
        // idle redraw leaves any manual side-scroll untouched).
        if (sequenceTimer === null && typeof _positionCursorsAtTick === 'function') {
          _positionCursorsAtTick(_cursorTick, false);
        }
        return;
      }

      // Track the next chip's column position within the current grid
      // row so we can split a step that would overflow into multiple
      // continuation segments (one per row it spans). Without this,
      // long steps clamped to span = subCols and visually lied about
      // their actual duration. Reset on every renderSequence call.
      let _wrapCurrentCol = 1;
      // Triplet-group cursor: counts consecutive off-grid chips so every 3rd
      // starts a new bracketed group (,--3--,). Reset by any non-triplet chip.
      let _tripletRun = 0;
      const _planChipPlacement = (naturalSpan) => {
        if (!(cols > 0) || !(subCols > 0)) {
          return { firstSpan: naturalSpan, continuations: [], newCol: _wrapCurrentCol };
        }
        const capacity = subCols - (_wrapCurrentCol - 1);
        if (naturalSpan <= capacity) {
          let newCol = _wrapCurrentCol + naturalSpan;
          if (newCol > subCols) newCol = 1;
          return { firstSpan: naturalSpan, continuations: [], newCol };
        }
        const firstSpan = capacity;
        const continuations = [];
        let remaining = naturalSpan - capacity;
        while (remaining > 0) {
          const seg = Math.min(subCols, remaining);
          continuations.push(seg);
          remaining -= seg;
        }
        const lastSeg = continuations[continuations.length - 1];
        let newCol = (lastSeg === subCols) ? 1 : (lastSeg + 1);
        return { firstSpan, continuations, newCol };
      };
      // ---- Pre-compute key groups for visual containers (Round 1 / Phase B) ----
      // Walk the sequence once to find runs of steps with matching
      // keyContext, sum their natural spans, and keep a lookup so the
      // chip-creation loop below can wrap each run inside a real
      // <div.key-group-container> with the correct grid-column span.
      // The container uses CSS subgrid so chips inside it still align
      // to the outer chip-strip grid lines — but the container itself
      // can carry the user-visible "thin container" border around the
      // group. Also self-heals out-of-key keyContexts (the same check
      // the per-chip render did before) so an edited step that
      // drifted out of its key ejects to its own (no-group) slot.
      const _keyGroupSpansByStart = new Map();   // startIdx → totalSpan
      const _stepGroupStartByIdx  = new Map();   // stepIdx  → startIdx of containing group
      {
        let _curStart = -1;
        let _curKc    = null;
        let _curTotal = 0;
        const _flush = () => {
          if (_curStart >= 0 && _curTotal > 0 && _curKc) {
            _keyGroupSpansByStart.set(_curStart, { kc: _curKc, total: _curTotal });
          }
        };
        for (let _gi = 0; _gi < sequence.length; _gi++) {
          const _gs = sequence[_gi];
          if (!_gs || _gs._wrapEditing) continue;
          // Out-of-key edit ejection — same self-heal the previous
          // per-chip path did, hoisted up so the group-span sum
          // matches what we'll actually render.
          if (_gs.keyContext && typeof _stepIsAllInKey === 'function') {
            try { if (!_stepIsAllInKey(_gs, _gs.keyContext)) _gs.keyContext = null; }
            catch (e) {}
          }
          const _kc = _gs.keyContext || null;
          const _span = Math.max(1, Math.round(stepLengthFactor(_gs) * SPAN_PER_MEASURE));
          if (_kc && _curStart >= 0 && _keyContextsMatch(_curKc, _kc)) {
            _curTotal += _span;
            _stepGroupStartByIdx.set(_gi, _curStart);
          } else {
            _flush();
            if (_kc) {
              _curStart = _gi;
              _curKc    = _kc;
              _curTotal = _span;
              _stepGroupStartByIdx.set(_gi, _curStart);
            } else {
              _curStart = -1;
              _curKc    = null;
              _curTotal = 0;
            }
          }
        }
        _flush();
      }
      // Tracks the live container element per group startIdx so
      // continuation chips + every step in the run all land inside
      // the same wrapper.
      const _keyGroupContainerByStart = new Map();

      sequence.forEach((step, i) => {
        // Wrap-editor stash: showWrapEditor temporarily parks the
        // wrapTemplate at the end of `sequence` so it can drive the
        // existing showStepEditor flow without writing a parallel
        // chord-editor for wraps. Skip the chip render so the stash
        // never visibly appears in the sequence display.
        if (step && step._wrapEditing) return;
        if (insertionPoint === i) chipHost.appendChild(makeInsertCursor());
        const chip = document.createElement('div');
        const durSuffix = (step.duration && step.duration > 1) ? `×${step.duration}` : '';
        const bendDir = step.bend && Number.isFinite(step.bend.semitones) && step.bend.semitones !== 0
          ? (step.bend.semitones > 0 ? 'bend-up' : 'bend-down')
          : '';
        // In step mode, rests are rendered as dashed empty-slot placeholders
        // that the user can click to drop the armed note into.
        const treatAsEmptySlot = stepMode && isRestStep(step);
        if (step.isSub) {
          const count = (step.subSteps || []).length;
          chip.className = 'seq-step subseq' + (i === activeIndex ? ' active' : '');
          // Preview the subSteps' note labels so the user can read the
          // subsequence at a glance without opening the editor. Chord
          // subSteps collapse to "C4·E4·G4"; rests show as "—". Cap at the
          // first few entries to keep the chip from blowing out wide chips.
          const SUB_PREVIEW_MAX = 6;
          const labels = (step.subSteps || []).map(s => {
            if (!s) return '';
            if (Array.isArray(s.chord)) return s.chord.map(n => n.label).join('·');
            if (s.isSub) return '▤';
            if (s.freq == null) return '—';
            return s.label || '';
          }).filter(Boolean);
          const preview = labels.slice(0, SUB_PREVIEW_MAX).join(' ')
                        + (labels.length > SUB_PREVIEW_MAX ? ' …' : '');
          chip.textContent = step._seqClip ? ('▤ ' + (step._seqName || 'Seq'))
                           : (count > 0 ? `▤  ${preview}` : '▤');
        } else if (step.chord) {
          chip.className = 'seq-step chord' + (i === activeIndex ? ' active' : '') + (bendDir ? ' ' + bendDir : '');
          chip.textContent = step.chord.map(n => n.label).join('·') + (durSuffix ? ' ' + durSuffix : '');
        } else if (treatAsEmptySlot) {
          chip.className = 'seq-step empty-slot' + (i === activeIndex ? ' active' : '');
          chip.textContent = '·';
        } else {
          chip.className = 'seq-step' + (step.freq === null ? ' rest' : '') + (i === activeIndex ? ' active' : '') + (bendDir ? ' ' + bendDir : '');
          const main = step.freq !== null
            ? `${step.label}${step.sound && step.sound !== 'sine' ? '\n' + step.sound.slice(0,3) : ''}`
            : step.label;
          chip.textContent = durSuffix ? `${main}\n${durSuffix}` : main;
        }
        // In grid mode, span the chip across a fixed number of sub-cells
        // derived from its step-div: a 1/8 chip is always 4 sub-cells, a
        // 1/1 chip is always 32, etc. Cols controls the row's musical
        // duration (subCols sub-cells per row) so changing it rescales
        // how many chips fit per row, while individual chip widths stay
        // proportional to their step-div. Outside grid mode, pin width
        // directly via stepWidthPx.
        // Bar grid: the chip spans a proportional number of sub-cells in its
        // bar/row; a step crossing the bar line splits into continuation
        // segments (rendered below). _wrapCurrentCol tracks the row cursor.
        const _continuationPlan = _barGridPlan(_barGridSpan(step), _wrapCurrentCol);
        _wrapCurrentCol = _continuationPlan.newCol;
        chip.style.width = '';
        chip.style.gridColumn = 'span ' + _continuationPlan.firstSpan;
        if (_continuationPlan.continuations.length > 0) chip.classList.add('cont-start');
        // Triplet marking (32-grid stays; the mark shows the true intent).
        if (_isTripletStep(step)) {
          chip.classList.add('triplet');
          if (_tripletRun % 3 === 0) chip.classList.add('triplet-group-start');
          _tripletRun++;
        } else {
          _tripletRun = 0;
        }
        if (isSelectedStep(step)) chip.classList.add('selected');
        // Variance markers — blinking outline while editing the pool,
        // a small ⟳ glyph (via CSS) for committed variance steps.
        if (_varianceEdit && _varianceEdit.stepRef === step) {
          chip.classList.add('variance-editing');
        } else if (step.variance && Array.isArray(step.variance.notes) && step.variance.notes.length > 1) {
          chip.classList.add('has-variance');
          chip.dataset.varianceMode = step.variance.mode || 'random';
        }
        // Click behaviour: in step mode (and only on non-sub chips) toggle
        // the slot between rest and the armed note; otherwise select the
        // step (so the step controls retarget it) and open its edit menu
        // below the lane. A click no longer auditions the step's audio.
        // The click runs immediately on the FIRST click (event.detail===1)
        // and skips the second click of a double-click pair so the
        // dblclick → duplicate handler can run cleanly without us
        // throwing a duplicate select/deselect into the mix.
        const performSingleClick = (ev) => {
          // While a variance edit is active, clicking the blinking
          // chip itself finalizes the edit and locks in whatever
          // alternates the user added. Clicking other chips falls
          // through to normal selection behavior.
          if (_varianceEdit && _varianceEdit.stepRef === step) {
            finalizeVarianceEdit();
            return;
          }
          if (stepMode && !step.isSub) {
            // Each slot carries the subdivision/duration the size-chip
            // assigned at append time — preserve that when toggling the
            // slot between rest and the armed pitch so the rhythm the
            // user built doesn't reset to the global Step Div on every
            // assignment.
            const slotSub = sequence[i].subdivision;
            const slotDur = sequence[i].duration;
            if (isRestStep(sequence[i])) {
              if (!stepModeArmed) return;
              sequence[i] = {
                ...stepModeArmed,
                params: { ...(stepModeArmed.params || {}) },
                subdivision: slotSub,
                duration: slotDur,
              };
            } else {
              sequence[i] = { freq: null, label: '—', cellIndex: null, duration: slotDur, subdivision: slotSub };
            }
            renderSequence();
            document.getElementById('save-btn').disabled = sequence.length === 0;
            return;
          }
          // Selection IS the edit scope (no "Multi" mode). A plain click/tap
          // TOGGLES this chip's membership; shift-click selects the contiguous
          // range from the primary chip to this one. A click no longer
          // auditions audio — it just selects the step for editing; the
          // Edit / Mix / Groove row that sits below this lane retargets to
          // the selection (via syncStepEditorFromSelection in the toggle
          // helpers) and signals how many steps are in scope.
          const _shiftSel = !!(ev && ev.shiftKey);
          if (_shiftSel && selectedStepRefs.length) {
            const anchor = sequence.indexOf(lastSelectedStep());
            if (anchor >= 0) _selectStepRange(anchor, i); else _toggleSelectedStep(i);
            renderSequence();
            return;
          }
          const _wasSelected = isSelectedStep(step);
          _toggleSelectedStep(i);
          if (_wasSelected) { renderSequence(); return; }
          // Clicking a chord/sub chip captures it as the active wrap
          // form so future cell taps audition that structure transposed,
          // and the Keep button reads the shorthand chord name. Single-
          // note steps fall through — they're not "wrap-shaped" and
          // would lose the existing wrapTemplate if treated as one.
          if (step.isSub || Array.isArray(step.chord)) {
            wrapTemplate = cloneStep(step);
            // This wrap was sourced from a sequence chip, not from the
            // bank — drop the bank highlight so the user can tell at a
            // glance that the live wrap doesn't correspond to a bank
            // entry. They can re-save it with a fresh Wrap commit.
            activeWrapBankId = null;
            _wrapTransposeDisplayStep = null;
            _wrapTonicShift = 0;
            refreshWrapVisuals();
            renderWrapBank();
          }
          // Step-selects-grid-key (Round 1 / Phase C). When the clicked
          // step carries a keyContext, restore that key to the root /
          // scale dropdowns so the grid re-dims around the right
          // pitches. Lets the user step through a multi-key sequence
          // and have the grid follow along instead of staying frozen
          // on whatever key the user picked first. No-op when the step
          // has no keyContext (chromatic, or older saved sequence).
          if (step.keyContext) {
            try { _applyKeyContext(step.keyContext); } catch (e) {}
          }
          renderSequence();
        };
        chip.addEventListener('click', (e) => {
          // event.detail is the click-count: 1 = single, 2 = the second
          // click of a double-click pair. Skipping detail >= 2 keeps the
          // single-click side-effects from running twice on a dblclick.
          if (e.detail >= 2) return;
          performSingleClick(e);
        });
        chip.addEventListener('dblclick', () => {
          duplicateStep(i);
        });
        // Note-coloured chips: tint border + fill from chipPalette by
        // pitch class. Subsequence chips inherit the colour of their
        // first playable child (resolved by stepColorPitchClass). The
        // active-chip skip lets the playback highlight read through
        // without the palette tint masking it.
        let chipBaseColor = null;
        if (i !== activeIndex) {
          const pc = stepColorPitchClass(step);
          if (pc != null && chipPalette[pc]) {
            const c = chipPalette[pc];
            chipBaseColor = c;
            chip.style.borderColor = c;
            chip.style.background = tintHsl(c, 0.5);
            chip.style.color = c;
          } else if (isRestStep(step)) {
            // Rests all share ONE colour (no per-step-div tint) so they read
            // uniformly regardless of length. Low-alpha fill + the border carry
            // the signal without competing with note chips.
            const c = 'hsl(250, 14%, 62%)';
            chip.style.borderColor = c;
            chip.style.background = tintHsl(c, 0.16);
            chip.style.color = c;
            chip.classList.add('rest-sized');
          }
        }
        bindStepLongPress(chip, i);
        // Reorder and resize drags conflict, so bind only ONE per the toggle.
        // Resize mode applies to length-bearing chips (notes / chords / rests);
        // seq-clips, subsequences and step-mode empty slots stay reorder-only.
        if (_laneDragMode === 'resize' && !step._seqClip && !step.isSub && !treatAsEmptySlot) {
          _attachStepResize(chip, step);
        } else {
          bindStepDrag(chip, i);
          bindStepDragTouch(chip, i);
        }
        // Cache the palette tint + step index on the chip so the
        // selected-step pan slider (below the BPM row) can re-tint
        // chips live without rebuilding the whole sequence DOM.
        chip.dataset.stepIdx = String(i);
        if (chipBaseColor) chip.dataset.paletteColor = chipBaseColor;
        // Reflect any saved pan in the chip's background — replaces the
        // old press-and-drag pan; adjustment now happens through the
        // selected-step pan slider.
        if (!step.isSub && !Array.isArray(step.chord) && step.freq !== null) {
          const savedPan = (step.params && Number.isFinite(step.params.pan))
            ? step.params.pan : 0;
          if (savedPan !== 0) applyPanTint(chip, chipBaseColor, savedPan);
        }
        // ---- Visual key grouping (real container) ----
        // Look up the key-group this step belongs to (precomputed
        // above). Each run of same-key steps gets ONE <div.key-group-
        // container> wrapper, created on the first step of the run
        // and reused for the rest. The container is a real CSS Grid
        // subgrid child of the chip strip so chips inside it still
        // align to the outer column lines — but the container itself
        // carries the thin purple border that wraps the whole group.
        const _stepGroupStart = _stepGroupStartByIdx.get(i);
        let _appendTarget = chipHost;
        if (_stepGroupStart != null) {
          let _container = _keyGroupContainerByStart.get(_stepGroupStart);
          if (!_container) {
            const _gInfo = _keyGroupSpansByStart.get(_stepGroupStart);
            _container = document.createElement('div');
            _container.className = 'key-group-container';
            _container.style.gridColumn = 'span ' + (_gInfo && _gInfo.total ? _gInfo.total : 1);
            const _rootName  = (typeof CHROMATIC !== 'undefined' && CHROMATIC[step.keyContext.root]) || '?';
            const _scaleName = (typeof prettyScaleName === 'function')
              ? prettyScaleName(step.keyContext.scale)
              : step.keyContext.scale;
            _container.dataset.keyLabel = `${_rootName} ${_scaleName}`;
            _container.title = `Key: ${_rootName} ${_scaleName}`;
            chipHost.appendChild(_container);
            _keyGroupContainerByStart.set(_stepGroupStart, _container);
          }
          _appendTarget = _container;
        }
        _appendTarget.appendChild(chip);
        // Long steps spill across rows as continuation chips —
        // visually identical to the first segment (same color, same
        // class) but marked .cont-mid / .cont-end so CSS can show
        // dashed seams at the row breaks. Continuation chips have
        // no event handlers; the user still clicks the head chip to
        // interact with the step.
        if (_continuationPlan && _continuationPlan.continuations.length > 0) {
          _continuationPlan.continuations.forEach((segSpan, idx) => {
            const cont = chip.cloneNode(true);
            cont.classList.remove('cont-start', 'active', 'selected', 'variance-editing');
            cont.classList.add(
              (idx === _continuationPlan.continuations.length - 1) ? 'cont-end' : 'cont-mid'
            );
            cont.classList.add('cont-segment');
            cont.style.gridColumn = `span ${segSpan}`;
            cont.textContent = ''; // visual segment only — no repeated label
            cont.querySelectorAll('.seq-resize-handle').forEach(h => h.remove()); // segments aren't resizable
            cont.removeAttribute('id');
            // Continuation chips belong inside the same key-group
            // container as their head chip (if any) so the wrapper
            // sees a continuous run of chips and its subgrid sizing
            // remains correct across row wraps.
            _appendTarget.appendChild(cont);
          });
        }
      });
      if (insertionPoint != null && insertionPoint >= sequence.length) {
        chipHost.appendChild(makeInsertCursor());
      }

      // Restore the pre-render horizontal scroll on every lane strip first, so
      // an edit re-render keeps the user's scroll place. The chord-pending /
      // activeIndex scroll-into-view below can then still override the ACTIVE
      // lane when a note was just appended (the strip should follow the new tail).
      _restorePrevLaneScroll();

      // Show in-progress chord as a dashed pending chip
      // Pending-Wrap preview chip — only shown while Keep is on so the
       // user can see the in-progress chord/sub being captured. With
       // Keep off, the Wrap is template-only (won't land in the
       // sequence) so a preview chip would be misleading.
      if (chordMode && keepMode && pendingChord.length > 0) {
        const chip = document.createElement('div');
        chip.className = 'seq-step chord-pending';
        chip.textContent = pendingChord.map(n => n.label).join('·') + '…';
        chipHost.appendChild(chip);
        chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      // Bar-line overlay for the active lane (preview lanes get theirs above).
      if (chipHost && chipHost.classList && chipHost.classList.contains('lane-chips')) {
        _addLaneBars(chipHost, _activeLayout.total);
      }

      if (activeIndex >= 0) {
        const chips = chipHost.querySelectorAll('.seq-step:not(.chord-pending):not(.cont-segment)');
        chips[activeIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      const revBtn = document.getElementById('reverse-btn');
      if (revBtn) revBtn.disabled = sequence.length < 2;
      const shuffBtn = document.getElementById('shuffle-btn');
      if (shuffBtn) shuffBtn.disabled = sequence.length < 2;
      const rotateBtn = document.getElementById('rotate-btn');
      if (rotateBtn) rotateBtn.disabled = sequence.length < 2;
      const shiftUpBtn = document.getElementById('shift-up-btn');
      if (shiftUpBtn) shiftUpBtn.disabled = sequence.length === 0;
      const shiftDownBtn = document.getElementById('shift-down-btn');
      if (shiftDownBtn) shiftDownBtn.disabled = sequence.length === 0;
      const repeatBtn = document.getElementById('repeat-btn');
      if (repeatBtn) repeatBtn.disabled = sequence.length === 0;
      // Layout-dependent semitone markers between adjacent chips. Run on
      // a microtask so chip widths have settled (esp. in flex/grid mode
      // where stretching is computed after layout).
      requestAnimationFrame(() => renderIntervalBars(display));
      // Keep the always-on playback cursor visible while stopped. Idle redraw
      // only (no scroll) so a manual side-scroll to edit isn't yanked back;
      // Stop / Rewind / Fast-Forward do the centering. During playback the
      // live scheduler owns the cursors, so skip.
      if (sequenceTimer === null && typeof _positionCursorsAtTick === 'function') {
        _positionCursorsAtTick(_cursorTick, false);
      }
      persistWorkspace();
    }

    // Re-position interval markers when the display resizes (window
    // resize, dock toggle, etc.) — chip rects move so the absolute-
    // positioned bars need to follow.
    window.addEventListener('resize', () => {
      const display = document.getElementById('sequence-display');
      if (display) renderIntervalBars(display);
    });

    // null = append; otherwise the next note is spliced at this index.
    // The cursor advances by 1 after each insert so consecutive clicks
    // build a run of notes at the insertion point.
    let insertionPoint = null;

    // Click-selected steps. We track step *references* (not just indices) so
    // selection survives reorderings — reverse/shuffle/splice keep the same
    // step objects, just at different positions. Wholesale replacements
    // (Random, Vivaldi, Condense, sub-edit enter/exit, load saved) drop the
    // refs and selection clears automatically via clampSelectionToSequence.
    // selectedStepRefs[last] is the "primary" / most-recently-clicked step;
    // it drives the editor's displayed Hold/Div values.
    // Vestigial: the "Multi" toggle is retired — selection IS the edit scope now
    // (every click toggles a chip's membership; edits act on all selected). This
    // flag is no longer read for selection behavior; kept only so existing
    // assignments across the codebase don't break.
    let multiSelectMode = false;
    let selectedStepRefs = [];
    // When true, the Pan / Vol / Slip sliders broadcast their value to
    // every playable step in the active lane instead of just the
    // selected chip(s). Toggled by the "All" button next to the Edit
    // button. The edit row picks up the .all-mode CSS so the user
    // sees that subsequent drags will retune the whole lane.
    let _allLaneMode = false;

    // ---- Undo / Redo stacks --------------------------------------------
    // Snapshots the chunks of state that user-mutating actions affect so
    // Cmd/Ctrl+Z can roll back the most recent one and Cmd/Ctrl+Shift+Z
    // can replay it. A new mutation clears redoStack — branching past an
    // undo abandons the redone-future, matching standard editor behavior.
    const UNDO_LIMIT = 60;
    const undoStack = [];
    const redoStack = [];
    function refreshHistoryButtons() {
      const u = document.getElementById('undo-btn');
      const r = document.getElementById('redo-btn');
      if (u) u.disabled = undoStack.length === 0;
      if (r) r.disabled = redoStack.length === 0;
    }
    // Snapshot the Mix-side state (Tracks). Per-track runtime fields
    // (playing, timers, _bus, _itemBuses, etc.) are NOT captured — only
    // the persisted shape (id, name, items, loopMode, solo, eq, pan,
    // stereo). On restore, audio nodes are preserved for tracks whose
    // id survives and disposed for tracks that don't.
    function captureTracksSnapshot() {
      return tracks.map(t => ({
        id: t.id,
        name: t.name,
        items: JSON.parse(JSON.stringify(t.items || [])),
        loopMode: !!t.loopMode,
        solo: !!t.solo,
        eq: { ...(t.eq || { low: 0, mid: 0, high: 0 }) },
        pan: Number.isFinite(t.pan) ? t.pan : 0,
        stereo: t.stereo !== false,
      }));
    }
    function captureSnapshot(label) {
      return {
        label,
        sequence: sequence.map(cloneStep),
        selectedStepRefIdxs: selectedStepRefs.map(r => sequence.indexOf(r)),
        multiSelectMode,
        insertionPoint,
        activeSeqIndex,
        chordMode,
        pendingChord: pendingChord.map(p => ({ ...p })),
        stepMode,
        gridColumns,
        gridRows,
        noteLength,
        stepSubdivision,
        bpm: parseInt(tempoInput?.value, 10) || 120,
        // Mix state. Captured on every snapshot so a Make-side undo
        // doesn't accidentally re-mix the tracks — every undoable
        // action stamps the full state at its mutation point.
        tracks: captureTracksSnapshot(),
      };
    }
    function applySnapshot(snap) {
      stopSequence();
      sequence = snap.sequence.map(cloneStep);
      // Restore selection from the indices recorded at snapshot time. After
      // the sequence array has been replaced, those indices point into the
      // newly-restored array, so we read the refs back out.
      selectedStepRefs = snap.selectedStepRefIdxs
        .map(i => (i >= 0 && i < sequence.length) ? sequence[i] : null)
        .filter(Boolean);
      multiSelectMode = !!snap.multiSelectMode;
      insertionPoint = snap.insertionPoint;
      activeSeqIndex = snap.activeSeqIndex;
      chordMode = !!snap.chordMode;
      pendingChord = (snap.pendingChord || []).map(p => ({ ...p }));
      stepMode = !!snap.stepMode;
      // Grid select-box only carries 1..8; clamp so older snapshots
      // with bigger values don't leave the dropdown showing the
      // default while the runtime state diverges.
      gridColumns = Math.min(8, Math.max(1, (snap.gridColumns | 0) || 8));
      gridRows    = Math.min(8, Math.max(1, (snap.gridRows    | 0) || 1));
      noteLength = snap.noteLength | 0 || 1;
      stepSubdivision = snap.stepSubdivision || 1;

      // Sync the UI controls to the restored state.
      const chordBtn = document.getElementById('chord-btn');
      const stepClu  = document.querySelector('.btn-group--step');
      const stepBtn  = document.getElementById('step-mode-btn');
      const rowsEl   = document.getElementById('grid-rows-input');
      const colsEl   = document.getElementById('grid-cols-input');
      const multiCb  = document.getElementById('multi-select-toggle');
      const noteSel  = document.getElementById('note-length');
      const subSel   = document.getElementById('subdivision-select');
      refreshWrapVisuals();
      clearWrapPendingHighlights();
      if (typeof refreshStepModeBtn === 'function') refreshStepModeBtn();
      else if (stepBtn) stepBtn.classList.toggle('active', stepMode);
      if (rowsEl) rowsEl.value = String(gridRows);
      if (colsEl) colsEl.value = String(gridColumns);
      if (multiCb)  multiCb.checked = multiSelectMode;
      if (noteSel)  noteSel.value = String(noteLength);
      if (subSel)   subSel.value = String(stepSubdivision);
      if (typeof tempoInput  !== 'undefined' && tempoInput)  tempoInput.value  = String(snap.bpm);
      if (typeof tempoSlider !== 'undefined' && tempoSlider) tempoSlider.value = String(snap.bpm);

      syncStepEditorFromSelection();
      renderSequence();
      renderSavedSequences();
      if (Array.isArray(snap.tracks)) applyTracksSnapshot(snap.tracks);
    }
    // Restore tracks from a serialized snapshot. Audio nodes survive
    // when a track's id matches an existing track (so live _bus / pan /
    // EQ nodes don't get rebuilt for an undo that only touched item
    // data). Tracks that have been removed by the snapshot get their
    // audio nodes disposed. Newly-restored tracks get fresh shells —
    // getTrackBus lazily rebuilds the audio chain on next playback.
    function applyTracksSnapshot(snap) {
      // Stop every playing track so its setTimeouts can't fire on
      // stale references after the array is replaced.
      tracks.forEach((_, i) => { try { stopTrack(i); } catch (e) {} });
      const oldById = new Map();
      tracks.forEach(t => { if (t.id != null) oldById.set(t.id, t); });
      const restoredIds = new Set(snap.map(s => s.id));
      // Dispose audio for any track that the snapshot doesn't carry.
      tracks.forEach(t => {
        if (t.id != null && restoredIds.has(t.id)) return;
        try { if (typeof _drainPendingItemDisposes === 'function') _drainPendingItemDisposes(t); } catch (e) {}
        try { t._bus    && t._bus.dispose(); }    catch (e) {}
        try { t._panner && t._panner.dispose(); } catch (e) {}
        try { t._mono   && t._mono.dispose(); }   catch (e) {}
        if (t._samplers) {
          t._samplers.forEach(s => { try { s.dispose(); } catch (e) {} });
        }
      });
      // Rebuild the tracks array from the snapshot, preserving the
      // existing track object (with its audio nodes) when ids match.
      const next = snap.map(s => {
        const old = oldById.get(s.id);
        if (old) {
          old.name = s.name;
          old.items = JSON.parse(JSON.stringify(s.items || []));
          old.loopMode = !!s.loopMode;
          old.solo = !!s.solo;
          old.eq = { ...(s.eq || {}) };
          old.pan = Number.isFinite(s.pan) ? s.pan : 0;
          // Switching stereo↔mono requires a bus rebuild — drop the
          // current chain so getTrackBus reconstructs it on next play.
          if (old.stereo !== (s.stereo !== false)) {
            if (old._bus)    { try { old._bus.dispose(); }    catch (e) {} old._bus    = null; }
            if (old._panner) { try { old._panner.dispose(); } catch (e) {} old._panner = null; }
            if (old._mono)   { try { old._mono.dispose(); }   catch (e) {} old._mono   = null; }
            if (old._samplers) {
              old._samplers.forEach(x => { try { x.dispose(); } catch (e) {} });
              old._samplers = null;
            }
          }
          old.stereo = s.stereo !== false;
          old.playing = false;
          old.currentItemIdx = null;
          old.timer = null;
          old.timers = null;
          // Push EQ / pan onto the live audio nodes if they exist so
          // the restored values are heard on the next playback.
          if (old._busIsEq && old._bus && old._bus.low) {
            try { old._bus.low.value  = old.eq.low  || 0; } catch (e) {}
            try { old._bus.mid.value  = old.eq.mid  || 0; } catch (e) {}
            try { old._bus.high.value = old.eq.high || 0; } catch (e) {}
          }
          if (old._panner) {
            try { old._panner.pan.value = Math.max(-1, Math.min(1, old.pan)); } catch (e) {}
          }
          return old;
        }
        return {
          id: s.id,
          name: s.name,
          items: JSON.parse(JSON.stringify(s.items || [])),
          loopMode: !!s.loopMode,
          solo: !!s.solo,
          eq: { ...(s.eq || {}) },
          pan: Number.isFinite(s.pan) ? s.pan : 0,
          stereo: s.stereo !== false,
          playing: false,
          currentItemIdx: null,
          timer: null,
        };
      });
      tracks = next;
      // Keep the id counter ahead of any restored id so future addTrack
      // calls can't collide.
      const maxId = tracks.reduce((m, t) => Math.max(m, t.id || 0), 0);
      if (trackIdCounter <= maxId) trackIdCounter = maxId + 1;
      // The selection set may now point at items that no longer exist.
      // Drop entries that have gone out of range; clear the primary if
      // it was one of them.
      if (typeof _selectedTrackItems !== 'undefined') {
        const stillValid = new Set();
        _selectedTrackItems.forEach(k => {
          const [ti, ii] = k.split(':').map(n => parseInt(n, 10));
          if (tracks[ti] && tracks[ti].items[ii]) stillValid.add(k);
        });
        _selectedTrackItems.clear();
        stillValid.forEach(k => _selectedTrackItems.add(k));
        if (_selectedTrackItem) {
          const pk = `${_selectedTrackItem.trackIdx}:${_selectedTrackItem.itemIdx}`;
          if (!stillValid.has(pk)) _selectedTrackItem = null;
        }
      }
      if (typeof dismissTrackItemPopover === 'function') {
        try { dismissTrackItemPopover(); } catch (e) {}
      }
      persistTracks();
      renderTracks();
    }
    // When a batched action (e.g. a step-edit transform fanned out across the
    // whole selection) wants ONE undo entry for the whole batch, it snapshots
    // once and sets this flag so the per-step functions' own snapshotForUndo
    // calls collapse to no-ops. Always reset in a finally by the batcher.
    let _suppressUndoSnapshot = false;
    function snapshotForUndo(label) {
      if (_suppressUndoSnapshot) return;
      undoStack.push(captureSnapshot(label));
      while (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
      refreshHistoryButtons();
    }
    function performUndo() {
      const snap = undoStack.pop();
      if (!snap) { refreshHistoryButtons(); return; }
      redoStack.push(captureSnapshot(snap.label));
      while (redoStack.length > UNDO_LIMIT) redoStack.shift();
      applySnapshot(snap);
      showHistoryToast('Undone: ' + (snap.label || 'last action'));
      refreshHistoryButtons();
    }
    function performRedo() {
      const snap = redoStack.pop();
      if (!snap) { refreshHistoryButtons(); return; }
      undoStack.push(captureSnapshot(snap.label));
      while (undoStack.length > UNDO_LIMIT) undoStack.shift();
      applySnapshot(snap);
      showHistoryToast('Redone: ' + (snap.label || 'last action'));
      refreshHistoryButtons();
    }
    function showHistoryToast(text) {
      let toast = document.getElementById('undo-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'undo-toast';
        document.body.appendChild(toast);
      }
      toast.textContent = text;
      toast.classList.remove('hide');
      // Force reflow so the next class change re-triggers the transition.
      // eslint-disable-next-line no-unused-expressions
      toast.offsetWidth;
      toast.classList.add('show');
      clearTimeout(showHistoryToast._t);
      showHistoryToast._t = setTimeout(() => {
        toast.classList.remove('show');
      }, 2200);
    }
    // Wrap a state-mutating user action so it can be undone.
    function withUndo(label, fn) {
      snapshotForUndo(label);
      try { fn(); } catch (e) { undoStack.pop(); refreshHistoryButtons(); throw e; }
    }
    // Batch-coalesce undo entries. When a UI control fires many small
    // mutations in a row (volume slider drag, multi-select duplicate /
    // remove / etc.), we want ONE undoable step instead of N. Open a
    // batch with `beginUndoBatch(label)` — it snapshots once and sets
    // the flag so subsequent `maybeSnapshotForUndo` calls inside the
    // batch are no-ops — then close it with `endUndoBatch()`.
    let _undoBatchActive = false;
    function beginUndoBatch(label) {
      if (_undoBatchActive) return;
      _undoBatchActive = true;
      snapshotForUndo(label);
    }
    function endUndoBatch() {
      _undoBatchActive = false;
    }
    function maybeSnapshotForUndo(label) {
      if (_undoBatchActive) return;
      snapshotForUndo(label);
    }
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta || (e.key !== 'z' && e.key !== 'Z')) return;
      e.preventDefault();
      if (e.shiftKey) performRedo();
      else            performUndo();
    });
    document.getElementById('undo-btn').addEventListener('click', performUndo);
    document.getElementById('redo-btn').addEventListener('click', performRedo);
    // ---- Deselect all ---------------------------------------------------
    // Escape, or a click on empty space in the sequence ribbon, clears the
    // step selection (which drops the edit scope back to lane-wide).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (selectedStepRefs.length) { clearSelection(); renderSequence(); }
    });
    (function initSeqBackgroundClear() {
      const disp = document.getElementById('sequence-display');
      if (!disp) return;
      disp.addEventListener('click', (e) => {
        const tgt = e.target;
        // A chip or any interactive control handles its own click — only a
        // tap on the empty ribbon background deselects.
        if (tgt.closest && (tgt.closest('.seq-step') || tgt.closest('button, input, select, textarea, label'))) return;
        if (selectedStepRefs.length) { clearSelection(); renderSequence(); }
      });
    })();
    // ---- Select-by-rule menu -------------------------------------------
    (function initSelectByRuleBtn() {
      const btn = document.getElementById('seq-select-btn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (typeof showCtxMenu !== 'function') return;
        const r = btn.getBoundingClientRect();
        showCtxMenu(r.left, r.bottom + 2, [
          { label: 'All', fn: () => _selectByRule('all') },
          { label: 'None', fn: () => _selectByRule('none') },
          { label: 'Invert', fn: () => _selectByRule('invert') },
          'hr',
          { label: 'Every 2nd', fn: () => _selectByRule('nth', 2) },
          { label: 'Every 3rd', fn: () => _selectByRule('nth', 3) },
          { label: 'Every 4th', fn: () => _selectByRule('nth', 4) },
          'hr',
          { label: 'All rests', fn: () => _selectByRule('rests') },
          { label: 'All chords / wraps', fn: () => _selectByRule('chords') },
          { label: 'On the beat', fn: () => _selectByRule('onbeat') },
        ]);
      });
    })();
    function lastSelectedStep() {
      if (selectedStepRefs.length === 0) return null;
      return selectedStepRefs[selectedStepRefs.length - 1];
    }
    function isSelectedStep(step) {
      return selectedStepRefs.indexOf(step) !== -1;
    }
    function selectedStepIndices() {
      const out = [];
      selectedStepRefs.forEach(ref => {
        const idx = sequence.indexOf(ref);
        if (idx >= 0) out.push(idx);
      });
      return out;
    }
    // Step taxonomy helpers — used by the Edit row's eligibility logic
    // and by every pan / vol / slip writer so chord and sub-sequence
    // chips behave like note chips do. Without these, the editor's
    // `freq != null && !isSub` filter quietly hid the bars whenever
    // the selection was a chord (no freq) or a sub (isSub=true).
    const _stepHasPlayableContent = (s) =>
      !!s && (s.freq != null || Array.isArray(s.chord) || (s.isSub && Array.isArray(s.subSteps) && s.subSteps.length > 0));
    // Drill through nested subSteps to the first leaf with playable
    // content. Returns the step itself if it isn't a sub. Used to
    // pick a value to display on the slider when the selected chip
    // is a sub group — the first child's pan/vol/slip is a sensible
    // representative; if the user drags the slider every leaf gets
    // the new value via _forEachStepLeaf.
    function _firstStepLeaf(s) {
      if (!s) return null;
      if (s.isSub && Array.isArray(s.subSteps)) {
        for (const c of s.subSteps) {
          const f = _firstStepLeaf(c);
          if (f) return f;
        }
        return null;
      }
      return s;
    }
    // Walk every leaf descendant of `s` (or `s` itself if it isn't a
    // sub) and call fn on it. Writers use this to apply pan / vol /
    // slip to all children of a sub-sequence so the chip's slider
    // edits propagate down to the actually-fired voices.
    function _forEachStepLeaf(s, fn) {
      if (!s) return;
      if (s.isSub && Array.isArray(s.subSteps)) {
        s.subSteps.forEach(c => _forEachStepLeaf(c, fn));
        return;
      }
      fn(s);
    }
    // ---- Step-select grid preview -------------------------------------
    // When a step is selected, load THAT step's grid-specific info (tone +
    // key context) into the live grid so the cell row / Sounds button reflect
    // the step you're editing. The pre-select grid voice is snapshotted and
    // restored verbatim on full deselect. With a multi-selection the FIRST
    // selected step's info stays loaded (selectedStepRefs[0]). The snapshot is
    // the source of truth for persistence — _captureVoiceGlobals() (06) and
    // buildProjectSnapshot() (11) read it, not the transient preview, so the
    // loaded tone never leaks into a save or onto another lane.
    let _stepPreviewSnap = null;   // grid voice captured before the preview
    let _previewStepRef  = null;   // the step currently previewed
    // Resolve a representative tone (+ key context) for a step. Drills
    // sub-sequences to their first leaf and reads chord voice 0.
    function _stepPreviewSource(step) {
      if (!step) return null;
      let s = step, guard = 0;
      while (s && s.isSub && Array.isArray(s.subSteps) && guard++ < 8) s = _firstStepLeaf(s);
      if (!s) return null;
      let sound, params;
      if (Array.isArray(s.chord) && s.chord.length) {
        const v = s.chord[0] || {};
        params = (v.params && typeof v.params === 'object') ? v.params : null;
        sound  = v.sound || (params && params.type);
      } else {
        params = (s.params && typeof s.params === 'object') ? s.params : null;
        sound  = s.sound || (params && params.type);
      }
      const kc = (step.keyContext && typeof step.keyContext === 'object') ? step.keyContext
               : ((s.keyContext && typeof s.keyContext === 'object') ? s.keyContext : null);
      if (!sound && !params && !kc) return null;
      return { sound: sound || 'sine', params, keyContext: kc };
    }
    function _applyStepGridPreview(step) {
      if (typeof _captureVoiceGlobals !== 'function' || typeof _applyVoiceToGlobals !== 'function') return;
      const src = _stepPreviewSource(step);
      if (!src) return;
      if (!_stepPreviewSnap) _stepPreviewSnap = _captureVoiceGlobals();
      const snap = _stepPreviewSnap;
      const params = (src.params && typeof src.params === 'object') ? src.params : { type: src.sound };
      const kc = src.keyContext;
      // Tone + key come from the step; octave / palette / A4 stay as they were
      // (preview scope is tone + key only).
      _applyVoiceToGlobals({
        cellSounds: snap.cellSounds.map(() => src.sound),
        cellParams: snap.cellParams.map(() => ({ ...params })),
        scale:   (kc && typeof kc.scale === 'string' && typeof SCALES !== 'undefined' && SCALES[kc.scale]) ? kc.scale : snap.scale,
        rootIdx: (kc && Number.isFinite(kc.root)) ? kc.root : snap.rootIdx,
        palette: snap.palette, chipPalette: snap.chipPalette,
        baseOctave: snap.baseOctave, octaveCount: snap.octaveCount,
        masterFreqA: snap.masterFreqA, restColor: snap.restColor,
      });
    }
    function _clearStepGridPreview() {
      if (!_stepPreviewSnap) { _previewStepRef = null; return; }
      const snap = _stepPreviewSnap;
      _stepPreviewSnap = null; _previewStepRef = null;  // clear first so guards read real state
      if (typeof _applyVoiceToGlobals === 'function') _applyVoiceToGlobals(snap);
    }
    function _reconcileStepGridPreview() {
      const first = (selectedStepRefs && selectedStepRefs.length) ? selectedStepRefs[0] : null;
      try {
        if (first) {
          if (first !== _previewStepRef) { _previewStepRef = first; _applyStepGridPreview(first); }
        } else {
          _clearStepGridPreview();
        }
      } catch (e) {}
    }
    // First playable step in a step list (skips rests; chord / sub count).
    function _firstPlayableStep(steps) {
      if (!Array.isArray(steps)) return null;
      for (const s of steps) {
        if (s && (s.freq != null || Array.isArray(s.chord) || (s.isSub && Array.isArray(s.subSteps) && s.subSteps.length))) return s;
      }
      return null;
    }
    // Commit a lane's FIRST step's tone + key into the live grid (so the grid
    // reflects the lane's content on switch). Unlike the step-select preview
    // this is NOT snapshotted — it becomes the grid's working state. Octave /
    // palette / A4 are kept from the lane's just-applied voice. No-op when the
    // lane has no playable first step.
    function _applyFirstStepToGrid(lane) {
      if (typeof _captureVoiceGlobals !== 'function' || typeof _applyVoiceToGlobals !== 'function') return;
      const first = _firstPlayableStep(lane && lane.steps);
      if (!first) return;
      const src = (typeof _stepPreviewSource === 'function') ? _stepPreviewSource(first) : null;
      if (!src) return;
      const cur = _captureVoiceGlobals();
      const params = (src.params && typeof src.params === 'object') ? src.params : { type: src.sound };
      const kc = src.keyContext;
      _applyVoiceToGlobals({
        cellSounds: cur.cellSounds.map(() => src.sound),
        cellParams: cur.cellParams.map(() => ({ ...params })),
        scale:   (kc && typeof kc.scale === 'string' && typeof SCALES !== 'undefined' && SCALES[kc.scale]) ? kc.scale : cur.scale,
        rootIdx: (kc && Number.isFinite(kc.root)) ? kc.root : cur.rootIdx,
        palette: cur.palette, chipPalette: cur.chipPalette,
        baseOctave: cur.baseOctave, octaveCount: cur.octaveCount,
        masterFreqA: cur.masterFreqA, restColor: cur.restColor,
      });
    }
    // Collect the set of distinct TONES (params.type / sound) used across a
    // lane's steps — chord voices and sub-sequence leaves included, rests and
    // pitch ignored. Used to flag lanes whose steps don't all share one tone.
    function _collectStepTones(step, set) {
      if (!step) return;
      if (step.isSub && Array.isArray(step.subSteps)) { step.subSteps.forEach(c => _collectStepTones(c, set)); return; }
      if (Array.isArray(step.chord)) {
        step.chord.forEach(v => { const t = (v && v.params && v.params.type) || (v && v.sound); if (t) set.add(t); });
        return;
      }
      if (step.freq == null) return; // rest
      const t = (step.params && step.params.type) || step.sound;
      if (t) set.add(t);
    }
    function _laneToneMixed(lane) {
      const set = new Set();
      const steps = (lane && Array.isArray(lane.steps)) ? lane.steps : [];
      steps.forEach(s => _collectStepTones(s, set));
      return set.size > 1;
    }
    function syncStepEditorFromSelection() {
      _reconcileStepGridPreview();
      const step = lastSelectedStep();
      const noteLengthSel = document.getElementById('note-length');
      const subSel = document.getElementById('subdivision-select');
      if (step && !step.isSub && (step.freq != null || step.chord)) {
        if (noteLengthSel) noteLengthSel.value = String(step.duration ?? 1);
        if (subSel) {
          const v = (step.subdivision != null) ? step.subdivision : stepSubdivision;
          subSel.value = String(v);
        }
      } else {
        if (noteLengthSel) noteLengthSel.value = String(noteLength);
        if (subSel) subSel.value = String(stepSubdivision);
      }
      refreshHoldEnabled();
      // Pink outline on the Step section while a chip is selected, so the
      // user sees that grid clicks now retune the selection instead of
      // appending fresh steps.
      const stepGroup = document.querySelector('.btn-group--step');
      if (stepGroup) stepGroup.classList.toggle('step-selected', selectedStepRefs.length > 0);
      // Scope readout on the Select button: "N sel" when steps are selected,
      // else "Lane" so it's clear an edit with no selection hits the whole lane.
      const _selBtn = document.getElementById('seq-select-btn');
      if (_selBtn) {
        const n = selectedStepRefs.length;
        _selBtn.textContent = n ? (n + ' sel ▾') : 'Lane ▾';
        _selBtn.classList.toggle('active', n > 0);
      }

      // Selected-step pan slider: hide when nothing is selected; show
      // and sync to the primary's pan value when there is. Multi-mode
      // ignores any divergence and just shows the primary's value.
      // In Poly mode the active lane counts as an implicit selection —
      // bars stay visible and read the lane's last eligible step so
      // the user can shape the whole lane at once without manually
      // selecting every chip.
      const editRow = document.getElementById('step-edit-row');
      const editBtn = document.getElementById('step-edit-btn');
      const panBar = document.getElementById('step-pan-bar');
      const panSlider = document.getElementById('step-pan-slider');
      const panVal = document.getElementById('step-pan-val');
      const volBar = document.getElementById('step-vol-bar');
      const volSlider = document.getElementById('step-vol-slider');
      const volVal = document.getElementById('step-vol-val');
      const slipBar = document.getElementById('step-slip-bar');
      const slipSlider = document.getElementById('step-slip-slider');
      const slipVal = document.getElementById('step-slip-val');
      // Eligibility is now "step has any playable content" — chord
      // chips (no freq, has chord[]) and sub-sequence chips (isSub,
      // has subSteps[]) qualify alongside plain notes. The Pan / Vol
      // / Slip bars only show when at least one such step is
      // selected; the older "fall through to lane-scope when no
      // selection" behavior is gone (per user — these faders are
      // step-level controls, not lane-level).
      const selEligible = selectedStepRefs.filter(_stepHasPlayableContent);
      // Scope = selection ONLY. The Mix/Groove tab sections are step-level
      // editors, so they stay hidden until at least one playable step is
      // selected (per user). The earlier "0 = lane" fall-through is retired —
      // polyLaneScope is kept as a constant false so the downstream branches
      // that reference it collapse cleanly to the no-lane-scope path.
      const polyLaneScope = false;
      const eligible = selEligible;
      const showBars = eligible.length > 0 || _allLaneMode;
      // Read the slider's display value from the primary step's first
      // playable leaf — collapses chord and sub cases to the same
      // lookup. For chord steps the leaf IS the chord step (chord
      // params live on step.params); for subs we drill down.
      const _primaryLeaf = (showBars && !polyLaneScope)
        ? _firstStepLeaf(eligible[eligible.length - 1])
        : null;
      // Mixed-state: when 2+ steps are selected and diverge on an attribute,
      // show "Mixed" (and mark the bar) rather than one step's value — so the
      // user knows editing that control unifies just THAT attribute, leaving
      // every other (possibly divergent) property per-step.
      const _attr = (top, key, dflt) => { const lf = _firstStepLeaf(top); const pv = (lf && lf.params) ? lf.params[key] : undefined; return Number.isFinite(pv) ? pv : ((lf && Number.isFinite(lf[key])) ? lf[key] : dflt); };
      const _markMixed = (bar, valEl, key, dflt) => {
        const m = (!polyLaneScope && eligible.length >= 2) && eligible.some(t => _attr(t, key, dflt) !== _attr(eligible[0], key, dflt));
        if (bar) bar.classList.toggle('mixed', m);
        if (m && valEl) valEl.textContent = 'Mixed';
        return m;
      };
      if (panBar) {
        if (!showBars) {
          panBar.hidden = true;
        } else {
          panBar.hidden = false;
          let p;
          if (polyLaneScope) {
            const lane = lanes[activeLaneIdx];
            p = Number.isFinite(lane.pan) ? lane.pan : 0;
          } else {
            p = (_primaryLeaf && _primaryLeaf.params && Number.isFinite(_primaryLeaf.params.pan))
              ? _primaryLeaf.params.pan : 0;
          }
          if (panSlider) panSlider.value = String(p);
          if (panVal) panVal.textContent = formatPanLabel(p);
          _markMixed(panBar, panVal, 'pan', 0);
        }
      }
      if (volBar) {
        if (!showBars) {
          volBar.hidden = true;
        } else {
          volBar.hidden = false;
          let v;
          if (polyLaneScope) {
            const lane = lanes[activeLaneIdx];
            v = Number.isFinite(lane.volume) ? lane.volume : 100;
          } else {
            v = (_primaryLeaf && _primaryLeaf.params && Number.isFinite(_primaryLeaf.params.volume))
              ? _primaryLeaf.params.volume : 100;
          }
          if (volSlider) volSlider.value = String(v);
          if (volVal) volVal.textContent = v + '%';
          _markMixed(volBar, volVal, 'volume', 100);
        }
      }
      if (slipBar) {
        if (!showBars) {
          slipBar.hidden = true;
        } else {
          slipBar.hidden = false;
          let s;
          if (polyLaneScope) {
            const lane = lanes[activeLaneIdx];
            s = Number.isFinite(lane.slip) ? lane.slip : 0;
          } else if (_primaryLeaf) {
            s = (_primaryLeaf.params && Number.isFinite(_primaryLeaf.params.slip))
              ? _primaryLeaf.params.slip
              : (Number.isFinite(_primaryLeaf.slip) ? _primaryLeaf.slip : 0);
          } else {
            s = 0;
          }
          if (slipSlider) slipSlider.value = String(s);
          if (slipVal) slipVal.textContent = (s > 0 ? '+' : '') + s + '%';
          _markMixed(slipBar, slipVal, 'slip', 0);
        }
      }
      // Strum bar — only meaningful for chord steps (it staggers the chord's
      // voices), so it shows only when the primary selected step is a chord.
      const strumBar = document.getElementById('step-strum-bar');
      if (strumBar) {
        const _primaryStep = (showBars && eligible.length > 0) ? eligible[eligible.length - 1] : null;
        const isChordStep = !!(_primaryStep && Array.isArray(_primaryStep.chord));
        if (!isChordStep) {
          strumBar.hidden = true;
        } else {
          strumBar.hidden = false;
          const st = Number.isFinite(_primaryStep.strum) ? _primaryStep.strum : 0;
          const strumSlider = document.getElementById('step-strum-slider');
          const strumVal = document.getElementById('step-strum-val');
          if (strumSlider) strumSlider.value = String(st);
          if (strumVal) strumVal.textContent = (st > 0 ? '+' : '') + st + (st === 0 ? '' : ' ms');
        }
      }
      // Ratchet (Roll) bar — applies to any playable step (single or chord).
      const ratBar = document.getElementById('step-ratchet-bar');
      if (ratBar) {
        const _ratStep = (showBars && eligible.length > 0) ? eligible[eligible.length - 1] : null;
        if (!_ratStep || polyLaneScope) {
          ratBar.hidden = true;
        } else {
          ratBar.hidden = false;
          const rv = Number.isFinite(_ratStep.ratchet) ? Math.max(1, Math.min(8, _ratStep.ratchet)) : 1;
          const ratSlider = document.getElementById('step-ratchet-slider');
          const ratVal = document.getElementById('step-ratchet-val');
          if (ratSlider) ratSlider.value = String(rv);
          if (ratVal) ratVal.textContent = rv + '×';
        }
      }
      // Chance (probability) + When (conditional) bars — any playable step.
      const _condStep = (showBars && eligible.length > 0 && !polyLaneScope) ? eligible[eligible.length - 1] : null;
      const probBar = document.getElementById('step-prob-bar');
      if (probBar) {
        if (!_condStep) { probBar.hidden = true; }
        else {
          probBar.hidden = false;
          const pv = Number.isFinite(_condStep.prob) ? Math.max(0, Math.min(100, _condStep.prob)) : 100;
          const ps = document.getElementById('step-prob-slider');
          const pvl = document.getElementById('step-prob-val');
          if (ps) ps.value = String(pv);
          if (pvl) pvl.textContent = pv + '%';
        }
      }
      const condBar = document.getElementById('step-cond-bar');
      if (condBar) {
        if (!_condStep) { condBar.hidden = true; }
        else {
          condBar.hidden = false;
          const cv = (typeof _condStep.cond === 'string' && _condStep.cond) ? _condStep.cond : 'always';
          const cb = document.getElementById('step-cond-btn');
          if (cb) {
            cb.textContent = (cv === 'always') ? 'Always' : cv;
            cb.classList.toggle('active', cv !== 'always');
          }
        }
      }
      // Reflect each setting's active/bypass state on its toggle label and
      // disable the matching control when bypassed. State is read from the
      // primary (last-selected) eligible step's _off map.
      {
        const _primaryForToggles = (showBars && eligible.length > 0) ? eligible[eligible.length - 1] : null;
        const _toggleMap = [
          ['pan', 'step-pan-slider'], ['vol', 'step-vol-slider'], ['slip', 'step-slip-slider'],
          ['strum', 'step-strum-slider'], ['roll', 'step-ratchet-slider'],
          ['chance', 'step-prob-slider'], ['when', 'step-cond-btn'],
        ];
        _toggleMap.forEach(([key, ctrlId]) => {
          const lbl = document.querySelector('.step-toggle[data-setting="' + key + '"]');
          const ctrl = document.getElementById(ctrlId);
          const bypassed = !!(_primaryForToggles && _primaryForToggles._off && _primaryForToggles._off[key]);
          if (lbl) { lbl.classList.toggle('bypassed', bypassed); lbl.setAttribute('aria-pressed', bypassed ? 'false' : 'true'); }
          if (ctrl) ctrl.disabled = bypassed;
        });
      }
      // Edit row wraps both sliders + the Edit button. Show it when the
      // param bars are up OR any chip is selected — a rest has no playable
      // content (so no Pan/Vol bars) but still needs the Edit button so its
      // context menu (Remove step, etc.) is reachable.
      const _anySel = selectedStepRefs.length > 0;
      if (editRow) editRow.hidden = !(showBars || _anySel);
      if (editBtn) editBtn.hidden = !_anySel;
      // Multi-step signal: when 2+ steps are in the edit scope the row
      // wears a distinct accent (.multi) and the step count is folded into
      // the Edit button label ("✎ N"), so the user can see at a glance that
      // every control here writes to all selected steps at once.
      const _selCount = selectedStepRefs.length;
      if (editRow) editRow.classList.toggle('multi', _selCount > 1);
      if (editBtn) {
        const _multi = _selCount > 1;
        editBtn.textContent = _multi ? ('✎ ' + _selCount) : '✎';
        editBtn.classList.toggle('multi', _multi);
        editBtn.setAttribute('aria-label', _multi ? ('Edit ' + _selCount + ' steps') : 'Edit');
      }
      // "All" toggle — visible whenever the bars are. Its active-state
      // styling is owned by the toggle itself (set in the click
      // handler below) so just track presence here.
      // "All" is retired — selection IS the scope now (0 selected = whole lane),
      // so keep the button permanently hidden rather than re-showing it.
      const allBtn = document.getElementById('step-all-btn');
      if (allBtn) {
        allBtn.hidden = true;
        allBtn.classList.toggle('active', !!_allLaneMode);
        allBtn.setAttribute('aria-pressed', _allLaneMode ? 'true' : 'false');
      }
      if (editRow) editRow.classList.toggle('all-mode', !!_allLaneMode);
      // When All mode is on, prefer the active lane's first eligible
      // step for the slider readouts so the bars reflect the value
      // that's actually broadcast lane-wide. The single-step path
      // already does this above when a selection exists.
      if (_allLaneMode && showBars && Array.isArray(lanes) && lanes[activeLaneIdx]) {
        const laneSteps = lanes[activeLaneIdx].steps || [];
        let firstLeaf = null;
        for (const s of laneSteps) {
          firstLeaf = _firstStepLeaf(s);
          if (firstLeaf) break;
        }
        if (firstLeaf) {
          if (panSlider) {
            const p = (firstLeaf.params && Number.isFinite(firstLeaf.params.pan)) ? firstLeaf.params.pan : 0;
            panSlider.value = String(p);
            if (panVal) panVal.textContent = formatPanLabel(p);
          }
          if (volSlider) {
            const v = (firstLeaf.params && Number.isFinite(firstLeaf.params.volume)) ? firstLeaf.params.volume : 100;
            volSlider.value = String(v);
            if (volVal) volVal.textContent = v + '%';
          }
          if (slipSlider) {
            const s = (firstLeaf.params && Number.isFinite(firstLeaf.params.slip))
              ? firstLeaf.params.slip
              : (Number.isFinite(firstLeaf.slip) ? firstLeaf.slip : 0);
            slipSlider.value = String(s);
            if (slipVal) slipVal.textContent = (s > 0 ? '+' : '') + s + '%';
          }
        }
      }
    }
    // Hold is meaningful only when Step Div is 1/1 (value=4). Below 1/1 the
    // step is already shorter than a beat, so multiplying its length leads
    // to mismatched timings — easier to lock the control out than to debug
    // the resulting groove.
    function refreshHoldEnabled() {
      const noteLengthSel = document.getElementById('note-length');
      const subSel = document.getElementById('subdivision-select');
      if (!noteLengthSel || !subSel) return;
      const isWhole = parseFloat(subSel.value) === 4;
      noteLengthSel.disabled = !isWhole;
      const label = noteLengthSel.closest('.note-length-label');
      if (label) label.style.opacity = isWhole ? '' : '0.4';
    }
    function setSelectedStep(idx) {
      // Single-select replacement (multi off) or "set primary" (multi on
      // adds rather than replaces — handled at the click site).
      if (idx == null || idx < 0 || idx >= sequence.length) {
        selectedStepRefs = [];
      } else {
        selectedStepRefs = [sequence[idx]];
      }
      syncStepEditorFromSelection();
    }
    function addSelectedStep(idx) {
      if (idx == null || idx < 0 || idx >= sequence.length) return;
      const step = sequence[idx];
      if (!step || step.isSub) return;
      const existing = selectedStepRefs.indexOf(step);
      if (existing >= 0) {
        // Already selected — toggle off, but if it's the primary, keep it
        // as primary by re-adding to the end of the list.
        selectedStepRefs.splice(existing, 1);
      }
      selectedStepRefs.push(step);
      syncStepEditorFromSelection();
    }
    function clearSelection() {
      selectedStepRefs = [];
      syncStepEditorFromSelection();
    }
    // Toggle a step's membership in the selection (click/tap). Adding pushes it
    // to the end so it becomes the primary (drives the editor read-out).
    function _toggleSelectedStep(idx) {
      if (idx == null || idx < 0 || idx >= sequence.length) return;
      const step = sequence[idx];
      if (!step) return;
      const at = selectedStepRefs.indexOf(step);
      if (at >= 0) selectedStepRefs.splice(at, 1);
      else selectedStepRefs.push(step);
      syncStepEditorFromSelection();
    }
    // Select the contiguous range between two indices (shift-click). The
    // clicked end becomes the primary.
    function _selectStepRange(aIdx, bIdx) {
      const lo = Math.min(aIdx, bIdx), hi = Math.max(aIdx, bIdx);
      const range = [];
      for (let k = lo; k <= hi; k++) { if (sequence[k]) range.push(sequence[k]); }
      const clicked = sequence[bIdx];
      const ci = range.indexOf(clicked);
      if (ci >= 0) { range.splice(ci, 1); range.push(clicked); } // primary = clicked
      selectedStepRefs = range;
      syncStepEditorFromSelection();
    }
    // Select-by-rule: set the selection from a pattern over the active lane.
    // rule: all | none | invert | nth(n) | rests | chords | onbeat.
    function _selectByRule(rule, n) {
      const playable = (s) => !!(s && (s.freq != null || s.chord || (s.isSub && Array.isArray(s.subSteps))));
      let refs = [];
      if (rule === 'all') refs = sequence.filter(playable);
      else if (rule === 'none') refs = [];
      else if (rule === 'invert') refs = sequence.filter(s => playable(s) && !isSelectedStep(s));
      else if (rule === 'rests') refs = sequence.filter(s => s && s.freq == null && !s.chord && !s.isSub);
      else if (rule === 'chords') refs = sequence.filter(s => s && (Array.isArray(s.chord) || s.isSub));
      else if (rule === 'nth') { const k = Math.max(2, n | 0); refs = sequence.filter((s, i) => playable(s) && (i % k === 0)); }
      else if (rule === 'onbeat') {
        let acc = 0; const eps = 1e-6;
        sequence.forEach((s) => {
          const onBeat = Math.abs(acc - Math.round(acc)) < eps;
          if (onBeat && playable(s)) refs.push(s);
          acc += (s.duration || 1) * ((s.subdivision != null) ? s.subdivision : stepSubdivision);
        });
      }
      selectedStepRefs = refs;
      syncStepEditorFromSelection();
      renderSequence();
    }
    function clampSelectionToSequence() {
      // Drop any step refs that no longer live in the sequence (e.g., after
      // Random / Condense / load-saved replaced the array entirely).
      // Subs are now allowed in the selection so the user can highlight a
      // sub chip and Unwrap it via the dissolve path; downstream
      // multi-select operations (Wrap/group) still skip subs at their
      // own gather sites.
      selectedStepRefs = selectedStepRefs.filter(ref => sequence.indexOf(ref) >= 0);
      // Variance edit: drop the edit state if its step is gone, and
      // re-sync stepIdx if the sequence reordered.
      if (_varianceEdit) {
        const idx = sequence.indexOf(_varianceEdit.stepRef);
        if (idx < 0) _varianceEdit = null;
        else _varianceEdit.stepIdx = idx;
      }
      // If multi was on but we're down to 0 or 1 selected, the toggle stays
      // wherever the user last left it — but we resync the editor.
      syncStepEditorFromSelection();
    }

    // Visual layout: rows × cols. The visible chip layout uses cols
    // chips per row; in Fixed (step) mode the workspace is padded /
    // trimmed to rows × cols total slots.
    let gridColumns = 8;
    let gridRows = 1;
    // Step-sequencer mode — when on, the workspace is treated as a fixed
    // pattern of rows × cols slots. Cell clicks arm the current note;
    // chip clicks toggle that note in/out.
    let stepMode = false;
    let stepModeArmed = null; // a step template prepped by the last grid click
    function effectiveGridCols() {
      return Math.max(1, gridColumns | 0);
    }
    function effectiveGridRows() {
      return Math.max(1, gridRows | 0);
    }
    function effectiveStepCount() {
      return effectiveGridRows() * effectiveGridCols();
    }
    function isRestStep(s) {
      return !!s && !s.isSub && !s.chord && (s.freq == null);
    }
    function makeRestStep() {
      return { freq: null, label: '—', cellIndex: null, duration: 1, subdivision: stepSubdivision };
    }
    function padToStepGrid() {
      const n = effectiveStepCount();
      while (sequence.length < n) sequence.push(makeRestStep());
      if (sequence.length > n) sequence.length = n;
    }
    function armStepModeNote(step) {
      stepModeArmed = step;
      cells.forEach((cell, idx) => {
        cell.classList.toggle('step-mode-armed', step && idx === step.cellIndex);
      });
    }
    function clearStepModeArm() {
      stepModeArmed = null;
      cells.forEach(c => c.classList.remove('step-mode-armed'));
    }

    // ---- Fixed-mode sequential editing ----
    // When Fixed mode is on AND Keep is on, the next grid press writes
    // the pressed note onto the currently-selected step and advances
    // the selection to the next step. The first selection is set up
    // by _fixedSeqStart (called from both step-mode-btn click and the
    // Keep toggle). When the last step is written, Fixed mode exits
    // and the selection clears. _fixedSeqActive guards the cell/REST
    // handlers so the advance flow only kicks in while the
    // user-intent state is right.
    let _fixedSeqActive = false;
    function _fixedSeqStart() {
      if (!stepMode || !keepMode) return;
      if (!Array.isArray(sequence) || sequence.length === 0) {
        _fixedSeqActive = false;
        return;
      }
      // Defensive: if the user happened to leave All-mode on from a
      // prior session, sliding any of the Pan/Vol/Slip faders would
      // broadcast lane-wide instead of editing the currently-selected
      // step, which is exactly the "one step changes the other"
      // surprise. Drop the flag (and refresh the editor row's chrome)
      // so the sequential flow lands in per-step edit mode every
      // time.
      if (typeof _allLaneMode !== 'undefined' && _allLaneMode) {
        _allLaneMode = false;
        const allBtn = document.getElementById('step-all-btn');
        if (allBtn) {
          allBtn.classList.remove('active');
          allBtn.setAttribute('aria-pressed', 'false');
        }
        const editRow = document.getElementById('step-edit-row');
        if (editRow) editRow.classList.remove('all-mode');
      }
      _fixedSeqActive = true;
      setSelectedStep(0);
      renderSequence();
    }
    function _fixedSeqCancel() {
      if (!_fixedSeqActive) return;
      _fixedSeqActive = false;
      clearSelection();
      renderSequence();
    }
    // Write `step` into the currently-selected slot, then advance the
    // selection to the next slot (or exit Fixed mode if we just wrote
    // the last slot). Returns true if the press was consumed by the
    // sequential flow (so the caller skips the default append path).
    function _fixedSeqWrite(step) {
      if (!_fixedSeqActive) return false;
      if (!stepMode || !keepMode) { _fixedSeqActive = false; return false; }
      const cur = selectedStepRefs[selectedStepRefs.length - 1];
      if (!cur) { _fixedSeqActive = false; return false; }
      const idx = sequence.indexOf(cur);
      if (idx < 0) { _fixedSeqActive = false; return false; }
      snapshotForUndo('Fixed: set step ' + (idx + 1));
      const slotSub = sequence[idx].subdivision;
      const slotDur = sequence[idx].duration;
      // Deep-clone the incoming step via cloneStep so the slot's
      // params (and any nested arrays like wavetableMix) don't share
      // references with the source step or with prior slots. The
      // shallow `{ ...step }` spread used here previously preserved
      // inner-array refs — editing one step's wavetableMix would have
      // mutated every slot built off the same cellParams entry.
      const writeStep = cloneStep(step);
      // Preserve the slot's existing rhythm fields so the lane's
      // step-div pattern stays intact across writes.
      writeStep.subdivision = (slotSub != null)
        ? slotSub
        : (writeStep.subdivision != null ? writeStep.subdivision : stepSubdivision);
      writeStep.duration = (slotDur != null)
        ? slotDur
        : (writeStep.duration || 1);
      sequence[idx] = writeStep;
      const nextIdx = idx + 1;
      if (nextIdx >= sequence.length) {
        // Last slot just got written — exit Fixed mode entirely (per
        // spec: "when last step is edited, no steps are selected and
        // leave fixed mode").
        _fixedSeqActive = false;
        clearSelection();
        stepMode = false;
        if (typeof refreshStepModeBtn === 'function') refreshStepModeBtn();
      } else {
        setSelectedStep(nextIdx);
      }
      renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
      return true;
    }

    // Snapshot of the current grid key for stamping onto new steps.
    // Chromatic = "no key" → returns null so chromatic sequences don't
    // get cluttered with empty key groupings. Specific scales return
    // a fresh object so the step's context doesn't move when the
    // grid's root / scale later change.
    function _captureKeyContext() {
      if (typeof currentScale !== 'string' || currentScale === 'chromatic') return null;
      const tonic = _effectiveScaleTonic();
      if (!Number.isFinite(tonic)) return null;
      // Stamp the SCALE's tonic, not the grid view's lowest cell. After
      // a scale-degree shift those diverge — the user is still "in
      // C major" even if the grid window is scrolled so D is at the
      // bottom. Visual key-grouping and saved-wrap rebasing both want
      // the original tonic.
      return { root: tonic, scale: currentScale };
    }
    // Pitch classes (0-11) covered by a keyContext. Returns null for
    // anything unresolvable so callers can short-circuit cleanly.
    function _scalePitchClassesForKey(kc) {
      if (!kc) return null;
      const intervals = (typeof SCALES !== 'undefined' && SCALES[kc.scale]) || null;
      if (!intervals) return null;
      return intervals.map(semi => (((kc.root + semi) % 12) + 12) % 12);
    }
    // Pitch class (0-11) of a freq using masterFreqA as A4 reference.
    function _pitchClassOfFreq(freq) {
      if (!Number.isFinite(freq) || freq <= 0) return null;
      const midi = Math.round(12 * Math.log2(freq / masterFreqA) + 69);
      return ((midi % 12) + 12) % 12;
    }
    function _midiOfFreq(freq) {
      if (!Number.isFinite(freq) || freq <= 0) return null;
      return Math.round(12 * Math.log2(freq / masterFreqA) + 69);
    }
    // Walk the step's audible notes and decide whether all of them are
    // in the given keyContext. Chord + sub steps recurse; freq-bearing
    // steps check directly; rests (no freq) count as "in key" so a
    // rest doesn't eject the step from its visual group.
    function _stepIsAllInKey(step, kc) {
      const pcs = _scalePitchClassesForKey(kc);
      if (!pcs) return false;
      const okSet = new Set(pcs);
      const checkOne = (s) => {
        if (!s) return true;
        if (s.isSub && Array.isArray(s.subSteps)) return s.subSteps.every(checkOne);
        if (Array.isArray(s.chord))               return s.chord.every(n => {
          const pc = _pitchClassOfFreq(n && n.freq);
          return pc == null || okSet.has(pc);
        });
        if (s.freq == null) return true; // rest
        const pc = _pitchClassOfFreq(s.freq);
        return pc == null || okSet.has(pc);
      };
      return checkOne(step);
    }
    // Snap a freq to its closest in-key pitch (within ±6 semitones)
    // and return { freq, label, midi }. Used by the rebase path when
    // a wrap's transposed note still lands out-of-key in the new key.
    function _snapFreqToKey(freq, kc) {
      const pcs = _scalePitchClassesForKey(kc);
      if (!pcs || pcs.length === 0) return null;
      const okSet = new Set(pcs);
      const midi = _midiOfFreq(freq);
      if (midi == null) return null;
      // Already in key — no snap needed.
      if (okSet.has(((midi % 12) + 12) % 12)) {
        return { freq, midi, label: _midiToLabel(midi) };
      }
      // Search ±6 semitones for the closest in-key pitch. Prefer the
      // lower neighbor on a tie so the snap feels like a "downward
      // chromatic resolve" rather than always going up.
      for (let d = 1; d <= 6; d++) {
        for (const dir of [-1, +1]) {
          const cand = midi + dir * d;
          const candPC = ((cand % 12) + 12) % 12;
          if (okSet.has(candPC)) {
            const newFreq = masterFreqA * Math.pow(2, (cand - 69) / 12);
            return { freq: newFreq, midi: cand, label: _midiToLabel(cand) };
          }
        }
      }
      return null;
    }
    // Build a "C4"-style label from a MIDI number. Mirrors the format
    // CHROMATIC + octave used everywhere else so labels stay consistent
    // after a rebase.
    function _midiToLabel(midi) {
      const pc = ((midi % 12) + 12) % 12;
      const oct = Math.floor(midi / 12) - 1;
      return CHROMATIC[pc] + oct;
    }
    // Rebase one note in-place: transpose by `deltaSemi`, then snap
    // to nearest in-key pitch in the new key if the result lands out.
    // Mutates the note's freq + label + clears cellIndex (the new
    // pitch may not correspond to any current grid cell).
    function _rebaseNoteInPlace(note, deltaSemi, newKc) {
      if (!note || !Number.isFinite(note.freq)) return;
      const oldMidi = _midiOfFreq(note.freq);
      if (oldMidi == null) return;
      const newMidi = oldMidi + deltaSemi;
      let newFreq = masterFreqA * Math.pow(2, (newMidi - 69) / 12);
      let newLabel = _midiToLabel(newMidi);
      const snap = _snapFreqToKey(newFreq, newKc);
      if (snap) { newFreq = snap.freq; newLabel = snap.label; }
      note.freq      = newFreq;
      note.label     = newLabel;
      note.cellIndex = null; // grid layout may not contain this cell
    }
    // Recursively rebase every audible note inside a step. Chord +
    // sub steps fan out to their constituent notes. Rests pass through.
    function _rebaseStepNotes(step, deltaSemi, newKc) {
      if (!step) return;
      if (Array.isArray(step.chord)) {
        step.chord.forEach(n => _rebaseNoteInPlace(n, deltaSemi, newKc));
        step.label = step.chord.map(n => n && n.label).filter(Boolean).join('·');
        return;
      }
      if (step.isSub && Array.isArray(step.subSteps)) {
        step.subSteps.forEach(s => _rebaseStepNotes(s, deltaSemi, newKc));
        return;
      }
      // SET wrap: rebase the whole variance pool (and the mirrored top note) so
      // a key change shifts the set like every other wrap shape.
      if (step.variance && Array.isArray(step.variance.notes)) {
        step.variance.notes.forEach(n => _rebaseNoteInPlace(n, deltaSemi, newKc));
        if (step.freq != null) _rebaseNoteInPlace(step, deltaSemi, newKc);
        const first = step.variance.notes[0];
        if (first && first.label) step.label = first.label;
        return;
      }
      if (step.freq != null) {
        _rebaseNoteInPlace(step, deltaSemi, newKc);
      }
    }
    // Determine a wrap's "root note" PC for scale-degree rebasing.
    // Chord wraps: the lowest pitched voice (matches functional bass).
    // Sub wraps: the first audible subStep (sequences naturally root
    // on their first note). Single-note wraps: that note. Rests + odd
    // shapes return null — caller skips rebase in that case.
    function _wrapRootPitchClass(step) {
      if (!step) return null;
      const allFreqs = [];
      const collect = (s) => {
        if (!s) return;
        if (Array.isArray(s.chord)) { s.chord.forEach(n => { if (n && Number.isFinite(n.freq)) allFreqs.push(n.freq); }); return; }
        if (s.isSub && Array.isArray(s.subSteps)) { s.subSteps.forEach(collect); return; }
        if (Number.isFinite(s.freq)) allFreqs.push(s.freq);
      };
      collect(step);
      if (allFreqs.length === 0) return null;
      // Chord = lowest voice (functional bass). Sub or single = first.
      const refFreq = Array.isArray(step.chord)
        ? Math.min(...allFreqs)
        : allFreqs[0];
      return _pitchClassOfFreq(refFreq);
    }
    // Backfill `origin` for bank entries created before the immutable
    // model existed. Idempotent — does nothing once origin is set.
    // Capturing the entry's current `step` as origin is the best we
    // can do for legacy wraps (we don't know what they were ORIGINALLY
    // before any earlier rebase). Going forward every fresh push sets
    // origin at commit time so future rebases stay reversible.
    function _ensureWrapOrigin(entry) {
      if (!entry || !entry.step) return;
      if (entry.origin && entry.origin.step) return;
      entry.origin = {
        step: cloneStep(entry.step),
        keyContext: (entry.step.keyContext)
          ? { root: entry.step.keyContext.root, scale: entry.step.keyContext.scale }
          : null,
      };
    }
    // Compute the wrap's `step` view for a given target key, always
    // from the immutable `origin`. The wrap restores verbatim when
    // the target equals the origin's birth key OR when the target is
    // chromatic (which imposes no constraint). Otherwise we
    // scale-degree-transpose origin into the new key and snap any
    // out-of-key residue to the nearest in-key pitch.
    function _renderWrapForKey(entry, newKc) {
      _ensureWrapOrigin(entry);
      if (!entry || !entry.origin || !entry.origin.step) return;
      const originStep = entry.origin.step;
      const originKc   = entry.origin.keyContext || null;
      // Chromatic target → restore origin verbatim. Chromatic doesn't
      // constrain anything, so the wrap's "natural form" is what plays.
      if (!newKc) {
        const restored = cloneStep(originStep);
        if (restored) {
          restored.keyContext = originKc
            ? { root: originKc.root, scale: originKc.scale }
            : null;
        }
        entry.step = restored;
        return;
      }
      // Target equals origin key → also restore. Identity case.
      if (originKc && originKc.root === newKc.root && originKc.scale === newKc.scale) {
        const restored = cloneStep(originStep);
        if (restored) restored.keyContext = { root: newKc.root, scale: newKc.scale };
        entry.step = restored;
        return;
      }
      // Origin's notes all happen to be in the new key already? Same
      // as restore: no transposition needed, just re-stamp keyContext
      // so the chip reads as belonging to the new key.
      if (_stepIsAllInKey(originStep, newKc)) {
        const restored = cloneStep(originStep);
        if (restored) restored.keyContext = { root: newKc.root, scale: newKc.scale };
        entry.step = restored;
        return;
      }
      // True rebase needed. Always start from a fresh clone of origin
      // so the transformation is reversible.
      const working = cloneStep(originStep);
      let deltaSemi = 0;
      const oldPCs = _scalePitchClassesForKey(originKc);
      const newPCs = _scalePitchClassesForKey(newKc);
      const rootPC = _wrapRootPitchClass(working);
      if (oldPCs && newPCs && rootPC != null) {
        const oldDegree = oldPCs.indexOf(rootPC);
        if (oldDegree >= 0) {
          const newRootPC = newPCs[oldDegree % newPCs.length];
          const raw = ((newRootPC - rootPC) + 12) % 12;
          deltaSemi = raw > 6 ? raw - 12 : raw;
        }
      }
      // For chromatic origin (oldPCs null), deltaSemi stays 0 — we
      // can't infer scale-degree intent, so we just snap each note to
      // the nearest in-key pitch in the new key.
      _rebaseStepNotes(working, deltaSemi, newKc);
      if (working) working.keyContext = { root: newKc.root, scale: newKc.scale };
      entry.step = working;
    }
    // Walk the wrap bank and re-render every entry against newKc.
    // Every render is computed FROM origin, never from the previous
    // rendered step — so any sequence of key changes is reversible
    // and the wrap's identity is preserved across the bank's lifetime.
    function _rebaseSavedWraps(_oldKc, newKc) {
      if (!Array.isArray(savedWraps) || savedWraps.length === 0) return false;
      savedWraps.forEach(entry => _renderWrapForKey(entry, newKc));
      persistSavedWraps();
      renderWrapBank();
      return true;
    }
    // Diatonic triad cell indices rooted on the pressed cell's pitch
    // class — only meaningful for 7-note scales. Returns null for
    // chromatic, pentatonic, whole tone, blues, etc. so the caller
    // falls back to a single-note add. Triad voicing tries to stack
    // thirds upward from the pressed cell (target offsets 0 / +4 / +7
    // semitones with scale-degree snapping). Matching cell is chosen
    // by minimum distance from the target MIDI offset.
    function _diatonicTriadCellIndices(pressedCellIdx) {
      if (!Number.isFinite(pressedCellIdx) || !notes[pressedCellIdx]) return null;
      if (!currentScale || currentScale === 'chromatic') return null;
      const intervals = SCALES[currentScale];
      if (!intervals || intervals.length < 7) return null;
      const scalePCs = intervals.map(semi => (((rootIdx + semi) % 12) + 12) % 12);
      const pressedMidi = _midiOfFreq(notes[pressedCellIdx].freq);
      if (pressedMidi == null) return null;
      const pressedPC = ((pressedMidi % 12) + 12) % 12;
      const degree = scalePCs.indexOf(pressedPC);
      if (degree < 0) return null;
      const triadOffsets = [0, 2, 4]; // root, third, fifth in scale-degree space
      const out = [];
      for (let t = 0; t < triadOffsets.length; t++) {
        const targetPC      = scalePCs[(degree + triadOffsets[t]) % scalePCs.length];
        const targetSemiAbove = t === 0 ? 0 : (t === 1 ? 4 : 7);
        let bestIdx = -1, bestDist = Infinity;
        for (let j = 0; j < notes.length; j++) {
          const n = notes[j];
          if (!n) continue;
          const jMidi = _midiOfFreq(n.freq);
          if (jMidi == null) continue;
          if ((((jMidi % 12) + 12) % 12) !== targetPC) continue;
          const dist = Math.abs((jMidi - pressedMidi) - targetSemiAbove);
          if (dist < bestDist) { bestDist = dist; bestIdx = j; }
        }
        if (bestIdx >= 0) out.push(bestIdx);
      }
      // De-dup in case the scale's third / fifth land on the same grid
      // cell as the root (shouldn't happen for normal scales, but
      // defensive).
      const seen = new Set();
      const uniq = out.filter(idx => seen.has(idx) ? false : (seen.add(idx), true));
      return uniq.length >= 2 ? uniq : null;
    }
    // True iff two keyContext snapshots represent the same key. Used
    // by renderSequence to decide whether consecutive steps belong in
    // the same visual key group. Null === null is "both ungrouped"
    // (also a match) so chromatic spans stay together.
    function _keyContextsMatch(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      return a.root === b.root && a.scale === b.scale;
    }
    // Apply a stamped keyContext to the grid — mirrors the manual
    // root / scale dropdown change path so the user can navigate
    // through a sequence by clicking chips and have the grid follow
    // each step's stored key. Returns true if anything changed.
    function _applyKeyContext(kc) {
      if (!kc) return false;
      const targetRoot  = Math.max(0, Math.min(11, kc.root | 0));
      const targetScale = (typeof kc.scale === 'string' && SCALES[kc.scale])
        ? kc.scale : 'chromatic';
      if (targetRoot === rootIdx && targetScale === currentScale
          && _effectiveScaleTonic() === targetRoot) return false;
      rootIdx = targetRoot;
      currentScale = targetScale;
      // Restore the scale's tonic to the clicked step's key — a chip
      // click should always reset any degree-shift-induced divergence
      // between rootIdx and _scaleTonic. Chromatic clears the tonic.
      _scaleTonic = (targetScale === 'chromatic') ? null : targetRoot;
      const rootSel  = document.getElementById('root-select');
      const scaleSel = document.getElementById('scale-select');
      if (rootSel)  rootSel.value  = String(rootIdx);
      if (scaleSel) scaleSel.value = currentScale;
      try { rebuildGrid(); } catch (e) {}
      try { applyScale(); } catch (e) {}
      try { if (typeof refreshAllCellFreqLabels === 'function') refreshAllCellFreqLabels(); } catch (e) {}
      try { if (typeof updateScaleBanner === 'function') updateScaleBanner(); } catch (e) {}
      try { if (typeof applyPalette === 'function') applyPalette(); } catch (e) {}
      try { if (typeof refreshKeyButton === 'function') refreshKeyButton(); } catch (e) {}
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      return true;
    }

    // ---- Key toggle button + picker ------------------------------------
    // The Key toggle in the sounds-utilities row is the user-facing
    // entry point for the existing root + scale system. Single-tap
    // flips between chromatic (off — full chromatic grid, no dimming,
    // no keyContext stamping) and the user's last non-chromatic key
    // (on). Right-click or long-press opens a richer picker so the
    // user can change root or scale without digging into Sounds.
    // Key state IS just (rootIdx, currentScale) — no separate flag.
    const KEY_LAST_LS = 'bloops-last-key-scale';
    function _readLastKeyScale() {
      try {
        const v = localStorage.getItem(KEY_LAST_LS);
        if (v && typeof v === 'string' && SCALES[v] && v !== 'chromatic') return v;
      } catch (e) {}
      return 'major';
    }
    function _writeLastKeyScale(scaleName) {
      try {
        if (typeof scaleName === 'string' && scaleName !== 'chromatic') {
          localStorage.setItem(KEY_LAST_LS, scaleName);
        }
      } catch (e) {}
    }
    // Short label for the button — keeps things readable on mobile
    // where horizontal real estate is tight. Two-letter root + the
    // first ~6 characters of the scale name.
    function _shortScaleLabel(scaleName) {
      if (!scaleName || scaleName === 'chromatic') return '';
      const pretty = (typeof prettyScaleName === 'function') ? prettyScaleName(scaleName) : scaleName;
      // Trim long scale names down to keep the toggle from blowing
      // out the sounds-utilities row width on a 360px viewport.
      return pretty.length > 10 ? pretty.slice(0, 9) + '…' : pretty;
    }
    function refreshKeyButton() {
      const btn = document.getElementById('key-mode-btn');
      if (!btn) return;
      const on = (currentScale && currentScale !== 'chromatic');
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) {
        const rootName = (typeof CHROMATIC !== 'undefined' && CHROMATIC[rootIdx]) || '?';
        btn.textContent = `♪ ${rootName} ${_shortScaleLabel(currentScale)}`;
      } else {
        btn.textContent = '♪ Key';
      }
      // Edit pill (✎ Pick key) shows only while Key mode is active —
      // there's nothing to pick when chromatic is the effective key.
      const editBtn = document.getElementById('key-edit-btn');
      if (editBtn) editBtn.hidden = !on;
    }
    function _setCurrentKey(newRootIdx, newScale, opts = {}) {
      const r = Math.max(0, Math.min(11, newRootIdx | 0));
      const s = (typeof newScale === 'string' && SCALES[newScale]) ? newScale : 'chromatic';
      const changed = (r !== rootIdx) || (s !== currentScale);
      if (!changed) return false;
      const oldKc = (currentScale && currentScale !== 'chromatic')
        ? { root: _effectiveScaleTonic(), scale: currentScale } : null;
      const newKc = (s && s !== 'chromatic') ? { root: r, scale: s } : null;
      rootIdx = r;
      currentScale = s;
      // Explicit key pick — both grid root AND scale tonic move to
      // the new root. Any prior degree-shift divergence is cleared.
      _scaleTonic = (s === 'chromatic') ? null : r;
      if (s !== 'chromatic') _writeLastKeyScale(s);
      const rootSel  = document.getElementById('root-select');
      const scaleSel = document.getElementById('scale-select');
      if (rootSel)  rootSel.value  = String(rootIdx);
      if (scaleSel) scaleSel.value = currentScale;
      if (!opts.skipRebuild) {
        try { rebuildGrid(); } catch (e) {}
      }
      try { applyScale(); } catch (e) {}
      try { if (typeof refreshAllCellFreqLabels === 'function') refreshAllCellFreqLabels(); } catch (e) {}
      try { if (typeof updateScaleBanner === 'function') updateScaleBanner(); } catch (e) {}
      try { if (typeof applyPalette === 'function') applyPalette(); } catch (e) {}
      refreshKeyButton();
      // Saved-wrap re-render. Always called, including transitions
      // TO chromatic — under the immutable-origin model, returning
      // to chromatic restores each wrap to its original committed
      // form, so we need to walk the bank in that direction too.
      if (typeof _rebaseSavedWraps === 'function') {
        try { _rebaseSavedWraps(oldKc, newKc); } catch (e) {}
      }
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      return true;
    }
    function _toggleKeyMode() {
      if (currentScale && currentScale !== 'chromatic') {
        // Turning off — remember the current scale so the next on-flip
        // restores it instead of resetting to 'major'.
        _writeLastKeyScale(currentScale);
        _setCurrentKey(rootIdx, 'chromatic');
      } else {
        const restored = _readLastKeyScale();
        _setCurrentKey(rootIdx, restored);
      }
    }
    // Key picker — opens a modal with a 12-button root row + a
    // scrollable scale list. Tapping anywhere applies immediately and
    // updates the underlying root / scale dropdowns. "Off" sets
    // chromatic without closing; the user can pick another scale
    // afterwards. Outside-click and Close button both dismiss.
    let _keyPickerOverlay = null;
    function _closeKeyPicker() {
      if (_keyPickerOverlay) {
        try { _keyPickerOverlay.remove(); } catch (e) {}
        _keyPickerOverlay = null;
      }
    }
    function _openKeyPicker() {
      _closeKeyPicker();
      const overlay = document.createElement('div');
      overlay.className = 'key-picker-overlay';
      const modal = document.createElement('div');
      modal.className = 'key-picker-modal';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      _keyPickerOverlay = overlay;

      const title = document.createElement('div');
      title.className = 'key-picker-title';
      title.textContent = 'Pick a key';
      modal.appendChild(title);

      const rootsRow = document.createElement('div');
      rootsRow.className = 'key-picker-roots';
      modal.appendChild(rootsRow);
      const rootButtons = [];
      for (let i = 0; i < 12; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'key-picker-root';
        b.textContent = CHROMATIC[i];
        b.dataset.root = String(i);
        b.addEventListener('click', () => {
          const targetScale = (currentScale && currentScale !== 'chromatic')
            ? currentScale
            : _readLastKeyScale();
          _setCurrentKey(i, targetScale);
          paintActive();
        });
        rootsRow.appendChild(b);
        rootButtons.push(b);
      }

      const scalesList = document.createElement('div');
      scalesList.className = 'key-picker-scales';
      modal.appendChild(scalesList);
      const scaleButtons = [];
      const scaleKeys = Object.keys(SCALES)
        .filter(n => n !== 'chromatic')
        .sort();
      scaleKeys.forEach(name => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'key-picker-scale';
        b.textContent = (typeof prettyScaleName === 'function') ? prettyScaleName(name) : name;
        b.dataset.scale = name;
        b.title = b.textContent;
        b.addEventListener('click', () => {
          _setCurrentKey(rootIdx, name);
          paintActive();
        });
        scalesList.appendChild(b);
        scaleButtons.push(b);
      });

      const footer = document.createElement('div');
      footer.className = 'key-picker-footer';
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'key-picker-off';
      off.textContent = 'Off (Chromatic)';
      off.addEventListener('click', () => {
        if (currentScale && currentScale !== 'chromatic') _writeLastKeyScale(currentScale);
        _setCurrentKey(rootIdx, 'chromatic');
        paintActive();
      });
      footer.appendChild(off);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'key-picker-close';
      close.textContent = 'Done';
      close.addEventListener('click', _closeKeyPicker);
      footer.appendChild(close);
      modal.appendChild(footer);

      function paintActive() {
        rootButtons.forEach((b, idx) => {
          b.classList.toggle('active', idx === rootIdx
            && currentScale && currentScale !== 'chromatic');
        });
        scaleButtons.forEach(b => {
          b.classList.toggle('active', b.dataset.scale === currentScale);
        });
      }
      paintActive();

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) _closeKeyPicker();
      });
      // Esc closes too.
      const onKey = (e) => {
        if (e.key === 'Escape') { _closeKeyPicker(); document.removeEventListener('keydown', onKey); }
      };
      document.addEventListener('keydown', onKey);
    }

    // Wire the toggle button + the dedicated ✎ Pick key edit pill.
    // The toggle is now a clean single-action button: tap to flip
    // Key mode on / off. The picker is reached via the separate
    // edit pill, which only renders while Key mode is on. Right-
    // click on the toggle still opens the picker as a power-user
    // shortcut — harmless and discoverable on desktop.
    (function initKeyModeButton() {
      const btn  = document.getElementById('key-mode-btn');
      const edit = document.getElementById('key-edit-btn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        _toggleKeyMode();
        try { btn.blur(); } catch (e) {}
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        _openKeyPicker();
      });
      if (edit) {
        edit.addEventListener('click', () => {
          _openKeyPicker();
          try { edit.blur(); } catch (e) {}
        });
      }
      // currentScale is declared further down in the script with `let`,
      // so it sits in the temporal dead zone right now. Defer the
      // initial label paint until after top-level execution finishes
      // (and currentScale exists). Event listeners above are bound
      // immediately — they only fire on user input, which can't beat
      // the script's parse-and-init run.
      setTimeout(() => { try { refreshKeyButton(); } catch (e) {} }, 0);
    })();

    function addToSequence(step) {
      // Subsequence concept removed — a run is just individual steps. Flatten
      // any isSub step into its leaf steps and add each in order (one snapshot
      // for the whole group).
      const steps = (step && step.isSub && Array.isArray(step.subSteps)) ? _flattenSubStep(step) : [step];
      if (!steps.length) return;
      const first = steps[0];
      const label = (steps.length > 1) ? 'Add run'
        : (first?.chord ? 'Add chord' : (first?.freq == null ? 'Add rest' : ('Add ' + (first?.label || 'note'))));
      snapshotForUndo(label);
      // Stamp the live grid key onto each step before it lands in the
      // sequence. Doesn't overwrite an existing keyContext — wraps
      // recalled from the bank carry their own (possibly rebased)
      // context, and saved sequences loaded from disk already have
      // theirs. Skipped entirely when chromatic is active.
      const _insert = (insertionPoint !== null && insertionPoint >= 0 && insertionPoint <= sequence.length);
      steps.forEach(s => {
        if (s && !s.keyContext) {
          const kc = _captureKeyContext();
          if (kc) s.keyContext = kc;
        }
        if (_insert) { sequence.splice(insertionPoint, 0, s); insertionPoint++; }
        else sequence.push(s);
      });
      // One-shot insert: drop the cursor after the group so the green bar
      // disappears and the row closes up. Re-open Insert before/after from the
      // step's context menu to add more.
      if (_insert) insertionPoint = null;
      renderSequence();
      document.getElementById('save-btn').disabled = false;
      // Persist on every step add so multi-lane Poly edits aren't lost
      // when the user reloads without first hitting an action that
      // happened to trigger a workspace save (lane switch, BPM change,
      // etc.). The persist is debounced 250ms inside persistWorkspace,
      // so rapid sequences of adds coalesce into one localStorage write.
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Step-div prompt for the Keep flow. Called after a note/chord is
    // appended in Spell or Stack mode while Keep is on. Skipped in Run
    // (arpeggio) mode per the user spec, and skipped while a session
    // lock is active — instead the lock value is applied directly.
    // Apply a Step Div value to a step. For Run wraps (isSub + subSteps)
    // the picked value applies to EACH subStep so the run's per-note
    // cadence updates uniformly; the outer wrap's subdivision stays at
    // its own value (typically 1). For chord / single-note steps the
    // value lands on the step itself, as before.
    function _applyStepDivToStep(stepRef, v) {
      if (!stepRef) return;
      if (stepRef.isSub && Array.isArray(stepRef.subSteps) && stepRef.subSteps.length > 0) {
        stepRef.subSteps.forEach(s => { if (s) s.subdivision = v; });
      } else {
        stepRef.subdivision = v;
      }
    }
    function maybePromptStepDiv(stepRef, opts = {}) {
      if (!stepRef || !keepMode) return;
      if (gridMode === 'arpeggio') return;
      // Record every kept note (in add order) so Keep-off can offer one
      // step-div menu over the whole session.
      if (Array.isArray(_keepSessionSteps) && _keepSessionSteps.indexOf(stepRef) < 0) {
        _keepSessionSteps.push(stepRef);
      }
      // Per-note picker is OPTIONAL now. When the user hasn't opted into
      // per-note prompting, notes append silently and sizing happens once
      // when Keep turns off (showKeepStepDivMenu).
      if (!_keepAskPerNote) return;
      // Press-and-hold already conveys size via the hold duration itself
      // (the step inherits a multi-step length from _holdStepDurationFromMs),
      // so don't pop the picker on top — that would force the user to
      // re-specify what they just expressed with the hold time. 200 ms is
      // the same "genuine hold" threshold _holdAdjustedParams uses.
      if (Number.isFinite(opts.heldMs) && opts.heldMs > 200) return;
      if (_keepStepDivLocked) {
        if (Number.isFinite(_keepStepDivLockedValue) && _keepStepDivLockedValue > 0) {
          _applyStepDivToStep(stepRef, _keepStepDivLockedValue);
          renderSequence();
        }
        return;
      }
      showStepDivPicker(stepRef);
    }

    // Modal that asks the user to pick a step-div size (4/1 → 1/32) for
    // the just-added note. The "Use for…" checkbox locks the chosen
    // value for the rest of the current Keep session so subsequent
    // notes don't re-prompt.
    function showStepDivPicker(stepRef) {
      // Don't stack pickers — if one is already up, dismiss and the
      // newer note just keeps its default subdivision.
      if (document.querySelector('.step-div-overlay')) return;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay step-div-overlay';
      const modal = document.createElement('div');
      modal.className = 'step-div-modal';
      modal.innerHTML = `
        <button type="button" class="sdiv-title-toggle" id="sdiv-title-toggle" aria-pressed="false" title="Tap to lock the next-picked size for the rest of this Keep session — no more re-prompting until Keep turns off.">Step size for this note</button>
        <div class="sdiv-grid">
          <button type="button" class="sdiv-opt" data-sub="0.08333333333333333">1/32t</button>
          <button type="button" class="sdiv-opt" data-sub="0.125">1/32</button>
          <button type="button" class="sdiv-opt" data-sub="0.16666666666666666">1/16t</button>
          <button type="button" class="sdiv-opt" data-sub="0.25">1/16</button>
          <button type="button" class="sdiv-opt" data-sub="0.3333333333333333">1/8t</button>
          <button type="button" class="sdiv-opt" data-sub="0.5">1/8</button>
          <button type="button" class="sdiv-opt" data-sub="1">1/4</button>
          <button type="button" class="sdiv-opt" data-sub="2">1/2</button>
          <button type="button" class="sdiv-opt" data-sub="4">1/1</button>
          <button type="button" class="sdiv-opt" data-sub="8">2/1</button>
          <button type="button" class="sdiv-opt" data-sub="12">3/1</button>
          <button type="button" class="sdiv-opt" data-sub="16">4/1</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Title doubles as a session-lock toggle. Off (default) =
      // "Step size for this note" → the picked size applies to this
      // one note only and the picker reappears for the next note.
      // On (highlighted) = "Step size for all notes this Keep session"
      // → the next picked size locks via _keepStepDiv* so the picker
      // is skipped for every following note until Keep turns off.
      const titleToggle = modal.querySelector('#sdiv-title-toggle');
      if (titleToggle) {
        titleToggle.addEventListener('click', () => {
          const on = !titleToggle.classList.contains('active');
          titleToggle.classList.toggle('active', on);
          titleToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
          titleToggle.textContent = on
            ? 'Step size for all notes this Keep session'
            : 'Step size for this note';
        });
      }
      modal.querySelectorAll('.sdiv-opt').forEach(b => {
        b.addEventListener('click', () => {
          const v = parseFloat(b.dataset.sub);
          if (!Number.isFinite(v) || v <= 0) return;
          // Route through the helper so Run wraps spread the value
          // across their subSteps instead of landing on the outer
          // wrap (which is a no-op for the audible cadence).
          _applyStepDivToStep(stepRef, v);
          if (titleToggle && titleToggle.classList.contains('active')) {
            _keepStepDivLocked = true;
            _keepStepDivLockedValue = v;
          }
          renderSequence();
          overlay.remove();
        });
      });
      // Click outside dismisses — the step keeps whatever subdivision
      // it already had (the global default). Bind on the next frame
      // so the click that triggered showStepDivPicker (cell or REST
      // tap → addToSequence → maybePromptStepDiv) can't ride the
      // bubble phase straight into the overlay and dismiss it the
      // instant it lands. iOS Safari in particular has been observed
      // firing a follow-up synthetic click after touchend on
      // touch-action: none cells, and that follow-up click was
      // closing the freshly-mounted overlay before the user could
      // pick a size.
      requestAnimationFrame(() => {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) overlay.remove();
        });
      });
    }

    // The Keep-off step-div menu. Shown when Keep turns off and at least one
    // note was kept that session. Offers two modes: "All notes" (pick one
    // size, applied to every kept note) and "Per note" (a row per note with
    // its own size). Dismissing leaves every note at whatever size it had.
    const _SDIV_SIZES = [
      ['1/32t', 0.08333333333333333], ['1/32', 0.125], ['1/16t', 0.16666666666666666],
      ['1/16', 0.25], ['1/8t', 0.3333333333333333], ['1/8', 0.5],
      ['1/4', 1], ['1/2', 2], ['1/1', 4], ['2/1', 8], ['3/1', 12], ['4/1', 16],
    ];
    function _stepCurrentSubdiv(step) {
      if (!step) return stepSubdivision;
      if (step.isSub && Array.isArray(step.subSteps) && step.subSteps[0]) {
        return (step.subSteps[0].subdivision != null) ? step.subSteps[0].subdivision : stepSubdivision;
      }
      return (step.subdivision != null) ? step.subdivision : stepSubdivision;
    }
    // Compact readout for a step-div total. Returns the named size when the
    // value matches one exactly (e.g. 1/8 + 1/8 = 1/4), else quarter-note
    // beats with a ♩ glyph (1/4 + 1/8 = 1.5♩).
    function _divReadout(v) {
      if (!Number.isFinite(v) || v <= 0) return '0';
      for (const [lbl, val] of _SDIV_SIZES) if (Math.abs(val - v) < 1e-6) return lbl;
      return (+v.toFixed(3)) + '♩';
    }
    function _stepName(s) {
      return (s && s.label) ? s.label : (s && s.isSub ? 'run' : s && Array.isArray(s.chord) ? 'chord' : 'note');
    }
    function showKeepStepDivMenu(steps) {
      const list = (steps || []).filter(Boolean);
      if (!list.length) return;
      if (document.querySelector('.step-div-overlay')) return;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay step-div-overlay';
      const modal = document.createElement('div');
      modal.className = 'step-div-modal keep-sdiv-modal';
      const sizeBtns = _SDIV_SIZES
        .map(([lbl, v]) => `<button type="button" class="sdiv-opt" data-sub="${v}">${lbl}</button>`)
        .join('');
      const optionsFor = (cur) => _SDIV_SIZES
        .map(([lbl, v]) => `<option value="${v}"${Math.abs(v - cur) < 1e-9 ? ' selected' : ''}>${lbl}</option>`)
        .join('');
      // Pitch <option> list for single-note rows — drawn from the current
      // grid notes, with the note's own pitch prepended if it isn't on the
      // grid (e.g. after a scale change) so it stays selectable.
      const pitchOptsFor = (freq, label) => {
        const gridNotes = Array.isArray(notes) ? notes : [];
        let matched = false;
        const opts = gridNotes
          .filter(n => n && n.freq != null)
          .map(n => {
            const sel = Math.abs(n.freq - freq) / (n.freq || 1) < 0.001;
            if (sel) matched = true;
            return `<option value="${n.freq}" data-label="${n.label}"${sel ? ' selected' : ''}>${n.label}</option>`;
          });
        if (!matched && freq != null) {
          opts.unshift(`<option value="${freq}" data-label="${label || ''}" selected>${label || '?'}</option>`);
        }
        return opts.join('');
      };
      // Per-note working model: one {kind:'note'} entry per kept note, with
      // optional {kind:'rest'} entries inserted right after a note (one per
      // note). Single notes also carry an editable pitch (freq/label/
      // cellIndex). Applied — sizes, pitches, inserted rests — only when the
      // user taps Apply on the Per-note tab.
      const model = list.map(step => {
        const isSingle = !!step && step.freq != null && !step.chord && !step.isSub;
        return {
          kind: 'note', step, sub: _stepCurrentSubdiv(step), isSingle,
          freq: isSingle ? step.freq : null,
          label: isSingle ? step.label : null,
          cellIndex: isSingle ? step.cellIndex : null,
        };
      });
      modal.innerHTML = `
        <div class="keep-sdiv-title">How long should each note play?</div>
        <div class="keep-sdiv-tabs" role="tablist">
          <button type="button" class="keep-sdiv-tab active" data-mode="all">All notes</button>
          <button type="button" class="keep-sdiv-tab" data-mode="per">Per note (${list.length})</button>
        </div>
        <div class="keep-sdiv-body" data-body="all">
          <div class="sdiv-grid">${sizeBtns}</div>
        </div>
        <div class="keep-sdiv-body" data-body="per" hidden>
          <div class="keep-sdiv-rows" id="keep-sdiv-rows"></div>
          <div class="keep-sdiv-actions">
            <div class="keep-sdiv-playgroup">
              <button type="button" class="keep-sdiv-preview">▶ Preview</button>
              <button type="button" class="keep-sdiv-loop" aria-pressed="false" title="Loop the preview">↻ Loop</button>
            </div>
            <button type="button" class="keep-sdiv-apply">Apply</button>
          </div>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Audition the current model — each note at its chosen size/pitch,
      // rests as gaps — without committing. Timers are tracked so a re-press
      // (or closing the menu) cancels an in-flight preview. Loop replays at
      // the end while the Loop toggle is on.
      let _previewTimers = [];
      let _previewActive = false;
      let _previewLoop = false;
      const _clearPreviewTimers = () => { _previewTimers.forEach(id => clearTimeout(id)); _previewTimers = []; };
      const _stopPreview = () => {
        _clearPreviewTimers();
        _previewActive = false;
        const pb = modal.querySelector('.keep-sdiv-preview');
        if (pb) pb.textContent = '▶ Preview';
      };
      const previewKeepModel = () => {
        _clearPreviewTimers();
        _previewActive = true;
        const pb = modal.querySelector('.keep-sdiv-preview');
        if (pb) pb.textContent = '■ Stop';
        try { Tone.start(); } catch (e) {}
        const bpm = parseInt(tempoInput?.value, 10) || 120;
        const secPerQuarter = 60 / bpm; // sub === 1 is a 1/4 note
        let tMs = 0;
        model.forEach((entry, idx) => {
          if (entry.kind !== 'note') return; // rests are pure gaps in the timing
          const noteMs = Math.max(1, Math.round(entry.sub * secPerQuarter * 1000));
          const nxt = model[idx + 1];
          const restMs = (nxt && nxt.kind === 'rest') ? Math.max(0, Math.round(nxt.sub * secPerQuarter * 1000)) : 0;
          const step = entry.step;
          const freq = entry.isSingle ? entry.freq : step.freq;
          const at = tMs;
          _previewTimers.push(setTimeout(() => {
            try {
              if (step.isSub) {
                previewStep(step); // runs handle their own internal cadence
              } else if (Array.isArray(step.chord)) {
                const size = step.chord.length;
                step.chord.forEach(n => {
                  if (n && n.freq != null) playNote(n.freq, paramsWithBend(chordVoiceParams(n.params || n.sound || 'sine', size, step), step.bend), noteMs);
                });
              } else if (freq != null) {
                playNote(freq, paramsWithBend(step.params || step.sound || 'sine', step.bend), noteMs);
              }
            } catch (e) {}
          }, at));
          tMs += noteMs + restMs;
        });
        // Tail timer: loop or stop at the end. Checks the live flag so
        // toggling Loop mid-play takes effect at the next boundary.
        if (tMs > 0) {
          _previewTimers.push(setTimeout(() => {
            if (_previewLoop) previewKeepModel();
            else _stopPreview();
          }, tMs));
        } else {
          _stopPreview();
        }
      };

      // Render the per-note rows from the working model. Re-run on any model
      // edit so the note + trailing-rest totals stay live.
      const rowsEl = modal.querySelector('#keep-sdiv-rows');
      const renderPer = () => {
        rowsEl.innerHTML = '';
        let noteNum = 0;
        model.forEach((entry, idx) => {
          const row = document.createElement('div');
          if (entry.kind === 'note') {
            noteNum++;
            const next = model[idx + 1];
            const hasRest = !!(next && next.kind === 'rest');
            // Total = this note's size + the rest immediately following it
            // (the span until the next note begins).
            const total = entry.sub + (hasRest ? next.sub : 0);
            row.className = 'keep-sdiv-row';
            // Single notes get an editable pitch dropdown; chords / runs show
            // their composite name and are left as-is.
            const nameHtml = entry.isSingle
              ? `<span class="keep-sdiv-num">${noteNum}.</span>` +
                `<select class="keep-sdiv-pitch sm-select" title="Change this note's pitch">${pitchOptsFor(entry.freq, entry.label)}</select>`
              : `<span class="keep-sdiv-name">${noteNum}. ${_stepName(entry.step)}</span>`;
            row.innerHTML =
              nameHtml +
              `<select class="keep-sdiv-sel sm-select">${optionsFor(entry.sub)}</select>` +
              `<span class="keep-sdiv-total" title="This note + the rest after it = time until the next note">→ ${_divReadout(total)}</span>` +
              `<button type="button" class="keep-sdiv-addrest" title="Add a rest after this note"${hasRest ? ' disabled' : ''}>+ rest</button>`;
            const pitchSel = row.querySelector('.keep-sdiv-pitch');
            if (pitchSel) pitchSel.addEventListener('change', (e) => {
              const f = parseFloat(e.target.value);
              if (!Number.isFinite(f)) return;
              const opt = e.target.selectedOptions && e.target.selectedOptions[0];
              entry.freq = f;
              if (opt && opt.dataset.label) entry.label = opt.dataset.label;
              const gi = (typeof _findCellIdxForFreq === 'function') ? _findCellIdxForFreq(f) : -1;
              entry.cellIndex = (gi >= 0) ? gi : null;
            });
            row.querySelector('.keep-sdiv-sel').addEventListener('change', (e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) { entry.sub = v; renderPer(); }
            });
            row.querySelector('.keep-sdiv-addrest').addEventListener('click', () => {
              model.splice(idx + 1, 0, { kind: 'rest', sub: 0.5 });
              renderPer();
            });
          } else {
            row.className = 'keep-sdiv-row keep-sdiv-rest';
            row.innerHTML =
              `<span class="keep-sdiv-name">↳ rest</span>` +
              `<select class="keep-sdiv-sel sm-select">${optionsFor(entry.sub)}</select>` +
              `<span class="keep-sdiv-total"></span>` +
              `<button type="button" class="keep-sdiv-delrest" title="Remove this rest">×</button>`;
            row.querySelector('.keep-sdiv-sel').addEventListener('change', (e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) { entry.sub = v; renderPer(); }
            });
            row.querySelector('.keep-sdiv-delrest').addEventListener('click', () => {
              model.splice(idx, 1); renderPer();
            });
          }
          rowsEl.appendChild(row);
        });
      };
      renderPer();

      // Tab switch.
      modal.querySelectorAll('.keep-sdiv-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const mode = tab.dataset.mode;
          modal.querySelectorAll('.keep-sdiv-tab').forEach(t => t.classList.toggle('active', t === tab));
          modal.querySelectorAll('.keep-sdiv-body').forEach(b => { b.hidden = (b.dataset.body !== mode); });
        });
      });

      // Preview the configured rhythm without committing. Press toggles
      // play / stop; the Loop button repeats it until turned off.
      const previewBtn = modal.querySelector('.keep-sdiv-preview');
      if (previewBtn) previewBtn.addEventListener('click', () => {
        if (_previewActive) _stopPreview();
        else previewKeepModel();
      });
      const loopBtn = modal.querySelector('.keep-sdiv-loop');
      if (loopBtn) loopBtn.addEventListener('click', () => {
        _previewLoop = !_previewLoop;
        loopBtn.classList.toggle('active', _previewLoop);
        loopBtn.setAttribute('aria-pressed', _previewLoop ? 'true' : 'false');
      });

      // All-notes mode: one size applied to every kept note.
      modal.querySelectorAll('.keep-sdiv-body[data-body="all"] .sdiv-opt').forEach(b => {
        b.addEventListener('click', () => {
          const v = parseFloat(b.dataset.sub);
          if (!Number.isFinite(v) || v <= 0) return;
          _stopPreview();
          if (typeof snapshotForUndo === 'function') snapshotForUndo('Keep step sizes');
          list.forEach(s => _applyStepDivToStep(s, v));
          renderSequence();
          if (typeof persistWorkspace === 'function') persistWorkspace();
          overlay.remove();
        });
      });

      // Per-note mode: write each note's size, then splice in the rests.
      const applyBtn = modal.querySelector('.keep-sdiv-apply');
      if (applyBtn) {
        applyBtn.addEventListener('click', () => {
          _stopPreview();
          if (typeof snapshotForUndo === 'function') snapshotForUndo('Keep step sizes');
          // 1) note sizes (+ pitch for single notes that were retuned)
          model.forEach(e => {
            if (e.kind !== 'note') return;
            _applyStepDivToStep(e.step, e.sub);
            if (e.isSingle && Number.isFinite(e.freq)) {
              e.step.freq = e.freq;
              if (e.label != null) e.step.label = e.label;
              e.step.cellIndex = e.cellIndex;
            }
          });
          // 2) inserted rests — each goes immediately after its preceding
          // note in the sequence. Re-find the note's index per insertion so
          // earlier splices don't throw off later ones.
          model.forEach((e, i) => {
            if (e.kind !== 'rest') return;
            let p = i - 1;
            while (p >= 0 && model[p].kind !== 'note') p--;
            if (p < 0) return;
            const seqIdx = sequence.indexOf(model[p].step);
            if (seqIdx < 0) return;
            const rest = makeRestStep();
            rest.subdivision = e.sub;
            sequence.splice(seqIdx + 1, 0, rest);
          });
          renderSequence();
          if (typeof persistWorkspace === 'function') persistWorkspace();
          overlay.remove();
        });
      }

      // Outside-click dismiss (bound next frame so the Keep-toggle click
      // that opened this can't immediately close it). Cancels any preview.
      requestAnimationFrame(() => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { _stopPreview(); overlay.remove(); } });
      });
    }

