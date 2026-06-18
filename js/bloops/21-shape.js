    // ============================================================
    // 21-shape.js — "Shape" mode: a radial wheel step-sequencer
    // ============================================================
    // The eighth per-lane mode (Grid → Graph → Game → Prog → Bloom → TEXT →
    // Seq → Shape). A polygon on a clock face: 360° = 1 bar, 12 o'clock (True
    // North) = the downbeat, clockwise. Each corner NODE is a timed hit — its
    // angle is its position in the bar — so a shape's node count sets its
    // rhythm (4 nodes = 4 hits/bar; different lanes with different counts =
    // polyrhythms). One shape per lane.
    //
    // Status: S0–S4 shipped — scaffold + canvas (S0); click-mute / drag-retime
    // (Equal locks, Free/Snap) + Tone/Note/Gate + audition Spin with sweeping
    // playhead + node lighting (S1/S2); record-to-lane accumulative overdub
    // (S1b); Mix "Master Shape" concentric overview + Play-all + click-to-edit
    // (S3); scale Spray / Flat + per-node pitch (wheel-scroll) + pitch labels
    // (S4). Touch works via pointer events.
    //
    // DEFERRED SHAPE TO-DOs (tabled — revisit on "any ToDos?"):
    //  - Sync the wheel/master playhead to the GLOBAL transport (no easy
    //    is-playing flag today; Spin / Play-all cover audition). Would let the
    //    wheel visualize in time when the main Play runs.
    //  - Full per-node Sound Editor override (per-node PITCH is done via
    //    wheel-scroll; per-node tone/ADSR/FX is the heavier follow-up — store a
    //    cellParams-like object on node.override and use it in trigger/record).
    //  - Snap-mode subdivision picker UI (snapDiv exists in the model; no
    //    control yet). Add/remove individual nodes in Free mode (count control
    //    redistributes equally today).
    //  - Tidy: hide the Grid-only GEN/WRAP/PERF/KEEP bars while in Shape mode.

    // ---- Data model --------------------------------------------------------
    // The grid's current default voice type — snapshotted into a shape so each
    // shape OWNS its voice (multiple master shapes stay distinct) instead of all
    // deferring to one shared global that the latest pick overwrites.
    function _shapeGridVoiceType() {
      return (typeof cellParams !== 'undefined' && cellParams[0] && cellParams[0].type) || 'sine';
    }
    // ---- Time grid (divisions per bar) -------------------------------------
    // The chosen grid governs BOTH the Rotate increment (360°/div per tick) AND
    // Snap-mode node placement, so rotation and node snapping never cross-rhythm
    // against each other. 360° = 1 bar (4 beats): /4 = 1/4 note, /8 = 1/8, /16 =
    // 1/16, /12 = 1/8 triplet, /24 = 1/16 triplet, etc.
    const _SHAPE_GRIDS = [
      { div: 4,  name: '1/4 note' },
      { div: 6,  name: '1/4 triplet' },
      { div: 8,  name: '1/8 note' },
      { div: 12, name: '1/8 triplet' },
      { div: 16, name: '1/16 note' },
      { div: 24, name: '1/16 triplet' },
      { div: 32, name: '1/32 note' },
    ];
    function _shapeRotStepDeg(cfg) {
      const d = Math.max(1, (cfg && Number.isFinite(cfg.snapDiv)) ? cfg.snapDiv : 16);
      return Math.round((360 / d) * 1000) / 1000;
    }
    // Snap a degree value to the current grid (and wrap into 0–360).
    function _shapeSnapRot(v, cfg) {
      const step = _shapeRotStepDeg(cfg);
      let r = Math.round((parseFloat(v) || 0) / step) * step;
      r = ((r % 360) + 360) % 360;
      return Math.round(r * 100) / 100;
    }
    function _shapeDefault() {
      return {
        nodeCount: 4,
        timingMode: 'equal',   // 'equal' (locked even) | 'free' (drag anywhere) | 'snap'
        snapDiv: 16,           // snap subdivisions per bar (timingMode 'snap')
        rotationDeg: 0,        // whole-wheel phase offset (off-beat)
        loopBeats: 4,          // musical length of one revolution (4 = one bar)
        tone: _shapeGridVoiceType(), // this shape's own voice (snapshot of the grid voice)
        soundParams: null,     // full per-shape voice params (env/fx) when sound-edited; null = {type:tone}
        baseNote: null,        // default pitch for nodes (null = grid default)
        progression: null,     // { name, chords:[{root,intervals}] } → nodes play chords clockwise
        gatePct: 80,           // note length as a % of the gap to the next node
        // nodes carry their bar position (0..1, 0 = downbeat) + mute + optional
        // per-node override (pitch / sound params, set via the Sound Editor).
        nodes: [
          { angleFrac: 0,    muted: false },
          { angleFrac: 0.25, muted: false },
          { angleFrac: 0.5,  muted: false },
          { angleFrac: 0.75, muted: false },
        ],
      };
    }
    function _shapeEqualNodes(n, prev) {
      n = Math.max(1, Math.min(32, n | 0));
      const out = [];
      for (let i = 0; i < n; i++) {
        const old = prev && prev[i];
        out.push({
          angleFrac: i / n,
          muted: old ? !!old.muted : false,
          override: old && old.override,
          // Carry a manually-tweaked chord forward; new nodes (no `old`) get no
          // manual chord, so they fall through to the progression mapping by
          // their clockwise index — i.e. the progression repeats forward.
          chord: (old && old.chord) || null,
          sustainFrac: (old && Number.isFinite(old.sustainFrac)) ? old.sustainFrac : null,
        });
      }
      return out;
    }
    function _shapeNormalize(s) {
      const d = _shapeDefault();
      if (!s || typeof s !== 'object') return d;
      if (!Number.isFinite(s.nodeCount)) s.nodeCount = d.nodeCount;
      s.nodeCount = Math.max(1, Math.min(32, s.nodeCount | 0));
      if (['equal', 'free', 'snap'].indexOf(s.timingMode) < 0) s.timingMode = d.timingMode;
      if (!Number.isFinite(s.snapDiv)) s.snapDiv = d.snapDiv;
      if (!Number.isFinite(s.rotationDeg)) s.rotationDeg = d.rotationDeg;
      s.rotationDeg = ((s.rotationDeg % 360) + 360) % 360;
      if (!Number.isFinite(s.loopBeats) || s.loopBeats <= 0) s.loopBeats = d.loopBeats;
      // Each shape owns a concrete voice. Legacy shapes saved with '' (follow
      // grid) collapsed onto one shared global voice, so multiple master shapes
      // all played the latest pick — freeze '' to the current grid voice ONCE so
      // they become independent (the user can then re-pick each via Tone).
      if (typeof s.tone !== 'string' || !s.tone) s.tone = _shapeGridVoiceType();
      if (s.soundParams && typeof s.soundParams !== 'object') s.soundParams = null;
      if (s.progression && !(s.progression.chords && Array.isArray(s.progression.chords) && s.progression.chords.length)) s.progression = null;
      if (!Number.isFinite(s.gatePct)) s.gatePct = d.gatePct;
      if (!Array.isArray(s.nodes) || !s.nodes.length) s.nodes = _shapeEqualNodes(s.nodeCount);
      // Normalize each node IN PLACE so node objects keep their identity across
      // calls — transient render state (_flash) and per-node refs survive (the
      // playhead lighting depends on this). .filter keeps the same element refs.
      s.nodes = s.nodes.filter(nd => nd && typeof nd === 'object');
      if (!s.nodes.length) s.nodes = _shapeEqualNodes(s.nodeCount);
      s.nodes.forEach(nd => {
        nd.angleFrac = ((Number.isFinite(nd.angleFrac) ? nd.angleFrac : 0) % 1 + 1) % 1;
        nd.muted = !!nd.muted;
        nd.chordOff = !!nd.chordOff;
        if (nd.chord && !(Array.isArray(nd.chord.intervals) && nd.chord.intervals.length)) nd.chord = null;
        if (nd.sustainFrac != null && !(Number.isFinite(nd.sustainFrac) && nd.sustainFrac > 0)) nd.sustainFrac = null;
        // Set-node variance pool: drop if malformed; a 1-note pool is just a
        // plain note, so collapse it (keeps the wheel honest).
        if (nd.variance && !(Array.isArray(nd.variance.notes) && nd.variance.notes.length > 1)) nd.variance = null;
      });
      // Keep nodeCount and nodes.length in agreement.
      if (s.nodes.length !== s.nodeCount) {
        if (s.timingMode === 'equal') s.nodes = _shapeEqualNodes(s.nodeCount, s.nodes);
        else s.nodeCount = s.nodes.length;
      }
      return s;
    }
    // ---- Master Shapes: a persisted collection of independent shape COPIES ---
    // "Send" snapshots a lane's wheel into masterShapes; one copy is active at a
    // time (newest send wins). Browse / select / delete in Mix ▸ Shapes; edit
    // the active copy with the full wheel editor (the lane's #shape-pad is
    // reparented into the Mix pane during edit). Declared here — referenced by
    // 11/14 persistence — mirroring how masterAmbient is shared.
    let masterShapes = [];
    let activeMasterShapeId = null;
    let _shapeMasterIdSeq = 1;       // monotonic id source for copies
    let _shapeEditTarget = null;     // synthetic lane while editing a copy (else null)
    let _shapeMasterEditId = null;   // id of the copy currently open in the editor
    let _shapePadHome = null;        // { parent, next } to restore #shape-pad after edit
    function _shapeLane() {
      // While editing a master-shape copy, the whole editor binds to a synthetic
      // lane wrapping that copy — so every existing control edits the copy with
      // zero changes. Outside an edit session this is the real active lane.
      if (_shapeEditTarget) return _shapeEditTarget;
      return (typeof lanes !== 'undefined' && typeof activeLaneIdx !== 'undefined') ? lanes[activeLaneIdx] : null;
    }
    // Ensure the active lane has a normalized shape config; returns it (or null).
    function _shapeCfg() {
      const lane = _shapeLane();
      if (!lane) return null;
      if (!lane.shape || typeof lane.shape !== 'object') lane.shape = _shapeDefault();
      return _shapeNormalize(lane.shape);
    }

    // ====================================================================
    // Trans-mode lane: lane.steps is the single source of truth for the
    // musical content; the Shape wheel is a VIEW that reconstructs from it.
    //  - Entering Shape (or switching lane in Shape): rebuild the wheel from
    //    steps ONLY if the steps changed since the wheel was last in sync —
    //    so a hand-built wheel survives untouched when you didn't edit notes
    //    elsewhere. View-settings (rotation / gate / voice) are preserved.
    //  - Editing the wheel: fold the change back into steps (debounced) so
    //    Grid/Graph/transport/etc. all see it. We only write when the wheel
    //    was actually edited (_shapeWheelDirty), never on a passive view —
    //    so opening a shape never mutates the sequence.
    // ====================================================================
    let _shapeWheelDirty = false;       // user edited the wheel since last sync
    let _shapeFlushTimer = null;
    let _shapeRunGid = 1;               // unique id source for Run wrap-groups
    // Mark + schedule together so it's independent of whether the caller draws
    // before or after marking (edit handlers vary in order).
    function _shapeMarkEdit() { _shapeWheelDirty = true; _shapeScheduleFlush(); }
    // Cheap content fingerprint: notes + chords + timing (ignores pure view).
    function _stepsFingerprint(steps) {
      if (!Array.isArray(steps)) return '0';
      return steps.map(s => {
        if (!s) return '_';
        const t = ':' + (s.duration != null ? s.duration : 1) + 'x' + (s.subdivision != null ? s.subdivision : 1);
        if (Array.isArray(s.chord)) return 'C' + s.chord.map(v => Math.round((v && v.freq) || 0)).join(',') + t;
        if (s.isSub && Array.isArray(s.subSteps)) return 'S' + s.subSteps.map(x => Math.round((x && x.freq) || 0)).join(',') + t;
        if (s.freq == null) return 'R' + t;
        return 'N' + Math.round(s.freq) + t;
      }).join('|');
    }
    // Pure control-surface settings to carry across a steps→wheel rebuild.
    function _shapeViewOf(shape) {
      if (!shape) return null;
      return {
        rotationDeg: shape.rotationDeg, gatePct: shape.gatePct,
        tone: shape.tone, soundParams: shape.soundParams ? JSON.parse(JSON.stringify(shape.soundParams)) : null,
      };
    }
    function _shapeApplyView(shape, v) {
      if (!shape || !v) return;
      if (Number.isFinite(v.rotationDeg)) shape.rotationDeg = ((v.rotationDeg % 360) + 360) % 360;
      if (Number.isFinite(v.gatePct)) shape.gatePct = v.gatePct;
      if (typeof v.tone === 'string' && v.tone) shape.tone = v.tone;
      if (v.soundParams) shape.soundParams = JSON.parse(JSON.stringify(v.soundParams));
    }
    // Rebuild the lane's wheel from its steps when the steps changed elsewhere.
    function _shapeMaybeDeriveFromSteps(lane) {
      if (!lane || _shapeEditTarget) return;          // master-copy edit uses its own data
      const steps = Array.isArray(lane.steps) ? lane.steps : [];
      const fp = _stepsFingerprint(steps);
      // Empty lane: there's nothing to reconstruct from, and deriving from no
      // steps would collapse loopBeats to ~1 (total falls back to 1), cramming
      // the whole wheel into a single beat — far too fast. Keep the current
      // (default 4-beat) wheel and just adopt the fingerprint.
      if (!steps.length) { lane._shapeStepsFp = fp; _shapeWheelDirty = false; return; }
      // First encounter on a lane that already has a HAND-BUILT wheel: adopt the
      // current state without rebuilding, so existing shapes aren't clobbered.
      if (lane._shapeStepsFp == null) {
        const cur = lane.shape ? _shapeNormalize(lane.shape) : null;
        if (cur && _shapeIsCustomized(cur)) { lane._shapeStepsFp = fp; _shapeWheelDirty = false; return; }
      } else if (lane._shapeStepsFp === fp && lane.shape) {
        return;                                       // steps unchanged → keep the wheel exactly
      }
      const view = _shapeViewOf(lane.shape);
      const derived = _shapeSeqToShape(steps);
      _shapeApplyView(derived, view);
      lane.shape = derived;
      lane._shapeStepsFp = fp;
      _shapeWheelDirty = false;
    }
    // Fold wheel edits back into the lane's steps (the canonical content).
    function _shapeScheduleFlush() {
      if (_shapeEditTarget || _shapeRecording || !_shapeWheelDirty) return;
      const lane = (typeof lanes !== 'undefined' && typeof activeLaneIdx !== 'undefined') ? lanes[activeLaneIdx] : null;
      if (!lane || !lane.shapeMode) return;
      clearTimeout(_shapeFlushTimer);
      _shapeFlushTimer = setTimeout(_shapeFlushNow, 140);
    }
    function _shapeFlushNow() {
      clearTimeout(_shapeFlushTimer); _shapeFlushTimer = null;
      if (_shapeEditTarget || _shapeRecording || !_shapeWheelDirty) return;
      const lane = (typeof lanes !== 'undefined' && typeof activeLaneIdx !== 'undefined') ? lanes[activeLaneIdx] : null;
      if (!lane || !lane.shapeMode || !lane.shape) return;
      const out = _shapeCompileSteps(_shapeNormalize(lane.shape));
      const fp = _stepsFingerprint(out);
      _shapeWheelDirty = false;
      if (fp === lane._shapeStepsFp) return;          // nothing actually changed
      lane.steps = out;
      lane._shapeStepsFp = fp;
      if (lane === lanes[activeLaneIdx] && typeof _aliasSequenceToActiveLane === 'function') {
        try { _aliasSequenceToActiveLane(); } catch (e) {}
      }
      try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
      // A wheel-built sequence should be saveable just like a grid-built one.
      try {
        const sb = document.getElementById('save-btn');
        if (sb && typeof sequence !== 'undefined' && Array.isArray(sequence)) sb.disabled = sequence.length === 0;
      } catch (e) {}
    }

    // ---- Canvas geometry + drawing -----------------------------------------
    let _shapeInited = false;
    let _shapeCanvas = null, _shapeCtx = null;
    let _shapeSpin = { running: false, raf: 0, t0: 0, lastPhase: 0 };
    // A node's screen position. angle 0 = top (12 o'clock), clockwise; the
    // wheel's rotation adds a phase offset.
    function _shapeNodeXY(cx, cy, R, angleFrac, rotFrac) {
      const a = 2 * Math.PI * (((angleFrac + rotFrac) % 1 + 1) % 1);
      return { x: cx + R * Math.sin(a), y: cy - R * Math.cos(a) };
    }
    function _shapeResize() {
      if (!_shapeCanvas) return;
      const stage = document.getElementById('shape-stage');
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const side = Math.max(120, Math.min(rect.width, rect.height) - 4);
      const dpr = Math.min(2, window.devicePixelRatio || 1);   // cap: iOS white-boxes over-large canvas backing stores
      _shapeCanvas.style.width = side + 'px';
      _shapeCanvas.style.height = side + 'px';
      _shapeCanvas.width = Math.round(side * dpr);
      _shapeCanvas.height = Math.round(side * dpr);
      if (_shapeCtx) _shapeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // Cached geometry from the last draw, so pointer hit-testing matches.
    let _shapeGeo = { cx: 0, cy: 0, R: 0 };
    function _shapeDraw(phase) {
      if (!_shapeCtx || !_shapeCanvas) return;
      const cfg = _shapeCfg();
      const W = _shapeCanvas.width / (window.devicePixelRatio || 1);
      const H = _shapeCanvas.height / (window.devicePixelRatio || 1);
      const ph = (typeof phase === 'number') ? phase : (_shapeSpin.running ? _shapeSpin.lastPhase : 0);
      const geo = _shapeDrawCore(_shapeCtx, W, H, cfg, ph, { mini: false });
      if (geo) _shapeGeo = geo;   // editor hit-testing reads this
    }
    // Render a wheel into ANY 2D context (the editor canvas or a small card
    // preview). Returns { cx, cy, R }. `opts.mini` shrinks margins / node radius
    // and drops the text labels so it reads at thumbnail size. Pure drawing —
    // no module-canvas globals — so it's reusable by the Bloom Shape layer's
    // in-card preview (_shapeRenderTo).
    function _shapeDrawCore(ctx, W, H, cfg, ph, opts) {
      opts = opts || {};
      const mini = !!opts.mini;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const margin = mini ? Math.max(7, Math.min(W, H) * 0.16) : 26;
      const R = Math.min(W, H) / 2 - margin;
      const baseNodeR = mini ? Math.max(2.5, R * 0.16) : 9;
      // Outer guide ring.
      ctx.strokeStyle = 'rgba(120,120,160,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
      if (!cfg || !Array.isArray(cfg.nodes)) return { cx, cy, R };
      const rotFrac = (cfg.rotationDeg || 0) / 360;
      const pts = cfg.nodes.map(nd => Object.assign({ nd }, _shapeNodeXY(cx, cy, R, nd.angleFrac, rotFrac)));
      // Bar-grid spokes: a faint radial tick at each 4-beat bar boundary within
      // the revolution, so a multi-bar wheel (loopBeats > 4) visibly shows where
      // its bars fall — the demarcation a linear lane lacks. Aligned to the
      // playhead frame (12 o'clock = the downbeat), independent of node rotation.
      {
        const lb = _shapeLoopBeats(cfg);
        for (let beat = 4; beat < lb - 0.01; beat += 4) {
          const ang = 2 * Math.PI * (beat / lb) - Math.PI / 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + R * Math.cos(ang), cy + R * Math.sin(ang));
          ctx.strokeStyle = 'rgba(159,122,234,0.20)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      // Sweeping playhead at the current bar phase (12 o'clock = phase 0).
      {
        const pa = 2 * Math.PI * (((ph % 1) + 1) % 1);
        ctx.strokeStyle = 'rgba(79,209,197,0.55)';
        ctx.lineWidth = mini ? 1.5 : 2;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.sin(pa), cy - R * Math.cos(pa)); ctx.stroke();
      }
      // Polygon (transparent fill) through nodes in draw order.
      if (pts.length >= 2) {
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
        ctx.fillStyle = 'rgba(159,122,234,0.07)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(159,122,234,0.65)';
        ctx.lineWidth = mini ? 1 : 1.5;
        ctx.stroke();
      }
      // Sustain arcs — each node holds for sustainFrac of the bar, drawn as a
      // clockwise arc along the ring from the node's angle (12 o'clock = 0).
      // Long held notes read as long arcs; staccato as short stubs.
      cfg.nodes.forEach(nd => {
        const sf = Number.isFinite(nd.sustainFrac) ? nd.sustainFrac : 0;
        if (sf <= 0 || nd.muted) return;
        const aStart = 2 * Math.PI * (((nd.angleFrac + rotFrac) % 1 + 1) % 1) - Math.PI / 2;
        const aEnd = aStart + 2 * Math.PI * Math.min(0.999, sf);
        ctx.beginPath();
        ctx.arc(cx, cy, R, aStart, aEnd, false);
        ctx.strokeStyle = 'rgba(79,209,197,0.45)';
        ctx.lineWidth = mini ? 2.5 : 4; ctx.lineCap = 'round';
        ctx.stroke();
      });
      ctx.lineCap = 'butt';
      // Center point.
      ctx.fillStyle = 'rgba(203,213,224,0.8)';
      ctx.beginPath(); ctx.arc(cx, cy, mini ? 2 : 3, 0, 2 * Math.PI); ctx.fill();
      // Corner nodes. (No "recently struck" white grow-and-shrink flash: it read
      // a _flash timestamp left on the shared node data and replayed every time a
      // wheel was drawn, so shapes appeared to bloom white and shrink into place
      // instead of just showing. The sweeping playhead line is the play indicator.)
      let idxOf; try { idxOf = _shapeSortedEff(cfg).idxOf; } catch (e) { idxOf = new Map(); }
      pts.forEach((p) => {
        const flash = 0;
        const rad = baseNodeR;
        const chord = _shapeNodeChord(cfg, p.nd, idxOf.get(p.nd));
        // Wrap-type cues: chord (stack) = orange, Set (variance) = purple,
        // Run-group member = blue. A single plain note stays teal.
        const isSet = !chord && !!(p.nd.variance && p.nd.variance.notes && p.nd.variance.notes.length);
        const isRun = !chord && !isSet && !!(p.nd.wrapGroup && p.nd.wrapType === 'run');
        // Chord / Set nodes get an outer halo ring so they read as "more than a note".
        if ((chord || isSet) && !p.nd.muted) {
          ctx.beginPath(); ctx.arc(p.x, p.y, rad + (mini ? 2 : 4), 0, 2 * Math.PI);
          ctx.strokeStyle = isSet ? 'rgba(159,122,234,0.9)' : 'rgba(246,173,85,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 2 * Math.PI);
        if (p.nd.muted) {
          ctx.fillStyle = 'rgba(40,40,60,0.9)'; ctx.fill();
          ctx.strokeStyle = 'rgba(120,120,150,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
        } else {
          ctx.fillStyle = flash > 0 ? '#ffffff' : (chord ? '#f6ad55' : isSet ? '#9f7aea' : isRun ? '#63b3ed' : '#4fd1c5'); ctx.fill();
          ctx.strokeStyle = flash > 0 ? 'rgba(79,209,197,0.9)' : 'rgba(13,13,24,0.9)';
          ctx.lineWidth = mini ? 1.5 : 2; ctx.stroke();
        }
        // Label outside the node (full size only): chord name when chorded,
        // else pitch when tuned off the base note.
        if (!mini && !p.nd.muted) {
          const a = 2 * Math.PI * (((p.nd.angleFrac + rotFrac) % 1 + 1) % 1);
          let lbl = '';
          if (chord) lbl = _shapeChordLabel(chord);
          else { const off = _shapeNodeOffset(p.nd); if (off !== 0) lbl = _shapeNoteName((Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60) + off); }
          if (lbl) {
            ctx.fillStyle = chord ? 'rgba(246,173,85,0.95)' : 'rgba(203,213,224,0.9)';
            ctx.font = '10px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(lbl, p.x + Math.sin(a) * 18, p.y - Math.cos(a) * 18);
          }
        }
      });
      return { cx, cy, R };
    }
    // Render a wheel into any canvas at its CSS size (DPR-aware). Used by the
    // Bloom Shape layer's in-card live previews. `ph` = current bar phase (0..1).
    function _shapeRenderTo(canvas, cfg, ph) {
      if (!canvas) return;
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);   // cap: iOS white-boxes over-large canvas backing stores
      const cssW = canvas.clientWidth || parseInt(canvas.getAttribute('width'), 10) || 72;
      const cssH = canvas.clientHeight || parseInt(canvas.getAttribute('height'), 10) || 72;
      const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      _shapeDrawCore(ctx, cssW, cssH, cfg, (typeof ph === 'number') ? ph : 0, { mini: true });
    }
    // Palette for overlaid wheels (one colour per shape in a Bloom Shape layer).
    const _SHAPE_OVERLAY_PAL = ['#4fd1c5', '#9f7aea', '#f6ad55', '#63b3ed', '#fc8181', '#68d391', '#f687b3', '#fbd38d'];
    function _shapeOverlayColor(i) { return _SHAPE_OVERLAY_PAL[((i % _SHAPE_OVERLAY_PAL.length) + _SHAPE_OVERLAY_PAL.length) % _SHAPE_OVERLAY_PAL.length]; }
    // Draw MANY wheels superimposed concentrically on one canvas, auto-sized so
    // every node fits (the outermost ring leaves room for the node circles).
    // Each shape gets its own colour + playhead (its own bar phase). opts:
    //   { phaseOf(i)->0..1, selIdx } — selIdx brightens that shape's playhead.
    // Used by the Bloom Shape layer's in-card overview.
    function _shapeRenderOverlay(canvas, shapes, opts) {
      if (!canvas) return;
      const ctx = canvas.getContext && canvas.getContext('2d'); if (!ctx) return;
      opts = opts || {};
      const dpr = Math.min(2, window.devicePixelRatio || 1);   // cap: iOS white-boxes over-large canvas backing stores
      const cssW = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || parseInt(canvas.getAttribute('width'), 10) || 160;
      const cssH = canvas.clientHeight || canvas.parentElement && canvas.parentElement.clientHeight || parseInt(canvas.getAttribute('height'), 10) || 160;
      const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const list = Array.isArray(shapes) ? shapes.filter(s => s && Array.isArray(s.nodes)) : [];
      const cx = cssW / 2, cy = cssH / 2;
      if (!list.length) return;
      const nodeR = 6, margin = nodeR + 9;
      const Rmax = Math.max(18, Math.min(cssW, cssH) / 2 - margin);
      const Rmin = Rmax * 0.42;
      const N = list.length;
      list.forEach((sh, i) => {
        const R = (N <= 1) ? Rmax : (Rmax - (i / (N - 1)) * (Rmax - Rmin));
        const color = _shapeOverlayColor(i);
        const ph = (typeof opts.phaseOf === 'function') ? (opts.phaseOf(i) || 0) : 0;
        const pa = 2 * Math.PI * (((ph % 1) + 1) % 1);
        const sel = (opts.selIdx === i);
        ctx.strokeStyle = _shapeRgba(color, sel ? 0.75 : 0.30); ctx.lineWidth = sel ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.sin(pa), cy - R * Math.cos(pa)); ctx.stroke();
        _shapeDrawWheelAt(ctx, cx, cy, R, sh, color, true);   // noFlash: static nodes in the overview
      });
      ctx.fillStyle = 'rgba(203,213,224,0.85)'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fill();
    }
    // Compact chord name (root + quality suffix) for node labels.
    function _shapeChordLabel(chord) {
      const names = (typeof CHROMATIC !== 'undefined') ? CHROMATIC : ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      const root = names[(((chord.root | 0) % 12) + 12) % 12] || '';
      const q = _shapeQualityFromIntervals(chord.intervals);
      const suffix = (q === 'maj') ? '' : (q === 'min' ? 'm' : q);
      return root + suffix;
    }

    // ---- Audio: audition spin (live wheel) ---------------------------------
    // Seconds for one wheel revolution. A shape spans `loopBeats` musical beats
    // (default 4 = one bar). "Send to Shape" sets loopBeats to the lane's true
    // length so a multi-bar lane maps to one revolution at its real tempo,
    // instead of being crammed into a single 4-beat bar.
    function _shapeLoopBeats(cfg) {
      return (cfg && Number.isFinite(cfg.loopBeats) && cfg.loopBeats > 0) ? cfg.loopBeats : 4;
    }
    function _shapeBarSec(cfg) {
      const bpm = (typeof tempoInput !== 'undefined' && tempoInput) ? (parseInt(tempoInput.value, 10) || 120) : 120;
      return (60 / bpm) * _shapeLoopBeats(cfg);
    }
    // Human-readable position of a node (its angleFrac → bar division + beat),
    // shown in the drag readout so the user can see exactly where a node lands.
    // The wheel is one revolution = loopBeats beats; the snap grid is snapDiv
    // cells per bar. When the timing is locked (snap) we also name the grid
    // resolution and which snap step the node is on.
    function _shapeNodePosLabel(cfg, frac) {
      const lb = _shapeLoopBeats(cfg);
      const div = Math.max(1, (cfg && Number.isFinite(cfg.snapDiv)) ? (cfg.snapDiv | 0) : 16);
      const f = ((frac % 1) + 1) % 1;
      const locked = !!(cfg && cfg.timingMode === 'snap');
      const gName = (_SHAPE_GRIDS.find(g => g.div === div) || {}).name || (div + '/bar');
      const gShort = gName.replace(' note', '').replace(' triplet', 'T');
      const step = (Math.round(f * div) % div + div) % div + 1;   // 1..div
      const totalBeats = f * lb;
      const beatStr = (Math.round(((totalBeats % 4) + 1) * 100) / 100).toFixed(2);
      const barStr = (lb > 4) ? ('Bar ' + (Math.floor(totalBeats / 4) + 1) + ' · ') : '';
      return locked
        ? ('🔒 ' + gShort + ' · step ' + step + '/' + div + ' · ' + barStr + 'Beat ' + beatStr)
        : ('○ free · ' + barStr + 'Beat ' + beatStr);
    }
    function _shapeBaseFreq(cfg) {
      const m = Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60;
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      return A * Math.pow(2, (m - 69) / 12);
    }
    function _shapeToneType(cfg) {
      if (cfg.tone) return cfg.tone;
      return (typeof cellParams !== 'undefined' && cellParams[0] && cellParams[0].type) || 'sine';
    }
    function _shapeEffAngles(cfg) {
      const rotFrac = (cfg.rotationDeg || 0) / 360;
      return cfg.nodes.map(nd => ({ nd, a: (((nd.angleFrac + rotFrac) % 1) + 1) % 1 }));
    }
    // ---- Per-node pitch (override.noteOffset = semitones above baseNote) ----
    const _SHAPE_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    function _shapeNoteName(midi) {
      midi = Math.round(midi);
      return _SHAPE_NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
    }
    function _shapeNodeOffset(nd) {
      return (nd && nd.override && Number.isFinite(nd.override.noteOffset)) ? nd.override.noteOffset : 0;
    }
    // "Spray" — assign ascending scale-degree pitches around the ring (clockwise
    // from the downbeat) using the workspace scale, so a wheel plays a melody.
    function _shapeSprayScale() {
      const cfg = _shapeCfg(); if (!cfg) return;
      const intervals = (typeof SCALES !== 'undefined' && SCALES[currentScale]) ? SCALES[currentScale] : [0, 2, 4, 5, 7, 9, 11];
      const N = Math.max(1, intervals.length);
      const order = _shapeEffAngles(cfg).slice().sort((x, y) => x.a - y.a);
      order.forEach((o, deg) => {
        const semis = Math.floor(deg / N) * 12 + intervals[deg % N];
        o.nd.override = o.nd.override || {};
        o.nd.override.noteOffset = semis;
      });
      _shapeMarkEdit();
      _shapeDraw();
      _shapeReflectSprayBtn();
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    }
    function _shapeFlattenPitch() {
      const cfg = _shapeCfg(); if (!cfg) return;
      cfg.nodes.forEach(nd => { if (nd.override) nd.override.noteOffset = 0; });
      _shapeMarkEdit();
      _shapeDraw();
      _shapeReflectSprayBtn();
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    }
    function _shapeIsPitched() {
      const cfg = _shapeCfg();
      return !!(cfg && cfg.nodes.some(nd => _shapeNodeOffset(nd) !== 0));
    }
    function _shapeReflectSprayBtn() {
      const btn = document.getElementById('shape-spray-btn');
      if (!btn) return;
      const pitched = _shapeIsPitched();
      btn.textContent = pitched ? 'Flat' : 'Spray';
      btn.title = pitched
        ? 'Flatten all node pitches back to the base note'
        : 'Spray ascending scale pitches around the ring (scroll a node to fine-tune)';
    }
    // ---- Edit mode (tap a node → its Sound / Chord editor) -----------------
    let _shapeEditMode = false;
    function _shapeReflectEditBtn() {
      const b = document.getElementById('shape-edit-btn');
      if (b) { b.classList.toggle('active', !!_shapeEditMode); b.title = _shapeEditMode
        ? 'Edit mode ON — tap a node to edit its sound / chord (tap again to turn off)'
        : 'Edit mode: tap a node to open its Sound / Chord editor (instead of mute)'; }
    }

    // ---- Progression assignment (built-in + user, mapped onto nodes) -------
    // Builds the Prog <select>: None, the user's published progressions, then
    // the built-in catalog grouped by scale (current scale listed first).
    function _shapePopulateProgSelect(sel) {
      if (!sel) return;
      sel.innerHTML = '';
      const add = (val, label, parent) => { const o = document.createElement('option'); o.value = val; o.textContent = label; (parent || sel).appendChild(o); };
      add('', '— None (single notes)');
      try {
        const ups = (typeof masterAmbient !== 'undefined' && masterAmbient && Array.isArray(masterAmbient.publishedProgs)) ? masterAmbient.publishedProgs : [];
        if (ups.length) {
          const g = document.createElement('optgroup'); g.label = 'Your progressions'; sel.appendChild(g);
          ups.forEach(p => add('u:' + (p.id | 0), p.name || ('Prog ' + (p.id | 0)), g));
        }
      } catch (e) {}
      try {
        if (typeof PROGRESSIONS !== 'undefined') {
          const scales = Object.keys(PROGRESSIONS);
          const cur = (typeof currentScale === 'string' && PROGRESSIONS[currentScale]) ? currentScale : null;
          const ordered = cur ? [cur].concat(scales.filter(s => s !== cur)) : scales;
          ordered.forEach(scale => {
            const g = document.createElement('optgroup'); g.label = scale.charAt(0).toUpperCase() + scale.slice(1);
            sel.appendChild(g);
            PROGRESSIONS[scale].forEach((t, i) => add('b:' + scale + ':' + i, t.name, g));
          });
        }
      } catch (e) {}
    }
    // Resolve a Prog <select> key to { name, key, chords:[{root,intervals}] }.
    function _shapeProgFromKey(key) {
      if (!key) return null;
      try {
        if (key.indexOf('u:') === 0) {
          const id = parseInt(key.slice(2), 10);
          const ups = (typeof masterAmbient !== 'undefined' && masterAmbient && Array.isArray(masterAmbient.publishedProgs)) ? masterAmbient.publishedProgs : [];
          const p = ups.find(x => (x.id | 0) === id);
          if (p && Array.isArray(p.chords) && p.chords.length) {
            return { name: p.name || ('Prog ' + id), key, chords: p.chords.map(c => ({ root: c.root | 0, intervals: (c.intervals || []).slice() })) };
          }
          return null;
        }
        if (key.indexOf('b:') === 0) {
          const rest = key.slice(2); const li = rest.lastIndexOf(':');
          const scale = rest.slice(0, li); const idx = parseInt(rest.slice(li + 1), 10);
          const tmpl = (typeof PROGRESSIONS !== 'undefined' && PROGRESSIONS[scale]) ? PROGRESSIONS[scale][idx] : null;
          if (!tmpl) return null;
          const keyRoot = (typeof rootIdx === 'number') ? rootIdx : 0;
          const blocks = (typeof _progAutoFillProgression === 'function') ? _progAutoFillProgression(keyRoot, scale, tmpl) : [];
          const chords = (typeof _ambProgChordsFromBlocks === 'function') ? _ambProgChordsFromBlocks(blocks) : [];
          if (!chords.length) return null;
          return { name: tmpl.name, key, chords };
        }
      } catch (e) {}
      return null;
    }
    // Assign (or clear) a progression. A fresh assignment resets manual per-node
    // chord tweaks so the new progression maps cleanly; nodes then read their
    // chord by clockwise index (repeating forward as nodes are added).
    function _shapeApplyProgByKey(cfg, key) {
      if (!cfg) return;
      cfg.progression = _shapeProgFromKey(key);
      (cfg.nodes || []).forEach(nd => { nd.chord = null; nd.chordOff = false; });
    }

    // Open the full Sound Editor scoped to ONE node: its params live on
    // nd.override.params, which the editor writes in place (change-only).
    function _shapeEditNodeSound(nd, cfg) {
      if (!nd || !cfg) return;
      nd.override = nd.override || {};
      if (!nd.override.params || !nd.override.params.type) nd.override.params = Object.assign({}, _shapeNodeSound(cfg, nd));
      const freq = _shapeBaseFreq(cfg) * Math.pow(2, _shapeNodeOffset(nd) / 12);
      const ps = { label: 'Shape node', freq, params: nd.override.params, sound: nd.override.params.type };
      try { if (typeof showSoundEditor === 'function') showSoundEditor(0, { steps: [ps] }); } catch (e) {}
    }

    // Compact per-node editor popover (opened by a tap in Edit mode): mute,
    // chord (follow progression / single / custom root+quality), and a button
    // into the full Sound Editor for the node's timbre.
    function _shapeEditNode(idx) {
      const cfg = _shapeCfg(); if (!cfg) return;
      const nd = cfg.nodes[idx]; if (!nd) return;
      const hasProg = !!(cfg.progression && cfg.progression.chords && cfg.progression.chords.length);
      const persist = () => { _shapeMarkEdit(); try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {} };
      const close = () => { try { overlay.remove(); } catch (e) {} _shapeDraw(); persist(); };

      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      modal.style.maxWidth = '320px';
      const qOpts = (typeof CHORDS !== 'undefined')
        ? Object.keys(CHORDS).map(k => '<option value="' + k + '">' + (CHORDS[k].label || k) + '</option>').join('')
        : '<option value="maj">Major</option>';
      const rootOpts = (typeof CHROMATIC !== 'undefined' ? CHROMATIC : ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'])
        .map((n, i) => '<option value="' + i + '">' + n + '</option>').join('');
      const baseM0 = Number.isFinite(cfg.baseNote) ? Math.round(cfg.baseNote) : 60;
      let noteOpts = '';
      for (let m = 24; m <= 96; m++) noteOpts += '<option value="' + m + '">' + _shapeNoteName(m) + '</option>';
      const mode = nd.chordOff ? 'single' : (nd.chord ? 'custom' : (hasProg ? 'follow' : 'single'));
      // Wrap retention: Set nodes carry a variance pool (editable cycle); Run
      // nodes carry a wrapGroup tag. Surface both in the editor.
      const _v = nd.variance;
      const _hasSet = !!(_v && Array.isArray(_v.notes) && _v.notes.length);
      const _ord = _hasSet ? (_v.randomEachIter ? 'shuffle' : (_v.mode === 'backward' ? 'backward' : 'forward')) : null;
      const _ordBtn = (o, lbl) => '<button type="button" class="sm-preview snode-ord" data-ord="' + o + '" style="flex:1' + (_ord === o ? ';background:#4fd1c5;border-color:#4fd1c5;color:#08302c' : '') + '">' + lbl + '</button>';
      const _wrapSection = _hasSet
        ? '<details class="sm-fold" open><summary>Cycle (Set) — ' + _v.notes.length + ' notes</summary><div class="sm-fold-body">' +
            '<div class="sm-param-row">Order</div>' +
            '<div style="display:flex;gap:6px;margin-bottom:8px">' + _ordBtn('forward', '→') + _ordBtn('backward', '←') + _ordBtn('shuffle', '?') + '</div>' +
            '<div class="sm-param"><div class="sm-param-row">Repeats each note</div>' +
              '<input type="number" inputmode="numeric" id="snode-reps" min="1" max="64" class="sm-select" value="' + ((Number.isFinite(_v.itersPerVariant) && _v.itersPerVariant > 0) ? _v.itersPerVariant : 1) + '"></div>' +
            '<button type="button" class="sm-preview" id="snode-cycle-off" style="margin-top:8px;border-color:#a23b3b;color:#feb2b2">Stop cycling (single note)</button>' +
          '</div></details>'
        : ((nd.wrapGroup && nd.wrapType === 'run')
            ? '<div class="sm-param-row" style="color:#8a8aa8;margin:6px 0">◆ Part of a Run group — edits stay grouped and recompile back into the Run.</div>'
            : '');
      modal.innerHTML =
        '<div class="sm-title">Node ' + (idx + 1) + '</div>' +
        '<label class="sm-apply-all"><input type="checkbox" id="snode-mute"' + (nd.muted ? ' checked' : '') + ' /> Muted</label>' +
        '<details class="sm-fold" open><summary>Pitch</summary><div class="sm-fold-body">' +
          '<div class="sm-param">' +
            '<div class="sm-param-row">Note <span style="color:#6a6a88">(transposes a chord)</span></div>' +
            '<select id="snode-note" class="sm-select">' + noteOpts + '</select>' +
          '</div>' +
        '</div></details>' +
        '<details class="sm-fold" open><summary>Chord</summary><div class="sm-fold-body">' +
          '<div class="sm-param"><select id="snode-chmode" class="sm-select">' +
            (hasProg ? '<option value="follow">Follow progression</option>' : '') +
            '<option value="single">Single note</option>' +
            '<option value="custom">Custom chord</option>' +
          '</select></div>' +
          '<div class="sm-param" id="snode-custom" style="display:none">' +
            '<div class="sm-param-row">Root / Quality</div>' +
            '<div style="display:flex;gap:6px">' +
              '<select id="snode-root" class="sm-select" style="flex:0 0 70px">' + rootOpts + '</select>' +
              '<select id="snode-qual" class="sm-select" style="flex:1">' + qOpts + '</select>' +
            '</div>' +
          '</div>' +
        '</div></details>' +
        _wrapSection +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button type="button" class="sm-preview" id="snode-sound" style="flex:1">Sound editor…</button>' +
          '<button type="button" class="sm-preview" id="snode-delete" style="flex:0 0 auto;border-color:#a23b3b;color:#feb2b2" title="Remove this node from the wheel">Delete</button>' +
          '<button type="button" class="sm-apply" id="snode-done" style="flex:1">Done</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      // Backdrop-to-close, but armed on a delay: the canvas TAP that opens this
      // (a node tap in Edit mode) fires a trailing compatibility `click` at the
      // same screen point, which would otherwise land on the fresh backdrop and
      // close it instantly. Arm after a beat, and close on `pointerdown` (not
      // the synthetic click) so only a deliberate later tap dismisses it.
      setTimeout(() => {
        overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
      }, 250);

      const modeEl = modal.querySelector('#snode-chmode');
      const customWrap = modal.querySelector('#snode-custom');
      const rootEl = modal.querySelector('#snode-root');
      const qualEl = modal.querySelector('#snode-qual');
      modeEl.value = mode;
      // Seed the custom pickers from the node's chord, or the progression chord
      // it currently follows, or a plain major on the shape's base pitch class.
      let seed = nd.chord || (hasProg ? cfg.progression.chords[((_shapeSortedEff(cfg).idxOf.get(nd) || 0) % cfg.progression.chords.length)] : null);
      const baseM = Number.isFinite(cfg.baseNote) ? Math.round(cfg.baseNote) : 60;
      rootEl.value = String(seed ? (seed.root | 0) : (((baseM % 12) + 12) % 12));
      qualEl.value = seed ? _shapeQualityFromIntervals(seed.intervals) : 'maj';
      const syncCustomVis = () => { customWrap.style.display = (modeEl.value === 'custom') ? '' : 'none'; };
      syncCustomVis();

      const applyChord = () => {
        const m = modeEl.value;
        if (m === 'single') { nd.chordOff = true; nd.chord = null; }
        else if (m === 'follow') { nd.chordOff = false; nd.chord = null; }
        else { // custom
          nd.chordOff = false;
          const q = qualEl.value;
          const ivs = (typeof CHORDS !== 'undefined' && CHORDS[q]) ? CHORDS[q].semis.slice() : [0, 4, 7];
          nd.chord = { root: parseInt(rootEl.value, 10) || 0, intervals: ivs };
        }
        _shapeDraw(); persist();
      };
      modeEl.addEventListener('change', () => { syncCustomVis(); applyChord(); });
      rootEl.addEventListener('change', applyChord);
      qualEl.addEventListener('change', applyChord);
      // Note picker → the node's pitch as an absolute note, stored as a semitone
      // offset from the shape's base note (so it rides base-note changes the same
      // way wheel-scroll tuning does). For a chord node it transposes the chord.
      const noteEl = modal.querySelector('#snode-note');
      const curNote = Math.max(24, Math.min(96, baseM0 + _shapeNodeOffset(nd)));
      noteEl.value = String(curNote);
      noteEl.addEventListener('change', () => {
        nd.override = nd.override || {};
        nd.override.noteOffset = (parseInt(noteEl.value, 10) || baseM0) - baseM0;
        _shapeDraw(); _shapeReflectSprayBtn(); persist();
      });
      modal.querySelector('#snode-mute').addEventListener('change', (e) => { nd.muted = !!e.target.checked; _shapeDraw(); persist(); });
      modal.querySelector('#snode-sound').addEventListener('click', () => _shapeEditNodeSound(nd, cfg));
      const delEl = modal.querySelector('#snode-delete');
      if (delEl) {
        if (cfg.nodes.length <= 1) { delEl.disabled = true; delEl.title = 'Can\'t delete the last node'; }
        delEl.addEventListener('click', () => { _shapeDeleteNode(idx); try { overlay.remove(); } catch (e) {} _shapeDraw(); });
      }
      // Set-cycle controls: order (forward / backward / shuffle), repeats, off.
      modal.querySelectorAll('.snode-ord').forEach(btn => btn.addEventListener('click', () => {
        if (!nd.variance) return;
        const o = btn.dataset.ord;
        nd.variance.randomEachIter = (o === 'shuffle');
        nd.variance.mode = (o === 'backward') ? 'backward' : 'linear';
        modal.querySelectorAll('.snode-ord').forEach(b2 => {
          const on = b2.dataset.ord === o;
          b2.style.background = on ? '#4fd1c5' : '';
          b2.style.borderColor = on ? '#4fd1c5' : '';
          b2.style.color = on ? '#08302c' : '';
        });
        _shapeDraw(); persist();
      }));
      const repsEl = modal.querySelector('#snode-reps');
      if (repsEl) repsEl.addEventListener('change', () => {
        if (!nd.variance) return;
        nd.variance.itersPerVariant = Math.max(1, Math.min(64, parseInt(repsEl.value, 10) || 1));
        persist();
      });
      const cycOff = modal.querySelector('#snode-cycle-off');
      if (cycOff) cycOff.addEventListener('click', () => {
        nd.variance = null;             // collapse to a plain single note
        try { overlay.remove(); } catch (e) {}
        _shapeDraw(); persist();
      });
      modal.querySelector('#snode-done').addEventListener('click', close);
    }
    // Best-effort chord quality name from an interval set (for the custom picker).
    function _shapeQualityFromIntervals(intervals) {
      if (!Array.isArray(intervals) || !intervals.length || typeof CHORDS === 'undefined') return 'maj';
      const norm = (a) => Array.from(new Set(a.map(x => ((x % 12) + 12) % 12))).sort((p, q) => p - q).join(',');
      const want = norm(intervals);
      for (const k of Object.keys(CHORDS)) { if (norm(CHORDS[k].semis) === want) return k; }
      return 'maj';
    }

    // ---- Per-node / per-shape sound + chord resolution ---------------------
    // A node's effective voice params: its own Sound-Editor override wins, then
    // the shape's edited voice, then a bare {type} from the shape's tone.
    function _shapeNodeSound(cfg, nd) {
      if (nd && nd.override && nd.override.params && nd.override.params.type) return Object.assign({}, nd.override.params);
      if (cfg.soundParams && cfg.soundParams.type) return Object.assign({}, cfg.soundParams);
      return { type: _shapeToneType(cfg) };
    }
    // The chord a node plays (or null = single note): a manual per-node chord
    // wins; else the assigned progression mapped by the node's CLOCKWISE index
    // (so adding nodes simply continues the progression, repeating forward).
    function _shapeNodeChord(cfg, nd, sortedIdx) {
      if (nd && nd.chordOff) return null;   // node forced to a single note
      if (nd && nd.chord && Array.isArray(nd.chord.intervals) && nd.chord.intervals.length) return nd.chord;
      const prog = cfg.progression;
      if (prog && Array.isArray(prog.chords) && prog.chords.length && Number.isFinite(sortedIdx)) {
        return prog.chords[((sortedIdx % prog.chords.length) + prog.chords.length) % prog.chords.length] || null;
      }
      return null;
    }
    // Set node: pick the variant to play this pass and advance the node's cycle.
    // Mirrors the sequencer's variance engine (linear / backward hold for
    // itersPerVariant; shuffle/random pick freely). Returns {noteOffset, params}
    // or null when the node carries no variance pool.
    function _shapeNodeVariant(nd) {
      const v = nd && nd.variance;
      if (!v || !Array.isArray(v.notes) || !v.notes.length) return null;
      const pool = v.notes;
      let idx;
      if (v.randomEachIter || (v.mode !== 'linear' && v.mode !== 'backward')) {
        idx = Math.floor(Math.random() * pool.length);
      } else {
        nd._varCount = (nd._varCount | 0) + 1;
        const iters = Math.max(1, Math.floor(v.itersPerVariant || 1));
        let i = Math.floor((nd._varCount - 1) / iters) % pool.length;
        if (v.mode === 'backward') i = pool.length - 1 - i;
        idx = i;
      }
      return pool[idx] || pool[0];
    }
    // Absolute frequencies for a chord {root(pc), intervals[semis]} anchored in
    // the shape's base octave, transposed by the node's pitch offset.
    function _shapeChordFreqs(cfg, nd, chord) {
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const baseM = Number.isFinite(cfg.baseNote) ? Math.round(cfg.baseNote) : 60;
      const basePc = ((baseM % 12) + 12) % 12;
      const rootM = (baseM - basePc) + (((chord.root | 0) % 12) + 12) % 12;
      const off = _shapeNodeOffset(nd);
      return chord.intervals.map(iv => A * Math.pow(2, (rootM + iv + off - 69) / 12));
    }
    // Effective angles + each node's clockwise index (for progression mapping).
    function _shapeSortedEff(cfg) {
      const eff = _shapeEffAngles(cfg);
      const order = eff.slice().sort((x, y) => x.a - y.a);
      const idxOf = new Map();
      order.forEach((o, i) => idxOf.set(o.nd, i));
      return { eff, sortedAngles: order.map(o => o.a), idxOf };
    }
    // Are a Run group's nodes still contiguous in angle order (so they recompile
    // into ONE Run step)? False when a non-member sits between them — matching
    // how _shapeCompileSteps re-collects consecutive members.
    function _shapeRunGroupContiguous(cfg, gid) {
      if (gid == null || !cfg || !Array.isArray(cfg.nodes)) return true;
      const flags = cfg.nodes.slice()
        .map(nd => ({ nd, a: (((nd.angleFrac % 1) + 1) % 1) }))
        .sort((x, y) => x.a - y.a)
        .map(o => o.nd.wrapGroup === gid && o.nd.wrapType === 'run');
      if (flags.filter(Boolean).length < 2) return true;
      const first = flags.indexOf(true), last = flags.lastIndexOf(true);
      for (let i = first; i <= last; i++) if (!flags[i]) return false;
      return true;
    }
    // Pure resolver: given a node + its angle context, return { voices:[{freq,
    // params}], durMs } WITHOUT emitting — the gap→duration, voice, chord, and
    // Set-variant logic shared by the live wheel (_shapeTriggerNode) and the
    // Bloom Shape layer (_ambEmitShape). NOTE it advances a Set node's cycle
    // (via _shapeNodeVariant), so call it exactly once per intended trigger.
    function _shapeResolveNodeEvent(cfg, nd, a, sortedAngles, sortedIdx) {
      let next = null;
      for (let i = 0; i < sortedAngles.length; i++) { if (sortedAngles[i] > a + 1e-6) { next = sortedAngles[i]; break; } }
      if (next == null) next = (sortedAngles[0] != null ? sortedAngles[0] : a) + 1;
      const gap = Math.max(0.02, next - a);
      const barMs = _shapeBarSec(cfg) * 1000;
      // Per-node sustain (set when a sequence is converted to a shape) holds the
      // note for its OWN length (a fraction of the bar), drawn as a ring arc.
      // Falls back to the shape-level gate (% of the gap to the next node).
      const durMs = (Number.isFinite(nd.sustainFrac) && nd.sustainFrac > 0)
        ? Math.max(40, nd.sustainFrac * barMs)
        : Math.max(40, gap * barMs * (Math.max(5, cfg.gatePct) / 100));
      const sound = _shapeNodeSound(cfg, nd);
      // Bare grid-voice notes carry no envelope, so playNote applies its long
      // 1400ms default release — every wheel hit then rings ~1.4s regardless of
      // gate. On a busy wheel (often many nodes at the SAME pitch) those tails
      // pile up and a pure sine sums coherently into pops. Give such notes a
      // release that fits the note length so each hit decays within its slot.
      // Voices with an explicit envelope (per-node / shape Sound Editor) are
      // left exactly as authored.
      if (sound.release == null) {
        sound.attack  = Number.isFinite(sound.attack)  ? sound.attack  : 5;
        sound.decay   = Number.isFinite(sound.decay)   ? sound.decay   : 40;
        sound.sustain = Number.isFinite(sound.sustain) ? sound.sustain : 75;
        sound.release = Math.max(40, Math.min(350, durMs * 0.5));
      }
      const chord = _shapeNodeChord(cfg, nd, sortedIdx);
      // Set node: cycle the pool. A variance pick overrides the node's pitch
      // (and its own voice, if the variant carries one) for this pass.
      const variant = chord ? null : _shapeNodeVariant(nd);
      let voices;
      if (chord) {
        voices = _shapeChordFreqs(cfg, nd, chord).map(f => ({ freq: f, params: Object.assign({}, sound) }));
      } else {
        const off = (variant && Number.isFinite(variant.noteOffset)) ? variant.noteOffset : _shapeNodeOffset(nd);
        const freq = _shapeBaseFreq(cfg) * Math.pow(2, off / 12);
        const eff = (variant && variant.params && variant.params.type) ? Object.assign({}, sound, variant.params) : sound;
        voices = [{ freq, params: eff }];
      }
      return { voices, durMs };
    }
    function _shapeTriggerNode(cfg, nd, a, sortedAngles, sortedIdx) {
      const ev = _shapeResolveNodeEvent(cfg, nd, a, sortedAngles, sortedIdx);
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      try { if (typeof playNote === 'function') ev.voices.forEach(v => playNote(v.freq, v.params, ev.durMs)); } catch (e) {}
      nd._flash = performance.now();
    }
    function _shapeSpinTick() {
      if (!_shapeSpin.running) return;
      const cfg = _shapeCfg();
      if (!cfg) { _shapeSpinStop(); return; }
      const barSec = _shapeBarSec(cfg);
      const now = performance.now() / 1000;
      const phase = (((now - _shapeSpin.t0) % barSec) / barSec + 1) % 1;
      const last = _shapeSpin.lastPhase;
      const wrapped = phase < last;
      const { eff, sortedAngles: sorted, idxOf } = _shapeSortedEff(cfg);
      eff.forEach(e => {
        if (e.nd.muted) return;
        const a = e.a;
        const crossed = wrapped ? (a > last || a <= phase) : (a > last && a <= phase);
        if (crossed) _shapeTriggerNode(cfg, e.nd, a, sorted, idxOf.get(e.nd));
      });
      if (wrapped && _shapeRecording) _shapeRecordBar();   // completed bar → append
      _shapeSpin.lastPhase = phase;
      _shapeDraw(phase);
      _shapeSpin.raf = requestAnimationFrame(_shapeSpinTick);
    }
    function _shapeSpinStart() {
      if (_shapeSpin.running) return;
      try { if (typeof _shapeMasterStop === 'function') _shapeMasterStop(); } catch (e) {}
      _shapeSpin.running = true;
      _shapeSpin.t0 = performance.now() / 1000;
      // Start just before the downbeat so a node AT 12 o'clock (angle 0) fires
      // on the very first sweep (a > last needs last < 0); otherwise the first
      // note the arm reaches plays as normal.
      _shapeSpin.lastPhase = -1e-9;
      _shapeSpin.raf = requestAnimationFrame(_shapeSpinTick);
      _shapeReflectSpinBtn();
    }
    function _shapeSpinStop() {
      const was = _shapeSpin.running;
      _shapeSpin.running = false;
      if (_shapeSpin.raf) { cancelAnimationFrame(_shapeSpin.raf); _shapeSpin.raf = 0; }
      if (_shapeRecording) { _shapeRecording = false; _shapeReflectRecBtn(); }   // stop also disarms record
      if (was) { try { if (typeof silenceActiveVoices === 'function') silenceActiveVoices(); } catch (e) {} }  // cut ringing notes only when actually stopping
      _shapeReflectSpinBtn();
      if (_shapeInited) _shapeDraw(0);
    }
    function _shapeReflectSpinBtn() {
      const btn = document.getElementById('shape-spin-btn');
      if (btn) { btn.textContent = _shapeSpin.running ? '■ Stop' : '▶ Play'; btn.classList.toggle('active', _shapeSpin.running); }
    }
    function _shapeReflectSendBtn() {
      // Send is now a one-shot "snapshot a copy into the master collection"
      // (no live link / toggle). The count of stored copies rides in the title.
      const btn = document.getElementById('shape-send-btn');
      if (btn) {
        btn.classList.remove('active');
        btn.textContent = '◎ Send';
        const n = Array.isArray(masterShapes) ? masterShapes.length : 0;
        btn.title = 'Send a COPY of this wheel to the Mix ▸ Shapes master'
          + (n ? ' (' + n + ' there now)' : '');
      }
    }

    // ---- Record-to-lane (accumulative overdub) -----------------------------
    // Each completed bar while armed compiles the wheel's UNMUTED nodes into a
    // bar of lane steps (consecutive note durations from the angular gaps; a
    // leading rest if the first hit isn't on the downbeat) and APPENDS them to
    // the active lane's sequence — so the lane grows with whatever you play.
    let _shapeRecording = false;
    // Compile a wheel (cfg) into a one-bar (4-beat) step list — the inverse of
    // _shapeSeqToShape. Unmuted nodes become steps in clockwise order; the gap
    // to the next node is the step's slot. A node's SUSTAIN sets how long it
    // sounds: shorter than the gap → a rest fills the remainder (staccato);
    // no sustain set (hand-built wheel) → legato (note fills the whole gap).
    // Chord nodes become chord steps; each step keeps the node's own voice.
    function _shapeCompileSteps(cfg) {
      if (!cfg) return [];
      const BAR = _shapeLoopBeats(cfg); // beats in one revolution (length-aware)
      const baseM = Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60;
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const idxOf = _shapeSortedEff(cfg).idxOf;
      const eff = _shapeEffAngles(cfg).filter(e => !e.nd.muted).sort((x, y) => x.a - y.a);
      if (!eff.length) return [];
      const freqLabel = (freq) => { try { return (typeof Tone !== 'undefined') ? Tone.Frequency(freq).toNote() : ('' + Math.round(freq)); } catch (e) { return '' + Math.round(freq); } };
      const mkVoice = (freq, sound) => ({
        freq, label: freqLabel(freq),
        cellIndex: (typeof _findCellIdxForFreq === 'function') ? (_findCellIdxForFreq(freq) || null) : null,
        sound: sound.type, params: Object.assign({}, sound),
      });
      const mkRest = (beats) => ({ freq: null, label: '—', cellIndex: null, duration: 1, subdivision: Math.max(0.0625, beats) });
      const mkStep = (nd, beats) => {
        const sub = Math.max(0.0625, beats);
        const sound = _shapeNodeSound(cfg, nd);
        // Set node → a Set step (single base note + the cycling pool), so the
        // wrap unity survives the round-trip back into the lane.
        if (nd.variance && Array.isArray(nd.variance.notes) && nd.variance.notes.length) {
          const pool = nd.variance.notes.map(v => mkVoice(
            A * Math.pow(2, (baseM + (Number.isFinite(v.noteOffset) ? v.noteOffset : 0) - 69) / 12),
            (v.params && v.params.type) ? v.params : sound));
          const first = pool[0];
          return Object.assign({}, first, { duration: 1, subdivision: sub, variance: {
            notes: pool, mode: nd.variance.mode || 'linear',
            itersPerVariant: (Number.isFinite(nd.variance.itersPerVariant) && nd.variance.itersPerVariant > 0) ? nd.variance.itersPerVariant : 1,
            randomEachIter: !!nd.variance.randomEachIter } });
        }
        const chord = _shapeNodeChord(cfg, nd, idxOf.get(nd));
        if (chord) {
          const voices = _shapeChordFreqs(cfg, nd, chord).map(f => mkVoice(f, sound));
          return { chord: voices, label: voices.map(v => v.label).join('·'), duration: 1, subdivision: sub };
        }
        const offset = _shapeNodeOffset(nd);
        const v = mkVoice(A * Math.pow(2, (baseM + offset - 69) / 12), sound);
        return Object.assign(v, { duration: 1, subdivision: sub });
      };
      const gapOf = (k) => {
        const a = eff[k].a;
        const next = (k + 1 < eff.length) ? eff[k + 1].a : (eff[0].a + 1);   // wrap to first
        return (next - a) * BAR;
      };
      const out = [];
      if (eff[0].a > 1e-4) out.push(mkRest(eff[0].a * BAR));          // leading rest
      for (let i = 0; i < eff.length; i++) {
        const nd = eff[i].nd;
        // Run group: fold consecutive same-group nodes back into one Run (isSub)
        // step so the wrap unity survives the round-trip. Each member's slot is
        // its own gap, so the run's total beats == what the nodes occupied.
        if (nd.wrapGroup && nd.wrapType === 'run') {
          let j = i;
          while (j + 1 < eff.length && eff[j + 1].nd.wrapGroup === nd.wrapGroup && eff[j + 1].nd.wrapType === 'run') j++;
          if (j > i) {
            const subSteps = [];
            let groupBeats = 0;
            for (let k = i; k <= j; k++) {
              const gbk = Math.max(0.0625, gapOf(k));
              groupBeats += gbk;
              const ndk = eff[k].nd;
              const vk = mkVoice(A * Math.pow(2, (baseM + _shapeNodeOffset(ndk) - 69) / 12), _shapeNodeSound(cfg, ndk));
              subSteps.push(Object.assign(vk, { duration: 1, subdivision: gbk }));
            }
            out.push({ isSub: true, subSteps, label: '▤', duration: 1, subdivision: groupBeats });
            i = j;
            continue;
          }
          // Lone group member (the rest were moved/deleted) — emit as a normal note.
        }
        const gapBeats = gapOf(i);
        let noteBeats = gapBeats;   // legato by default
        if (Number.isFinite(nd.sustainFrac) && nd.sustainFrac > 0) {
          noteBeats = Math.min(gapBeats, Math.max(0.0625, nd.sustainFrac * BAR));
        }
        out.push(mkStep(nd, noteBeats));
        const restBeats = gapBeats - noteBeats;
        if (restBeats > 0.03) out.push(mkRest(restBeats));            // staccato gap
      }
      return out;
    }
    function _shapeRecordBar() {
      if (typeof sequence === 'undefined' || !Array.isArray(sequence)) return;
      const cfg = _shapeCfg(); if (!cfg) return;
      const out = _shapeCompileSteps(cfg);
      if (!out.length) return;
      out.forEach(s => sequence.push(s));   // accumulative overdub
      // Rec owns the steps while armed — keep the lane's fingerprint in step with
      // what we just appended so the auto-derive doesn't rebuild the wheel from
      // (and overwrite) this accumulated take.
      const _recLane = (typeof lanes !== 'undefined' && typeof activeLaneIdx !== 'undefined') ? lanes[activeLaneIdx] : null;
      if (_recLane) _recLane._shapeStepsFp = _stepsFingerprint(sequence);
      try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    }
    // "Send to lane" — REPLACE the lane's sequence with the current wheel (the
    // reverse of Send to Shape), so manual node edits / moves / deletes are
    // reflected back into the lane that the transport plays.
    function _sendShapeToLane(laneIdx) {
      const li = Number.isFinite(laneIdx) ? laneIdx : (typeof activeLaneIdx !== 'undefined' ? activeLaneIdx : 0);
      const lane = (typeof lanes !== 'undefined') ? lanes[li] : null;
      if (!lane || !lane.shape) return;
      const cfg = _shapeNormalize(lane.shape);
      const out = _shapeCompileSteps(cfg);
      if (!out.length) { try { alert('This shape has no unmuted nodes to send to the lane.'); } catch (e) {} return; }
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Send shape to lane');
      lane.steps = out;
      if (li === activeLaneIdx && typeof _aliasSequenceToActiveLane === 'function') { try { _aliasSequenceToActiveLane(); } catch (e) {} }
      try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      try { if (typeof showToast === 'function') showToast('Updated ' + (lane.name || ('Lane ' + (li + 1))) + ' from shape — ' + out.length + ' step' + (out.length === 1 ? '' : 's')); } catch (e) {}
    }
    // Delete one node from the active wheel (keeps at least one node).
    function _shapeDeleteNode(idx) {
      const cfg = _shapeCfg(); if (!cfg || !Array.isArray(cfg.nodes)) return;
      if (cfg.nodes.length <= 1 || idx < 0 || idx >= cfg.nodes.length) return;
      cfg.nodes.splice(idx, 1);
      cfg.nodeCount = cfg.nodes.length;
      // Dropping a node means the count no longer matches Equal spacing, so the
      // wheel is inherently free-form now — keep angles as-is.
      if (cfg.timingMode === 'equal') cfg.timingMode = 'free';
      _shapeMarkEdit();
      _shapeDraw();
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    }
    function _shapeSetRecording(on) {
      _shapeRecording = !!on;
      if (_shapeRecording && !_shapeSpin.running) _shapeSpinStart();   // record → spin
      _shapeReflectRecBtn();
    }
    function _shapeReflectRecBtn() {
      const btn = document.getElementById('shape-rec-btn');
      if (btn) { btn.classList.toggle('active', _shapeRecording); btn.textContent = _shapeRecording ? '● Recording' : '● Rec'; btn.title = _shapeRecording ? 'Recording… click to stop' : 'Record what plays into this lane (accumulative)'; }
    }
    // Has the wheel been customized away from a fresh default (so Clear would
    // lose real work)? Used to gate the confirm — undo doesn't capture shapes.
    function _shapeIsCustomized(cfg) {
      if (!cfg) return false;
      if (cfg.nodeCount !== 4 || (cfg.loopBeats || 4) !== 4 || cfg.progression || cfg.soundParams) return true;
      return (cfg.nodes || []).some(n => n && (
        n.muted || n.chord || n.chordOff || Number.isFinite(n.sustainFrac) ||
        (n.override && ((Number.isFinite(n.override.noteOffset) && n.override.noteOffset !== 0) || n.override.params))
      ));
    }
    function _shapeClearLane() {
      // In Shape mode the WHEEL is what's on screen, so Clear resets it to a
      // fresh default (the old behavior only emptied the lane's recorded steps,
      // which are off-screen here — so it looked like nothing happened). Also
      // clears the recorded output. Confirms first when there's real work to
      // lose, since the undo history doesn't capture per-lane shapes.
      const lane = _shapeLane();
      const cfg = (lane && lane.shape) ? _shapeNormalize(lane.shape) : null;
      const hasSteps = !!(lane && Array.isArray(lane.steps) && lane.steps.length);
      if ((hasSteps || _shapeIsCustomized(cfg)) && typeof confirm === 'function') {
        if (!confirm('Reset this wheel to default and clear the lane\'s recorded steps?')) return;
      }
      if (lane) {
        lane.shape = _shapeDefault();
        lane._shapeStepsFp = null;     // force the steps to re-sync from the fresh wheel
      }
      _shapeMarkEdit();
      try { _shapeFlushNow(); } catch (e) {}       // lane.steps follow the reset wheel
      try { _shapeBuildToolbar(); } catch (e) {}   // reflect the reset settings (Nodes/Tone/…)
      try { _shapeDraw(); } catch (e) {}
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    }

    // ---- Sequence → Shape conversion ---------------------------------------
    // Turn a lane's linear step sequence into a wheel: each sounding step
    // becomes a node placed at its proportional position in the bar (360° = the
    // whole sequence, looped). Pitch → per-node offset, chord → node chord,
    // run/sub → expanded into individual nodes; rests become empty spacing. Each
    // node carries its own sustain (the step's length as a fraction of the bar),
    // drawn as a ring arc. The step's voice params ride along so the shape
    // sounds like the sequence.
    function _shapeSeqToShape(steps) {
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const arr = (steps || []).filter(s => s && !s._wrapEditing);
      const slotBeats = (s) => Math.max(0.0001, (Number.isFinite(s.subdivision) ? s.subdivision : 1) * (Number.isFinite(s.duration) ? s.duration : 1));
      const total = arr.reduce((a, s) => a + slotBeats(s), 0) || 1;
      const freqToMidi = (f) => Math.round(69 + 12 * Math.log2((f > 0 ? f : A) / A));
      const isRest = (s) => (s.freq == null && !Array.isArray(s.chord) && !(s.isSub && Array.isArray(s.subSteps)));
      // Base note = first sounding pitch (single / chord-low / sub-first), else 60.
      let baseMidi = 60, firstParams = null;
      for (const s of arr) {
        if (isRest(s)) continue;
        if (Array.isArray(s.chord) && s.chord.length) {
          const vs = s.chord.filter(v => v && v.freq != null);
          if (vs.length) { baseMidi = freqToMidi(Math.min(...vs.map(v => v.freq))); firstParams = vs[0].params; break; }
        } else if (s.isSub && Array.isArray(s.subSteps)) {
          const f = s.subSteps.find(x => x && x.freq != null);
          if (f) { baseMidi = freqToMidi(f.freq); firstParams = f.params; break; }
        } else if (s.freq != null) { baseMidi = freqToMidi(s.freq); firstParams = s.params; break; }
      }
      const basePc = ((baseMidi % 12) + 12) % 12;
      const overrideFor = (midi, params) => {
        const o = { noteOffset: midi - baseMidi };
        if (params && params.type) o.params = Object.assign({}, params);
        return o;
      };
      const nodes = [];
      let cum = 0;
      for (const s of arr) {
        const slot = slotBeats(s);
        const af = ((cum / total) % 1 + 1) % 1;
        const susFrac = Math.max(0.005, Math.min(0.999, slot / total));
        if (!isRest(s)) {
          if (s.variance && Array.isArray(s.variance.notes) && s.variance.notes.length) {
            // Set step → one node carrying the cycling pool (offsets vs baseMidi).
            const pool = s.variance.notes.filter(v => v && v.freq != null).map(v => ({
              noteOffset: freqToMidi(v.freq) - baseMidi,
              params: (v.params && v.params.type) ? Object.assign({}, v.params) : null,
            }));
            if (pool.length) {
              nodes.push({ angleFrac: af, muted: false, sustainFrac: susFrac,
                override: overrideFor((s.freq != null) ? freqToMidi(s.freq) : (baseMidi + pool[0].noteOffset), s.params),
                variance: { notes: pool, mode: s.variance.mode || 'linear',
                  itersPerVariant: (Number.isFinite(s.variance.itersPerVariant) && s.variance.itersPerVariant > 0) ? s.variance.itersPerVariant : 1,
                  randomEachIter: !!s.variance.randomEachIter } });
            }
          } else if (Array.isArray(s.chord) && s.chord.length) {
            const vs = s.chord.filter(v => v && v.freq != null);
            if (vs.length) {
              const midis = vs.map(v => freqToMidi(v.freq)).sort((a, b) => a - b);
              const rootMidi = midis[0];
              const rootPc = ((rootMidi % 12) + 12) % 12;
              const intervals = Array.from(new Set(midis.map(m => m - rootMidi))).sort((a, b) => a - b);
              const defaultRootM = (baseMidi - basePc) + rootPc;
              const ov = { noteOffset: rootMidi - defaultRootM };
              if (vs[0].params && vs[0].params.type) ov.params = Object.assign({}, vs[0].params);
              nodes.push({ angleFrac: af, muted: false, sustainFrac: susFrac, chord: { root: rootPc, intervals }, override: ov });
            }
          } else if (s.isSub && Array.isArray(s.subSteps)) {
            // Run step → spread into one node per sub-note, all tagged with a
            // shared wrapGroup so compile can re-collect them back into a Run
            // (the "spread but keep unity" model). Position each by its OWN
            // cumulative length so a non-uniform run keeps its internal timing.
            const subs = s.subSteps.filter(x => x && x.freq != null);
            const gid = 'run' + (_shapeRunGid++);
            const subBeats = subs.map(x => Math.max(0.0001, (Number.isFinite(x.subdivision) ? x.subdivision : 1) * (Number.isFinite(x.duration) ? x.duration : 1)));
            const subTotal = subBeats.reduce((a, b) => a + b, 0) || subs.length || 1;
            let subCum = 0;
            subs.forEach((x, i) => {
              const subAf = (((cum + (subCum / subTotal) * slot) / total) % 1 + 1) % 1;
              nodes.push({ angleFrac: subAf, muted: false,
                sustainFrac: Math.max(0.005, Math.min(0.999, ((subBeats[i] / subTotal) * slot) / total)),
                override: overrideFor(freqToMidi(x.freq), x.params), wrapGroup: gid, wrapType: 'run' });
              subCum += subBeats[i];
            });
          } else if (s.freq != null) {
            nodes.push({ angleFrac: af, muted: false, sustainFrac: susFrac, override: overrideFor(freqToMidi(s.freq), s.params) });
          }
        }
        cum += slot;
      }
      const shape = _shapeDefault();
      shape.timingMode = 'free';        // converted nodes sit at arbitrary angles
      shape.loopBeats = total;          // one revolution = the whole lane at its real length
      shape.baseNote = baseMidi;
      if (firstParams && firstParams.type) shape.tone = firstParams.type;  // shape-level fallback voice
      if (nodes.length) { shape.nodes = nodes; shape.nodeCount = nodes.length; }
      return shape;
    }
    // Lane menu "Send to Shape": convert the lane's sequence into its shape and
    // switch the lane into Shape mode.
    function _sendLaneToShape(laneIdx) {
      const lane = (typeof lanes !== 'undefined') ? lanes[laneIdx] : null;
      if (!lane || !Array.isArray(lane.steps) || !lane.steps.length) return;
      const shape = _shapeSeqToShape(lane.steps);
      if (!shape || !shape.nodes || !shape.nodes.length) {
        try { alert('That lane has no playable notes to send to Shape.'); } catch (e) {}
        return;
      }
      if (typeof snapshotForUndo === 'function') snapshotForUndo('Send to Shape');
      lane.shape = shape;
      // Shape is mutually exclusive with the other lane modes.
      lane.fluidGridMode = false; lane.gameMode = false; lane.progMode = false;
      lane.ambientMode = false; lane.textMode = false; lane.seqMode = false;
      lane.shapeMode = true;
      if (typeof activateLane === 'function') activateLane(laneIdx);          // → _onShapeModeChanged sync
      else if (typeof _syncFluidGridToActiveLane === 'function') { try { _syncFluidGridToActiveLane(); } catch (e) {} }
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      try { if (typeof showToast === 'function') showToast('Sent ' + (lane.name || ('Lane ' + (laneIdx + 1))) + ' to Shape — ' + shape.nodes.length + ' node' + (shape.nodes.length === 1 ? '' : 's')); } catch (e) {}
    }

    // ---- Pointer interactions (click = mute, drag = retime) ----------------
    function _shapeHitNode(px, py) {
      const cfg = _shapeCfg(); if (!cfg) return -1;
      const { cx, cy, R } = _shapeGeo;
      const rotFrac = (cfg.rotationDeg || 0) / 360;
      let best = -1, bd = 16;
      cfg.nodes.forEach((nd, i) => {
        const p = _shapeNodeXY(cx, cy, R, nd.angleFrac, rotFrac);
        const d = Math.hypot(px - p.x, py - p.y);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    }
    function _shapeAngleFromXY(px, py) {
      const { cx, cy } = _shapeGeo;
      const a = Math.atan2(px - cx, -(py - cy));   // 0 at top (12 o'clock), + clockwise
      return ((a / (2 * Math.PI)) % 1 + 1) % 1;
    }

    // ---- Toolbar -----------------------------------------------------------
    function _shapeBuildToolbar() {
      const bar = document.getElementById('shape-toolbar');
      if (!bar) return;
      const cfg = _shapeCfg();
      // Bloom Shape layer: a purely generative wheel with no lane/sequencer
      // coupling, so hide the lane-only actions (Send → master overview,
      // Rec → records into a lane, Clear → resets the lane). Everything else
      // (node edit, Spray, Play/audition, ⚙ Wheel settings) is data-only and
      // operates on the override shape, so it stays.
      const bloomMode = !!(_shapeEditTarget && _shapeEditTarget.bloomMode);
      // Numeric controls render as −/+ steppers (large tap targets) around a
      // numeric-keypad input, so they're usable on touch.
      const stepper = (label, id, min, max, step, suffix) =>
        '<span class="shape-ctrl"><label>' + label + '</label>' +
          '<span class="shape-step">' +
            '<button type="button" class="shape-step-btn" data-for="' + id + '" data-step="-' + step + '" data-min="' + min + '" data-max="' + max + '" aria-label="decrease">−</button>' +
            '<input type="number" inputmode="numeric" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
            '<button type="button" class="shape-step-btn" data-for="' + id + '" data-step="' + step + '" data-min="' + min + '" data-max="' + max + '" aria-label="increase">+</button>' +
          '</span>' + (suffix ? '<span style="color:#6a6a88">' + suffix + '</span>' : '') +
        '</span>';
      // Actions live in a vertical column beside the canvas; all numeric /
      // dropdown inputs live in a single collapsible "⚙ Wheel" panel that wraps
      // full-width below the column + canvas row.
      bar.innerHTML =
        '<button type="button" class="shape-btn" id="shape-spray-btn" title="Spray ascending scale pitches / flatten">Spray</button>' +
        '<button type="button" class="shape-btn" id="shape-edit-btn" title="Edit mode: tap a node to open its Sound / Chord editor (instead of mute)">✎ Edit</button>' +
        (bloomMode ? '' : '<button type="button" class="shape-btn shape-send" id="shape-send-btn" title="Send this wheel to the Mix ▸ Shapes master overview">◎ Send</button>') +
        (bloomMode ? '' : '<button type="button" class="shape-btn" id="shape-clear-btn" title="Reset the wheel (and this lane) to a fresh default">Clear</button>') +
        // "→ Lane" retired — the wheel now folds into the lane's steps
        // automatically (trans-mode), so there's nothing to send manually.
        '<button type="button" class="shape-btn" id="shape-spin-btn" title="Spin (audition) / Stop">▶ Play</button>' +
        (bloomMode ? '' : '<button type="button" class="shape-btn shape-rec" id="shape-rec-btn" title="Record what plays into this lane (accumulative)">● Rec</button>') +
        // ⚙ Wheel sits at the BOTTOM of the column so it's adjacent to the
        // params panel it toggles (which wraps full-width just below the row).
        '<button type="button" class="shape-btn" id="shape-params-btn" title="Show / hide the wheel settings">⚙ Wheel ▾</button>' +
        '<div class="shape-params" id="shape-params" hidden>' +
          stepper('Nodes', 'shape-nodes', 1, 32, 1, '') +
          '<span class="shape-ctrl"><label>Timing</label><select id="shape-timing">' +
            '<option value="equal">Equal</option><option value="free">Free</option><option value="snap">Snap</option>' +
          '</select></span>' +
          '<span class="shape-ctrl"><label>Grid</label><select id="shape-grid" title="Time grid: sets the Rotate increment (360°/div) and Snap node placement">' +
            _SHAPE_GRIDS.map(g => '<option value="' + g.div + '">' + g.name + ' · ' + (Math.round((360 / g.div) * 100) / 100) + '°</option>').join('') +
          '</select></span>' +
          stepper('Rotate', 'shape-rot', 0, 359, _shapeRotStepDeg(cfg), '°') +
          '<span class="shape-ctrl"><label>Tone</label><select id="shape-tone" class="shape-tone-sel"></select></span>' +
          '<span class="shape-ctrl"><label>Prog</label><select id="shape-prog" class="shape-tone-sel"></select></span>' +
          stepper('Note', 'shape-note', 24, 96, 1, '') +
          stepper('Gate', 'shape-gate', 5, 100, 5, '%') +
        '</div>';
      const nodesEl = bar.querySelector('#shape-nodes');
      const timingEl = bar.querySelector('#shape-timing');
      const gridEl = bar.querySelector('#shape-grid');
      const rotEl = bar.querySelector('#shape-rot');
      const toneEl = bar.querySelector('#shape-tone');
      const progEl = bar.querySelector('#shape-prog');
      const noteEl = bar.querySelector('#shape-note');
      const gateEl = bar.querySelector('#shape-gate');
      const spinEl = bar.querySelector('#shape-spin-btn');
      try {
        if (typeof populateGroupedToneSelect === 'function' && typeof getAllSoundOptions === 'function') {
          populateGroupedToneSelect(toneEl, getAllSoundOptions(), { value: '', label: 'Grid voice (copy)' });
        }
      } catch (e) {}
      _shapePopulateProgSelect(progEl);
      if (cfg) {
        nodesEl.value = cfg.nodeCount; timingEl.value = cfg.timingMode;
        gridEl.value = String(Number.isFinite(cfg.snapDiv) ? cfg.snapDiv : 16);
        rotEl.value = cfg.rotationDeg;
        toneEl.value = cfg.tone || ''; noteEl.value = Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60; gateEl.value = cfg.gatePct;
        progEl.value = (cfg.progression && cfg.progression.key) ? cfg.progression.key : '';
      }
      const persist = () => { _shapeMarkEdit(); try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {} };
      nodesEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return;
        const n = Math.max(1, Math.min(32, parseInt(nodesEl.value, 10) || 4));
        // Changing the node count rebuilds the wheel from scratch, which drops
        // per-node wrap payloads (Set cycles / Run groups). Warn + let the user
        // back out when any exist; revert the stepper if they cancel.
        const hasWrap = (c.nodes || []).some(nd => nd && (nd.variance || (nd.wrapGroup && nd.wrapType === 'run')));
        if (n !== c.nodeCount && hasWrap && typeof confirm === 'function'
            && !confirm('Changing the number of nodes rebuilds the wheel and will reset its Set cycles and Run groups back to plain notes. Continue?')) {
          nodesEl.value = c.nodeCount;   // revert the stepper, keep the wheel as-is
          return;
        }
        c.nodeCount = n; c.nodes = _shapeEqualNodes(n, c.nodes);
        nodesEl.value = n; _shapeDraw(); persist();
      });
      timingEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return; c.timingMode = timingEl.value; _shapeDraw(); persist();
      });
      // Grid sets the time division. Re-snap the current rotation onto it and
      // update the Rotate stepper's increment (and input step) live, so one tick
      // = one grid cell with no toolbar rebuild.
      gridEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return;
        c.snapDiv = parseInt(gridEl.value, 10) || 16;
        c.rotationDeg = _shapeSnapRot(c.rotationDeg, c);
        const step = _shapeRotStepDeg(c);
        if (rotEl) { rotEl.step = step; rotEl.value = c.rotationDeg; }
        const rb = bar.querySelectorAll('.shape-step-btn[data-for="shape-rot"]');
        if (rb[0]) rb[0].dataset.step = '-' + step;   // − button (first in DOM order)
        if (rb[1]) rb[1].dataset.step = '' + step;    // + button
        _shapeDraw(); persist();
      });
      rotEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return;
        c.rotationDeg = _shapeSnapRot(rotEl.value, c);
        rotEl.value = c.rotationDeg; _shapeDraw(); persist();
      });
      // Selecting a concrete voice sets it; selecting "Grid voice (copy)" ('')
      // freezes a copy of the CURRENT grid voice so the shape keeps its own.
      toneEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return;
        c.tone = toneEl.value || _shapeGridVoiceType();
        c.soundParams = null;   // explicit tone pick clears any shape-level Sound-Editor voice
        toneEl.value = c.tone;
        persist();
      });
      progEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return;
        _shapeApplyProgByKey(c, progEl.value);
        _shapeDraw(); persist();
      });
      noteEl.addEventListener('change', () => { const c = _shapeCfg(); if (!c) return; c.baseNote = Math.max(24, Math.min(96, parseInt(noteEl.value, 10) || 60)); noteEl.value = c.baseNote; persist(); });
      gateEl.addEventListener('change', () => { const c = _shapeCfg(); if (!c) return; c.gatePct = Math.max(5, Math.min(100, parseInt(gateEl.value, 10) || 80)); gateEl.value = c.gatePct; persist(); });
      if (spinEl) spinEl.addEventListener('click', () => { if (_shapeSpin.running) _shapeSpinStop(); else _shapeSpinStart(); });
      const paramsBtn = bar.querySelector('#shape-params-btn');
      const paramsPanel = bar.querySelector('#shape-params');
      if (paramsBtn && paramsPanel) paramsBtn.addEventListener('click', () => {
        const open = paramsPanel.hasAttribute('hidden');
        if (open) paramsPanel.removeAttribute('hidden'); else paramsPanel.setAttribute('hidden', '');
        paramsBtn.textContent = '⚙ Wheel ' + (open ? '▴' : '▾');
        paramsBtn.classList.toggle('active', open);
      });
      const recEl = bar.querySelector('#shape-rec-btn');
      if (recEl) recEl.addEventListener('click', () => _shapeSetRecording(!_shapeRecording));
      const clearEl = bar.querySelector('#shape-clear-btn');
      if (clearEl) clearEl.addEventListener('click', () => _shapeClearLane());
      // (#shape-tolane-btn retired — wheel→steps is automatic now.)
      // Spray/Flat is one toggle: when the wheel is flat it sprays a scale;
      // when it's already pitched it flattens. The label shows the action.
      const sprayEl = bar.querySelector('#shape-spray-btn');
      if (sprayEl) sprayEl.addEventListener('click', () => {
        if (_shapeIsPitched()) _shapeFlattenPitch(); else _shapeSprayScale();
      });
      const editEl = bar.querySelector('#shape-edit-btn');
      if (editEl) editEl.addEventListener('click', () => { _shapeEditMode = !_shapeEditMode; _shapeReflectEditBtn(); });
      _shapeReflectEditBtn();
      const sendEl = bar.querySelector('#shape-send-btn');
      if (sendEl) sendEl.addEventListener('click', () => {
        const lane = _shapeLane(); if (!lane) return;
        const cfg = _shapeCfg(); if (!cfg) return;
        _masterAddCopy(cfg, (lane && lane.name) || 'Shape');
        // Brief confirmation, then revert (no persistent toggle state).
        sendEl.textContent = '✓ Sent';
        sendEl.classList.add('active');
        setTimeout(() => { try { if (sendEl.isConnected) _shapeReflectSendBtn(); } catch (e) {} }, 850);
      });
      // Stepper −/+ buttons nudge their input and re-fire its change handler.
      bar.querySelectorAll('.shape-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const inp = document.getElementById(btn.dataset.for); if (!inp) return;
          const step = parseFloat(btn.dataset.step) || 1;
          const min = parseFloat(btn.dataset.min), max = parseFloat(btn.dataset.max);
          let v = (parseFloat(inp.value) || 0) + step;
          if (Number.isFinite(min)) v = Math.max(min, v);
          if (Number.isFinite(max)) v = Math.min(max, v);
          inp.value = v;
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      _shapeReflectSendBtn();
      _shapeReflectSpinBtn();
      _shapeReflectRecBtn();
      _shapeReflectSprayBtn();
      // Relocate the collapsible params panel OUT of the button column so it
      // sits full-width below the [buttons | canvas] row (a narrow column is no
      // place for the Nodes/Timing/Grid/Tone/Prog/Note/Gate controls). The
      // panel keeps its wired listeners through the move. Drop any panel left
      // over from a previous build first so there's never a duplicate.
      const inner = document.getElementById('shape-inner');
      if (inner && paramsPanel) {
        const stale = inner.querySelector(':scope > #shape-params');
        if (stale && stale !== paramsPanel) stale.remove();
        inner.appendChild(paramsPanel);
      }
    }

    // ---- Lifecycle ---------------------------------------------------------
    function _shapeInit() {
      if (!_shapeInited) {
        _shapeCanvas = document.getElementById('shape-canvas');
        if (!_shapeCanvas) return;
        _shapeCtx = _shapeCanvas.getContext('2d');
        window.addEventListener('resize', () => {
          if (document.body.classList.contains('shape-mode')) { _shapeResize(); _shapeDraw(); }
        });
        // Pointer: click a node = mute/unmute; drag = retime (Free/Snap only).
        let drag = { idx: -1, moved: false, sx: 0, sy: 0 };
        const toCanvas = (e) => { const r = _shapeCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        _shapeCanvas.addEventListener('pointerdown', (e) => {
          const { x, y } = toCanvas(e);
          const i = _shapeHitNode(x, y);
          if (i < 0) return;
          e.preventDefault();
          // Remember this node's Run-group state so endDrag can warn if the move
          // pulls it out of its group (splitting the run) and offer to back out.
          const _c = _shapeCfg();
          const _nd = (_c && _c.nodes) ? _c.nodes[i] : null;
          const _gid = (_nd && _nd.wrapType === 'run') ? _nd.wrapGroup : null;
          drag = { idx: i, moved: false, sx: x, sy: y,
            runGid: _gid, origAngle: _nd ? _nd.angleFrac : null,
            runWasContig: (_gid != null) ? _shapeRunGroupContiguous(_c, _gid) : true };
          try { _shapeCanvas.setPointerCapture(e.pointerId); } catch (ex) {}
        });
        _shapeCanvas.addEventListener('pointermove', (e) => {
          if (drag.idx < 0) return;
          const { x, y } = toCanvas(e);
          if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 4) drag.moved = true;
          if (!drag.moved) return;
          const cfg = _shapeCfg(); if (!cfg || cfg.timingMode === 'equal') return;   // Equal locks spacing
          const rotFrac = (cfg.rotationDeg || 0) / 360;
          let frac = ((_shapeAngleFromXY(x, y) - rotFrac) % 1 + 1) % 1;
          if (cfg.timingMode === 'snap') { const div = Math.max(1, cfg.snapDiv | 0); frac = (Math.round(frac * div) / div) % 1; }
          cfg.nodes[drag.idx].angleFrac = ((frac % 1) + 1) % 1;
          _shapeDraw();
          // Live readout: which bar division / beat the node now sits on (and
          // whether it's locked to the grid). Shown only while actively dragging.
          const ro = document.getElementById('shape-drag-readout');
          if (ro) {
            ro.textContent = _shapeNodePosLabel(cfg, cfg.nodes[drag.idx].angleFrac);
            ro.classList.toggle('locked', cfg.timingMode === 'snap');
            ro.hidden = false;
          }
        });
        const endDrag = (e) => {
          const _ro = document.getElementById('shape-drag-readout');
          if (_ro) _ro.hidden = true;
          if (drag.idx < 0) return;
          const cfg = _shapeCfg();
          if (!drag.moved && cfg) {
            // Edit mode: a tap opens the node's Sound / Chord editor. Otherwise
            // a tap toggles mute (the default interaction).
            if (_shapeEditMode) _shapeEditNode(drag.idx);
            else { cfg.nodes[drag.idx].muted = !cfg.nodes[drag.idx].muted; _shapeDraw(); }
          }
          // Run-split guard: if this move broke a contiguous Run group apart,
          // warn and let the user back the move out (restore the node's angle).
          if (drag.moved && drag.runGid != null && cfg && drag.runWasContig
              && !_shapeRunGroupContiguous(cfg, drag.runGid)) {
            const ok = (typeof confirm !== 'function') || confirm('Moving this node out of its Run group will split the run into pieces when the wheel recompiles into the lane. Move it anyway?');
            if (!ok) {
              if (cfg.nodes[drag.idx] && Number.isFinite(drag.origAngle)) cfg.nodes[drag.idx].angleFrac = drag.origAngle;
              _shapeDraw();
              try { _shapeCanvas.releasePointerCapture(e.pointerId); } catch (ex) {}
              drag = { idx: -1, moved: false, sx: 0, sy: 0 };
              return;   // backed out — don't persist the rejected move
            }
          }
          _shapeMarkEdit();
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (ex) {}
          try { _shapeCanvas.releasePointerCapture(e.pointerId); } catch (ex) {}
          drag = { idx: -1, moved: false, sx: 0, sy: 0 };
        };
        _shapeCanvas.addEventListener('pointerup', endDrag);
        _shapeCanvas.addEventListener('pointercancel', endDrag);
        // Wheel over a node nudges its pitch (semitone offset above base note).
        _shapeCanvas.addEventListener('wheel', (e) => {
          const { x, y } = toCanvas(e);
          const i = _shapeHitNode(x, y);
          if (i < 0) return;
          e.preventDefault();
          const cfg = _shapeCfg(); if (!cfg) return;
          const nd = cfg.nodes[i]; nd.override = nd.override || {};
          const cur = Number.isFinite(nd.override.noteOffset) ? nd.override.noteOffset : 0;
          nd.override.noteOffset = Math.max(-24, Math.min(24, cur + (e.deltaY < 0 ? 1 : -1)));
          _shapeDraw();
          _shapeReflectSprayBtn();
          _shapeMarkEdit();
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (ex) {}
        }, { passive: false });
        _shapeInited = true;
      }
      _shapeBuildToolbar();
      // Defer one frame so the stage has laid out before measuring.
      requestAnimationFrame(() => { _shapeResize(); _shapeDraw(); });
    }
    function _onShapeModeChanged(active) {
      if (active) {
        const lane = _shapeLane();
        if (lane && !_shapeEditTarget) _shapeMaybeDeriveFromSteps(lane);   // reflect latest steps
        _shapeInit();
      } else {
        _shapeFlushNow();          // leaving Shape → make sure edits are in steps
        _shapeSpinStop();
      }
    }
    function _shapeRetargetLane() {
      if (_shapeInited && document.body.classList.contains('shape-mode')) {
        const lane = _shapeLane();
        if (lane && !_shapeEditTarget) _shapeMaybeDeriveFromSteps(lane);
        _shapeBuildToolbar(); _shapeResize(); _shapeDraw();
      }
    }

    // ========================================================================
    // S3 — Mix "Master Shape": every Shape-mode lane's wheel superimposed
    // concentrically on one shared bar clock. Read-only overview; Play all
    // auditions the combined polyrhythm; click a ring (or legend) jumps to that
    // lane in Make.
    // ========================================================================
    const SHAPE_COLORS = ['#4fd1c5', '#9f7aea', '#f6ad55', '#f56565', '#63b3ed', '#68d391', '#ed64a6', '#ecc94b'];
    let _shapeMaster = { canvas: null, ctx: null, inited: false, raf: 0, running: false, t0: 0, lastPhase: 0, rings: [], legendKey: null };
    let _shapeMasterExpanded = new Set();   // which browser groups are expanded (collapsed by default)
    function _shapeRgba(hex, a) {
      const h = hex.replace('#', '');
      const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
      const n = parseInt(f, 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    // ----- master-shape collection helpers -----------------------------------
    function _masterShapeById(id) {
      if (id == null || !Array.isArray(masterShapes)) return null;
      return masterShapes.find(c => c && c.id === id) || null;
    }
    // The active copy (newest as a fallback so the view is never blank when one
    // exists but activeMasterShapeId drifted, e.g. after a delete).
    function _masterActive() {
      return _masterShapeById(activeMasterShapeId)
        || (Array.isArray(masterShapes) && masterShapes.length ? masterShapes[masterShapes.length - 1] : null);
    }
    function _masterActiveCfg() {
      const c = _masterActive(); if (!c) return null;
      if (!c.shape || typeof c.shape !== 'object') c.shape = _shapeDefault();
      return _shapeNormalize(c.shape);
    }
    function _masterColorOf(c) {
      const i = Array.isArray(masterShapes) ? masterShapes.indexOf(c) : 0;
      return SHAPE_COLORS[(i < 0 ? 0 : i) % SHAPE_COLORS.length];
    }
    // Snapshot a wheel into the collection as a fresh INDEPENDENT copy. Versions
    // sharing a source stack into one group (re-sending lane "A" → A v1, A v2…;
    // re-saving sequence "Drums" → Drums v1, v2…). opts:
    //   { name, source:'lane'|'saved-seq'|'capture'|'manual', sourceId, makeActive }
    // A bare string is treated as a lane name (back-compat). Returns the new id.
    function _masterAddCopy(cfg, opts) {
      if (!Array.isArray(masterShapes)) masterShapes = [];
      if (typeof opts === 'string') opts = { name: opts, source: 'lane' };
      opts = opts || {};
      const source = opts.source || 'manual';
      const base = (typeof opts.name === 'string' && opts.name.trim()) ? opts.name.trim() : 'Shape';
      const groupId = (opts.sourceId != null) ? String(opts.sourceId) : (source + ':' + base);
      const shape = JSON.parse(JSON.stringify(cfg || _shapeDefault()));
      const id = _shapeMasterIdSeq++;
      const n = masterShapes.filter(c => c && c.groupId === groupId).length + 1;
      let createdAt = null; try { createdAt = Date.now(); } catch (e) {}
      masterShapes.push({ id, name: base + ' v' + n, base, source, groupId, createdAt, shape });
      if (opts.makeActive !== false) {        // auto-reflections (saves) don't steal selection
        activeMasterShapeId = id;
        _shapeMasterExpanded.add(groupId);    // reveal the family the new copy landed in
      }
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      _shapeMaster.legendKey = null;
      try { if (_shapeMaster.inited) _shapeMasterDraw(0); } catch (e) {}
      try { _shapeReflectSendBtn(); } catch (e) {}
      return id;
    }
    // Reflect a SAVED step-sequence into master Shapes as an independent copy.
    // Audio recordings (no step data) are skipped — they have no note/timing to
    // make a wheel from (they belong to the Capture path instead).
    function _shapeReflectSavedSeq(entry) {
      try {
        if (!entry || entry.type === 'audio') return;
        const steps = Array.isArray(entry.steps) ? entry.steps
                    : (Array.isArray(entry.sequence) ? entry.sequence : null);
        if (!steps || !steps.length) return;
        if (!steps.some(s => s && (s.freq != null || Array.isArray(s.chord) || (s.isSub && Array.isArray(s.subSteps))))) return;
        const cfg = _shapeSeqToShape(steps);
        _masterAddCopy(cfg, { name: entry.name || 'Sequence', source: 'saved-seq', sourceId: 'seq:' + (entry.name || ''), makeActive: false });
      } catch (e) { console.warn('reflect saved seq → master shape failed', e); }
    }
    function _masterSelect(id) {
      if (!_masterShapeById(id)) return;
      activeMasterShapeId = id;
      try { _shapeMasterStop(); } catch (e) {}
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      _shapeMaster.legendKey = null;
      _shapeMasterDraw(0);
    }
    function _masterDeleteCopy(id) {
      if (!Array.isArray(masterShapes)) return;
      const i = masterShapes.findIndex(c => c && c.id === id);
      if (i < 0) return;
      // If this copy is open in the editor, leave edit mode first.
      if (_shapeMasterEditId === id) { try { _shapeMasterEditClose(); } catch (e) {} }
      masterShapes.splice(i, 1);
      if (activeMasterShapeId === id) {
        activeMasterShapeId = masterShapes.length
          ? masterShapes[Math.min(i, masterShapes.length - 1)].id : null;
      }
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      try { _shapeMasterStop(); } catch (e) {}
      _shapeMaster.legendKey = null;
      _shapeMasterDraw(0);
      try { _shapeReflectSendBtn(); } catch (e) {}
    }
    function _shapeMasterResize() {
      if (!_shapeMaster.canvas) return;
      const stage = document.getElementById('shape-master-stage'); if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const side = Math.max(160, Math.min(rect.width, rect.height) - 6);
      const dpr = window.devicePixelRatio || 1;
      _shapeMaster.canvas.style.width = side + 'px';
      _shapeMaster.canvas.style.height = side + 'px';
      _shapeMaster.canvas.width = Math.round(side * dpr);
      _shapeMaster.canvas.height = Math.round(side * dpr);
      if (_shapeMaster.ctx) _shapeMaster.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function _shapeDrawWheelAt(ctx, cx, cy, R, cfg, color, noFlash) {
      const rotFrac = (cfg.rotationDeg || 0) / 360;
      const pts = cfg.nodes.map(nd => Object.assign({ nd }, _shapeNodeXY(cx, cy, R, nd.angleFrac, rotFrac)));
      ctx.strokeStyle = 'rgba(120,120,160,0.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
      if (pts.length >= 2) {
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
        ctx.fillStyle = _shapeRgba(color, 0.05); ctx.fill();
        ctx.strokeStyle = _shapeRgba(color, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
      }
      // Sustain arcs (per-node hold length) along this wheel's ring.
      cfg.nodes.forEach(nd => {
        const sf = Number.isFinite(nd.sustainFrac) ? nd.sustainFrac : 0;
        if (sf <= 0 || nd.muted) return;
        const aStart = 2 * Math.PI * (((nd.angleFrac + rotFrac) % 1 + 1) % 1) - Math.PI / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, R, aStart, aStart + 2 * Math.PI * Math.min(0.999, sf), false);
        ctx.strokeStyle = _shapeRgba(color, 0.45); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
      });
      ctx.lineCap = 'butt';
      pts.forEach(p => {
        // No white grow-and-shrink trigger flash (see _shapeDrawCore): nodes
        // always draw at their final size / colour so every Shape view just shows
        // the wheel instead of animating in from leftover _flash timestamps.
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
        if (p.nd.muted) { ctx.fillStyle = 'rgba(40,40,60,0.85)'; ctx.fill(); ctx.strokeStyle = 'rgba(120,120,150,0.5)'; ctx.lineWidth = 1; ctx.stroke(); }
        else { ctx.fillStyle = color; ctx.fill(); }
      });
    }
    function _shapeMasterDraw(phase) {
      const ctx = _shapeMaster.ctx, cv = _shapeMaster.canvas; if (!ctx || !cv) return;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.width / dpr, H = cv.height / dpr;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) / 2 - 30;
      // The browser list (version rows) is its own DOM, refreshed cheaply.
      _shapeMasterBrowser();
      const cfg = _masterActiveCfg();
      if (!cfg) {
        ctx.fillStyle = 'rgba(120,120,150,0.7)'; ctx.font = '14px Segoe UI, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('No master shapes yet — press “◎ Send” in a Shape lane.', cx, cy);
        _shapeMaster.rings = []; return;
      }
      const color = _masterColorOf(_masterActive());
      _shapeMaster.rings = [{ id: activeMasterShapeId, cfg, color, radius: R }];
      // Single sweeping playhead for the active wheel.
      const ph = (typeof phase === 'number') ? phase : (_shapeMaster.running ? _shapeMaster.lastPhase : 0);
      const pa = 2 * Math.PI * (((ph % 1) + 1) % 1);
      ctx.strokeStyle = 'rgba(79,209,197,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.sin(pa), cy - R * Math.cos(pa)); ctx.stroke();
      _shapeDrawWheelAt(ctx, cx, cy, R, cfg, color);
      ctx.fillStyle = 'rgba(203,213,224,0.8)'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fill();
    }
    const _SHAPE_SRC_LABEL = { lane: 'lane', 'saved-seq': 'saved', capture: 'capture', manual: 'manual' };
    function _shapeGroupKey(c) { return c.groupId || ((c.source || 'manual') + ':' + (c.base || c.name || ('id' + c.id))); }
    // Version browser: copies grouped by source (re-sends / re-saves stack into
    // one collapsible family); each version is selectable / editable / deletable.
    function _shapeMasterBrowser() {
      const el = document.getElementById('shape-master-legend'); if (!el) return;
      const list = Array.isArray(masterShapes) ? masterShapes : [];
      // Cheap signature so the per-frame draw doesn't rebuild DOM 60×/s.
      const key = list.map(c => c.id + '~' + (c.name || '') + '~'
        + ((c.shape && Array.isArray(c.shape.nodes)) ? c.shape.nodes.length : '?')).join('|')
        + '#' + activeMasterShapeId + '@' + Array.from(_shapeMasterExpanded).join(',');
      if (key === _shapeMaster.legendKey && el.childElementCount) return;
      _shapeMaster.legendKey = key;
      el.innerHTML = '';
      if (!list.length) {
        const hint = document.createElement('span'); hint.className = 'sm-leg'; hint.style.cssText = 'cursor:default;color:#6a6a88';
        hint.textContent = 'No master shapes — “◎ Send” a Shape lane, or save a sequence in Make.';
        el.appendChild(hint); return;
      }
      // Group, preserving first-seen order; newest version first within a group.
      const groups = new Map();
      list.forEach(c => {
        const g = _shapeGroupKey(c);
        if (!groups.has(g)) groups.set(g, { label: c.base || c.name || 'Shape', source: c.source || 'manual', items: [] });
        groups.get(g).items.push(c);
      });
      groups.forEach((grp, gkey) => {
        const items = grp.items.slice().reverse();   // newest first
        const hasActive = items.some(c => c.id === activeMasterShapeId);
        const open = hasActive || _shapeMasterExpanded.has(gkey);
        // ---- group header ----
        const head = document.createElement('div'); head.className = 'sm-group' + (open ? ' open' : '');
        const tw = document.createElement('span'); tw.className = 'sm-twist'; tw.textContent = open ? '▾' : '▸';
        const gl = document.createElement('span'); gl.className = 'sm-glabel'; gl.textContent = grp.label;
        const badge = document.createElement('span'); badge.className = 'sm-badge'; badge.textContent = _SHAPE_SRC_LABEL[grp.source] || grp.source;
        const cnt = document.createElement('span'); cnt.className = 'sm-count'; cnt.textContent = items.length + (items.length === 1 ? ' version' : ' versions');
        const gdel = document.createElement('span'); gdel.className = 'sm-del'; gdel.textContent = '✕'; gdel.title = 'Delete all versions in this group';
        gdel.addEventListener('click', (e) => { e.stopPropagation(); _masterDeleteGroup(gkey); });
        head.appendChild(tw); head.appendChild(gl); head.appendChild(badge); head.appendChild(cnt); head.appendChild(gdel);
        head.addEventListener('click', () => {
          if (_shapeMasterExpanded.has(gkey)) _shapeMasterExpanded.delete(gkey); else _shapeMasterExpanded.add(gkey);
          _shapeMaster.legendKey = null; _shapeMasterBrowser();
        });
        el.appendChild(head);
        if (!open) return;
        // ---- version rows ----
        items.forEach(c => {
          const cfg = _shapeNormalize(c.shape);
          const row = document.createElement('span');
          row.className = 'sm-ver' + (c.id === activeMasterShapeId ? ' active' : '');
          row.title = 'Click to select (make active); ✎ to edit; ✕ to delete';
          const sw = document.createElement('span'); sw.className = 'sm-swatch'; sw.style.background = _masterColorOf(c);
          const nm = document.createElement('span'); nm.className = 'sm-name';
          nm.textContent = (c.name || 'Shape') + ' · ' + cfg.nodes.length;
          row.appendChild(sw); row.appendChild(nm);
          row.addEventListener('click', () => _masterSelect(c.id));
          const ed = document.createElement('span'); ed.className = 'sm-edit'; ed.textContent = '✎'; ed.title = 'Edit this shape';
          ed.addEventListener('click', (e) => { e.stopPropagation(); _shapeMasterEditOpen(c.id); });
          const del = document.createElement('span'); del.className = 'sm-del'; del.textContent = '✕'; del.title = 'Delete this version';
          del.addEventListener('click', (e) => { e.stopPropagation(); _masterDeleteCopy(c.id); });
          row.appendChild(ed); row.appendChild(del);
          el.appendChild(row);
        });
      });
    }
    function _masterDeleteGroup(gkey) {
      if (!Array.isArray(masterShapes)) return;
      const victims = masterShapes.filter(c => _shapeGroupKey(c) === gkey).map(c => c.id);
      if (!victims.length) return;
      if (typeof confirm === 'function' && victims.length > 1 && !confirm('Delete all ' + victims.length + ' versions in this group?')) return;
      victims.forEach(id => _masterDeleteCopy(id));
    }
    // ----- Capture / upload (mirrors master Bloom) ---------------------------
    // Records the master output while the active shape plays, encodes a take,
    // and drops it into the SHARED capture bank (the same one Bloom uses, so
    // upload/download/preview reuse _ambRenderCaptureBank + _ambUploadBankItem).
    let _shapeCap = null;
    function _shapeRefreshCaptureBtn() {
      const btn = document.getElementById('shape-master-capture'); if (!btn) return;
      if (_shapeCap) { btn.textContent = '■ Finalize'; btn.classList.add('recording'); }
      else { btn.textContent = '⤓ Capture'; btn.classList.remove('recording'); }
    }
    function _shapeMasterCaptureToggle() {
      if (_shapeCap) { try { _shapeCap.rec.stop(); } catch (e) {} return; }   // 2nd press → finalize
      if (typeof MediaRecorder === 'undefined') { alert('This browser cannot record audio output.'); return; }
      if (!_masterActiveCfg()) { alert('No master shape to capture — add or select one first.'); return; }
      let ac; try { ac = Tone.getContext().rawContext; } catch (e) { alert('No audio context.'); return; }
      const tap = (typeof masterLimiter !== 'undefined' && masterLimiter) ? masterLimiter
                : ((typeof masterBus !== 'undefined' && masterBus) ? masterBus : null);
      if (!tap) { alert('Master output unavailable.'); return; }
      if (!_shapeMaster.running) { try { _shapeMasterStart(); } catch (e) {} }   // make sure it's sounding
      let dest, rec;
      try {
        dest = ac.createMediaStreamDestination(); tap.connect(dest);
        const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
        const mime = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
        rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
      } catch (e) { try { tap.disconnect(dest); } catch (_) {} alert('Capture failed: ' + ((e && e.message) || e)); return; }
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => _shapeMasterCaptureFinish(chunks, rec);
      _shapeCap = { rec, dest, tap, chunks };
      try { rec.start(); } catch (e) { try { tap.disconnect(dest); } catch (_) {} _shapeCap = null; alert('Capture failed.'); return; }
      _shapeRefreshCaptureBtn();
      if (typeof showToast === 'function') showToast('Capturing the master shape — press ■ Finalize to end.');
    }
    async function _shapeMasterCaptureFinish(chunks, rec) {
      const r = _shapeCap;
      try { if (r) r.tap.disconnect(r.dest); } catch (e) {}
      _shapeCap = null;
      _shapeRefreshCaptureBtn();
      if (!chunks || !chunks.length) return;
      try {
        const ac = Tone.getContext().rawContext;
        const arr = await new Blob(chunks, { type: rec.mimeType || 'audio/webm' }).arrayBuffer();
        const audioBuf = await ac.decodeAudioData(arr);
        if (typeof showExportOptionsDialog !== 'function') { alert('Capture is unavailable.'); return; }
        const active = _masterActive();
        const base = (active && (active.base || active.name)) || 'shape';
        const stamp = (() => { try { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); } catch (e) { return 'take'; } })();
        const choice = await showExportOptionsDialog({ title: 'Save shape capture', defaultName: base + '-' + stamp, defaultFolder: 'bloops/exports', includeFolder: true, applyLabel: 'Save' });
        if (!choice) return;
        const { filename, fmt, folder } = choice;
        const ext = fmt === 'mp3' ? 'mp3' : 'wav';
        const mime = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav';
        const blob = (fmt === 'mp3' && typeof audioBufferToMp3 === 'function') ? await audioBufferToMp3(audioBuf) : audioBufferToWav(audioBuf);
        let url = null; try { url = URL.createObjectURL(blob); } catch (e) {}
        if (typeof _ambCaptureBank !== 'undefined' && Array.isArray(_ambCaptureBank)) {
          const id = (typeof _ambCapBankSeq !== 'undefined') ? (++_ambCapBankSeq) : Date.now();
          _ambCaptureBank.push({ id, name: filename, ext, mime, folder: folder || 'bloops/exports', durSec: audioBuf.duration, bytes: blob.size, blob, url, uploaded: false });
          if (typeof _ambRenderCaptureBank === 'function') _ambRenderCaptureBank();
        }
        if (typeof showToast === 'function') showToast('Captured “' + filename + '” — upload it from the bank below.');
      } catch (e) { console.error('Shape capture failed', e); alert('Shape capture failed: ' + ((e && e.message) || e)); }
    }
    function _shapeMasterTick() {
      if (!_shapeMaster.running) return;
      const cfg = _masterActiveCfg();
      if (!cfg) { _shapeMasterStop(); return; }
      const barSec = _shapeBarSec(cfg);
      const now = performance.now() / 1000;
      const phase = (((now - _shapeMaster.t0) % barSec) / barSec + 1) % 1;
      const last = _shapeMaster.lastPhase, wrapped = phase < last;
      const { eff, sortedAngles: sorted, idxOf } = _shapeSortedEff(cfg);
      eff.forEach(e => {
        if (e.nd.muted) return;
        const a = e.a;
        const crossed = wrapped ? (a > last || a <= phase) : (a > last && a <= phase);
        if (crossed) _shapeTriggerNode(cfg, e.nd, a, sorted, idxOf.get(e.nd));
      });
      _shapeMaster.lastPhase = phase;
      _shapeMasterDraw(phase);
      _shapeMaster.raf = requestAnimationFrame(_shapeMasterTick);
    }
    function _shapeMasterStart() {
      if (_shapeMaster.running) return;
      if (!_masterActiveCfg()) return;        // nothing to play
      try { _shapeSpinStop(); } catch (e) {}   // never run the editor + master loops together
      _shapeMaster.running = true; _shapeMaster.t0 = performance.now() / 1000; _shapeMaster.lastPhase = -1e-9;
      _shapeMaster.raf = requestAnimationFrame(_shapeMasterTick); _shapeMasterReflectBtn();
    }
    function _shapeMasterStop() {
      const was = _shapeMaster.running;
      try { _shapeSpinStop(); } catch (e) {}   // Stop halts any shape audition
      _shapeMaster.running = false;
      if (_shapeMaster.raf) { cancelAnimationFrame(_shapeMaster.raf); _shapeMaster.raf = 0; }
      if (was) { try { if (typeof silenceActiveVoices === 'function') silenceActiveVoices(); } catch (e) {} }  // cut ringing notes only when actually stopping
      _shapeMasterReflectBtn();
      if (_shapeMaster.inited) _shapeMasterDraw(0);
    }
    function _shapeMasterReflectBtn() {
      const b = document.getElementById('shape-master-play');
      if (b) { b.textContent = _shapeMaster.running ? '■ Stop' : '▶ Play'; b.classList.toggle('active', _shapeMaster.running); }
    }
    // Tap the active wheel → open it in the full editor.
    function _shapeMasterClick(e) {
      if (activeMasterShapeId != null) _shapeMasterEditOpen(activeMasterShapeId);
    }
    // ----- edit a copy with the full lane editor (reparented #shape-pad) ------
    function _shapeMasterReflectEditUI() {
      const bar = document.getElementById('shape-master-editbar'); if (!bar) return;
      const c = _masterShapeById(_shapeMasterEditId);
      bar.innerHTML = '';
      const back = document.createElement('button');
      back.type = 'button'; back.className = 'shape-btn'; back.id = 'shape-master-done';
      back.textContent = '◀ Done';
      back.title = 'Stop editing this master shape and return to the overview';
      back.addEventListener('click', () => _shapeMasterEditClose());
      const lbl = document.createElement('span');
      lbl.textContent = 'Editing master shape: ' + ((c && c.name) || '?');
      bar.appendChild(back); bar.appendChild(lbl);
    }
    function _shapeMasterEditOpen(id) {
      const copy = _masterShapeById(id); if (!copy) return;
      // Single #shape-pad — if a Bloom Shape layer has it open, hand it back first.
      try { if (typeof _ambShapeEditRef !== 'undefined' && _ambShapeEditRef && typeof _ambShapeEditClose === 'function') _ambShapeEditClose(); } catch (e) {}
      if (!copy.shape || typeof copy.shape !== 'object') copy.shape = _shapeDefault();
      copy.shape = _shapeNormalize(copy.shape);
      try { _shapeMasterStop(); } catch (e) {}
      _shapeMasterEditId = id;
      activeMasterShapeId = id;
      // Bind the entire editor to a synthetic lane wrapping this copy. Edits to
      // copy.shape (same object held by masterShapes) persist via persistWorkspace.
      _shapeEditTarget = { name: copy.name, shape: copy.shape, shapeMode: true, _masterId: id };
      // Reparent the lane Shape editor into the Mix edit host (ids/listeners
      // travel with the node). Remember exactly where it was so we restore it.
      const pad = document.getElementById('shape-pad');
      const host = document.getElementById('shape-master-edithost');
      if (pad && host) {
        if (!_shapePadHome) _shapePadHome = { parent: pad.parentNode, next: pad.nextSibling };
        host.appendChild(pad);
      }
      document.body.classList.add('master-shape-edit');
      _shapeMasterReflectEditUI();
      // Make sure the canvas listeners exist (guarded — binds once), then build
      // the toolbar + size + draw against the override.
      try { if (typeof _shapeInit === 'function') _shapeInit(); } catch (e) {}
      requestAnimationFrame(() => { try { _shapeBuildToolbar(); _shapeResize(); _shapeDraw(); } catch (e) {} });
    }
    function _shapeMasterEditClose() {
      if (_shapeMasterEditId == null && !_shapeEditTarget) return;
      try { _shapeSpinStop(); } catch (e) {}
      // Move #shape-pad back to its Make home.
      const pad = document.getElementById('shape-pad');
      if (pad && _shapePadHome && _shapePadHome.parent) {
        if (_shapePadHome.next && _shapePadHome.next.parentNode === _shapePadHome.parent)
          _shapePadHome.parent.insertBefore(pad, _shapePadHome.next);
        else _shapePadHome.parent.appendChild(pad);
      }
      _shapePadHome = null;
      document.body.classList.remove('master-shape-edit');
      _shapeEditTarget = null;
      _shapeMasterEditId = null;
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      // Rebuild the lane editor against the REAL active lane so Make is correct
      // the next time it's shown.
      try { if (typeof _shapeRetargetLane === 'function') _shapeRetargetLane(); } catch (e) {}
      _shapeMaster.legendKey = null;   // force the browser to rebuild
      try { _shapeMasterReflectBtn(); } catch (e) {}
      requestAnimationFrame(() => { try { _shapeMasterResize(); _shapeMasterDraw(0); } catch (e) {} });
    }
    function _shapeMasterInit() {
      _shapeMaster.canvas = document.getElementById('shape-master-canvas');
      if (!_shapeMaster.canvas) return;
      if (!_shapeMaster.inited) {
        _shapeMaster.ctx = _shapeMaster.canvas.getContext('2d');
        const bar = document.getElementById('shape-master-bar');
        if (bar) {
          bar.innerHTML = '<button type="button" class="shape-btn" id="shape-master-play">▶ Play</button>' +
            '<button type="button" class="shape-btn" id="shape-master-edit">✎ Edit</button>' +
            '<button type="button" class="shape-btn" id="shape-master-capture" title="Record the active shape\'s audio to a take you can upload to Drive">⤓ Capture</button>' +
            '<span style="color:#8a8aa8;font-size:0.72rem">Each “◎ Send” saves a copy here. Click a version to select it, ✎ to edit, ✕ to delete.</span>';
          const pb = bar.querySelector('#shape-master-play');
          if (pb) pb.addEventListener('click', () => { if (_shapeMaster.running) _shapeMasterStop(); else _shapeMasterStart(); });
          const eb = bar.querySelector('#shape-master-edit');
          if (eb) eb.addEventListener('click', () => { if (activeMasterShapeId != null) _shapeMasterEditOpen(activeMasterShapeId); });
          const cb = bar.querySelector('#shape-master-capture');
          if (cb) cb.addEventListener('click', () => { try { _shapeMasterCaptureToggle(); } catch (e) { console.warn('shape capture failed', e); } });
        }
        _shapeMaster.canvas.addEventListener('click', _shapeMasterClick);
        const _redrawIfShapes = () => {
          const v = document.getElementById('mix-view');
          if (v && v.classList.contains('mix-sub-shapes')) {
            requestAnimationFrame(() => { _shapeMasterResize(); _shapeMasterDraw(_shapeMaster.running ? _shapeMaster.lastPhase : 0); });
          }
        };
        window.addEventListener('resize', _redrawIfShapes);
        // Returning to Mix (Make → Mix) with Shapes already the active subtab
        // doesn't re-run selectSub, so re-read + redraw here to pick up any
        // wheels sent since the pane was last drawn.
        const mixTab = document.getElementById('mix-tab');
        if (mixTab) mixTab.addEventListener('click', _redrawIfShapes);
        _shapeMaster.inited = true;
      }
      try { _shapeSpinStop(); } catch (e) {}   // opening the master halts any editor audition
      _shapeMasterReflectBtn();
      try { _shapeRefreshCaptureBtn(); } catch (e) {}
      try { if (typeof _ambRenderCaptureBank === 'function') _ambRenderCaptureBank(); } catch (e) {}   // populate the shared bank
      requestAnimationFrame(() => { _shapeMasterResize(); _shapeMasterDraw(0); });
    }
