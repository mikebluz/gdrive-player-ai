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
      });
      // Keep nodeCount and nodes.length in agreement.
      if (s.nodes.length !== s.nodeCount) {
        if (s.timingMode === 'equal') s.nodes = _shapeEqualNodes(s.nodeCount, s.nodes);
        else s.nodeCount = s.nodes.length;
      }
      return s;
    }
    function _shapeLane() {
      return (typeof lanes !== 'undefined' && typeof activeLaneIdx !== 'undefined') ? lanes[activeLaneIdx] : null;
    }
    // Ensure the active lane has a normalized shape config; returns it (or null).
    function _shapeCfg() {
      const lane = _shapeLane();
      if (!lane) return null;
      if (!lane.shape || typeof lane.shape !== 'object') lane.shape = _shapeDefault();
      return _shapeNormalize(lane.shape);
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
      const dpr = window.devicePixelRatio || 1;
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
      const ctx = _shapeCtx;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) / 2 - 26;
      _shapeGeo = { cx, cy, R };
      const ph = (typeof phase === 'number') ? phase : (_shapeSpin.running ? _shapeSpin.lastPhase : 0);
      // Outer guide ring.
      ctx.strokeStyle = 'rgba(120,120,160,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
      if (!cfg) return;
      const rotFrac = (cfg.rotationDeg || 0) / 360;
      const pts = cfg.nodes.map(nd => Object.assign({ nd }, _shapeNodeXY(cx, cy, R, nd.angleFrac, rotFrac)));
      // Sweeping playhead at the current bar phase (12 o'clock = phase 0).
      {
        const pa = 2 * Math.PI * (((ph % 1) + 1) % 1);
        ctx.strokeStyle = 'rgba(79,209,197,0.55)';
        ctx.lineWidth = 2;
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
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Center point.
      ctx.fillStyle = 'rgba(203,213,224,0.8)';
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fill();
      // Corner nodes (flash when recently struck).
      const tnow = performance.now();
      const idxOf = _shapeSortedEff(cfg).idxOf;
      pts.forEach((p) => {
        const flash = p.nd._flash ? Math.max(0, 1 - (tnow - p.nd._flash) / 180) : 0;
        const rad = 9 + flash * 6;
        const chord = _shapeNodeChord(cfg, p.nd, idxOf.get(p.nd));
        // Chorded nodes get an outer halo ring so they read as "more than a note".
        if (chord && !p.nd.muted) {
          ctx.beginPath(); ctx.arc(p.x, p.y, rad + 4, 0, 2 * Math.PI);
          ctx.strokeStyle = 'rgba(246,173,85,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 2 * Math.PI);
        if (p.nd.muted) {
          ctx.fillStyle = 'rgba(40,40,60,0.9)'; ctx.fill();
          ctx.strokeStyle = 'rgba(120,120,150,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
        } else {
          ctx.fillStyle = flash > 0 ? '#ffffff' : (chord ? '#f6ad55' : '#4fd1c5'); ctx.fill();
          ctx.strokeStyle = flash > 0 ? 'rgba(79,209,197,0.9)' : 'rgba(13,13,24,0.9)';
          ctx.lineWidth = 2; ctx.stroke();
        }
        // Label outside the node: chord name when chorded, else pitch when tuned
        // off the base note.
        if (!p.nd.muted) {
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
    function _shapeBarSec() {
      const bpm = (typeof tempoInput !== 'undefined' && tempoInput) ? (parseInt(tempoInput.value, 10) || 120) : 120;
      return (60 / bpm) * 4;   // 4 beats per bar
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
      _shapeDraw();
      _shapeReflectSprayBtn();
      try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
    }
    function _shapeFlattenPitch() {
      const cfg = _shapeCfg(); if (!cfg) return;
      cfg.nodes.forEach(nd => { if (nd.override) nd.override.noteOffset = 0; });
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
      const persist = () => { try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {} };
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
        '<div style="display:flex;gap:8px;margin-top:10px">' +
          '<button type="button" class="sm-preview" id="snode-sound" style="flex:1">Sound editor…</button>' +
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
    function _shapeTriggerNode(cfg, nd, a, sortedAngles, sortedIdx) {
      let next = null;
      for (let i = 0; i < sortedAngles.length; i++) { if (sortedAngles[i] > a + 1e-6) { next = sortedAngles[i]; break; } }
      if (next == null) next = (sortedAngles[0] != null ? sortedAngles[0] : a) + 1;
      const gap = Math.max(0.02, next - a);
      const durMs = Math.max(40, gap * _shapeBarSec() * 1000 * (Math.max(5, cfg.gatePct) / 100));
      const sound = _shapeNodeSound(cfg, nd);
      const chord = _shapeNodeChord(cfg, nd, sortedIdx);
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      try {
        if (typeof playNote === 'function') {
          if (chord) {
            _shapeChordFreqs(cfg, nd, chord).forEach(f => playNote(f, Object.assign({}, sound), durMs));
          } else {
            const freq = _shapeBaseFreq(cfg) * Math.pow(2, _shapeNodeOffset(nd) / 12);
            playNote(freq, sound, durMs);
          }
        }
      } catch (e) {}
      nd._flash = performance.now();
    }
    function _shapeSpinTick() {
      if (!_shapeSpin.running) return;
      const cfg = _shapeCfg();
      if (!cfg) { _shapeSpinStop(); return; }
      const barSec = _shapeBarSec();
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
      const btn = document.getElementById('shape-send-btn');
      const lane = _shapeLane();
      if (btn) {
        const on = !!(lane && lane.sentToMaster);
        btn.classList.toggle('active', on);
        btn.textContent = on ? '◉ Sent' : '◎ Send';
        btn.title = on ? 'In the Mix ▸ Shapes master — click to remove' : 'Send this wheel to the Mix ▸ Shapes master overview';
      }
    }

    // ---- Record-to-lane (accumulative overdub) -----------------------------
    // Each completed bar while armed compiles the wheel's UNMUTED nodes into a
    // bar of lane steps (consecutive note durations from the angular gaps; a
    // leading rest if the first hit isn't on the downbeat) and APPENDS them to
    // the active lane's sequence — so the lane grows with whatever you play.
    let _shapeRecording = false;
    function _shapeRecordBar() {
      const cfg = _shapeCfg(); if (!cfg) return;
      if (typeof sequence === 'undefined' || !Array.isArray(sequence)) return;
      const baseM = Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60;
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const idxOf = _shapeSortedEff(cfg).idxOf;
      const eff = _shapeEffAngles(cfg).filter(e => !e.nd.muted).sort((x, y) => x.a - y.a);
      if (!eff.length) return;
      const freqLabel = (freq) => { try { return (typeof Tone !== 'undefined') ? Tone.Frequency(freq).toNote() : ('' + Math.round(freq)); } catch (e) { return '' + Math.round(freq); } };
      const mkVoice = (freq, sound) => ({
        freq, label: freqLabel(freq),
        cellIndex: (typeof _findCellIdxForFreq === 'function') ? (_findCellIdxForFreq(freq) || null) : null,
        sound: sound.type, params: Object.assign({}, sound),
      });
      const mkRest = (beats) => ({ freq: null, label: '—', cellIndex: null, duration: 1, subdivision: Math.max(0.0625, beats) });
      // A node records as a chord step when it plays a chord, else a single note;
      // either way it captures the node's own (per-node / per-shape) voice.
      const mkStep = (nd, beats) => {
        const sub = Math.max(0.0625, beats);
        const sound = _shapeNodeSound(cfg, nd);
        const chord = _shapeNodeChord(cfg, nd, idxOf.get(nd));
        if (chord) {
          const voices = _shapeChordFreqs(cfg, nd, chord).map(f => mkVoice(f, sound));
          return { chord: voices, label: voices.map(v => v.label).join('·'), duration: 1, subdivision: sub };
        }
        const offset = _shapeNodeOffset(nd);
        const v = mkVoice(A * Math.pow(2, (baseM + offset - 69) / 12), sound);
        return Object.assign(v, { duration: 1, subdivision: sub });
      };
      const out = [];
      if (eff[0].a > 1e-4) out.push(mkRest(eff[0].a * 4));            // leading rest (bar = 4 beats)
      for (let i = 0; i < eff.length; i++) {
        const a = eff[i].a;
        const next = (i + 1 < eff.length) ? eff[i + 1].a : (eff[0].a + 1);   // wrap to first
        out.push(mkStep(eff[i].nd, (next - a) * 4));
      }
      out.forEach(s => sequence.push(s));
      try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
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
    function _shapeClearLane() {
      if (typeof sequence !== 'undefined' && Array.isArray(sequence)) {
        sequence.length = 0;
        try { if (typeof renderSequence === 'function') renderSequence(); } catch (e) {}
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
      }
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
        '<button type="button" class="shape-btn" id="shape-params-btn" title="Show / hide the wheel settings">⚙ Wheel ▾</button>' +
        '<button type="button" class="shape-btn" id="shape-spray-btn" title="Spray ascending scale pitches / flatten">Spray</button>' +
        '<button type="button" class="shape-btn" id="shape-edit-btn" title="Edit mode: tap a node to open its Sound / Chord editor (instead of mute)">✎ Edit</button>' +
        '<button type="button" class="shape-btn shape-send" id="shape-send-btn" title="Send this wheel to the Mix ▸ Shapes master overview">◎ Send</button>' +
        '<button type="button" class="shape-btn" id="shape-clear-btn" title="Clear this lane\'s recorded steps">Clear</button>' +
        '<button type="button" class="shape-btn" id="shape-spin-btn" title="Spin (audition) / Stop">▶ Play</button>' +
        '<button type="button" class="shape-btn shape-rec" id="shape-rec-btn" title="Record what plays into this lane (accumulative)">● Rec</button>' +
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
      const persist = () => { try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {} };
      nodesEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return;
        const n = Math.max(1, Math.min(32, parseInt(nodesEl.value, 10) || 4));
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
        lane.sentToMaster = !lane.sentToMaster;
        _shapeReflectSendBtn();
        try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (e) {}
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
          drag = { idx: i, moved: false, sx: x, sy: y };
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
        });
        const endDrag = (e) => {
          if (drag.idx < 0) return;
          const cfg = _shapeCfg();
          if (!drag.moved && cfg) {
            // Edit mode: a tap opens the node's Sound / Chord editor. Otherwise
            // a tap toggles mute (the default interaction).
            if (_shapeEditMode) _shapeEditNode(drag.idx);
            else { cfg.nodes[drag.idx].muted = !cfg.nodes[drag.idx].muted; _shapeDraw(); }
          }
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
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (ex) {}
        }, { passive: false });
        _shapeInited = true;
      }
      _shapeBuildToolbar();
      // Defer one frame so the stage has laid out before measuring.
      requestAnimationFrame(() => { _shapeResize(); _shapeDraw(); });
    }
    function _onShapeModeChanged(active) {
      if (active) _shapeInit();
      else _shapeSpinStop();
    }
    function _shapeRetargetLane() {
      if (_shapeInited && document.body.classList.contains('shape-mode')) {
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
    let _shapeMaster = { canvas: null, ctx: null, inited: false, raf: 0, running: false, t0: 0, lastPhase: 0, rings: [] };
    function _shapeRgba(hex, a) {
      const h = hex.replace('#', '');
      const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
      const n = parseInt(f, 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    function _shapeMasterLanes() {
      if (typeof lanes === 'undefined') return [];
      const out = [];
      lanes.forEach((l, i) => {
        // Only lanes explicitly SENT to the master (→ Master) appear here.
        if (l && l.shapeMode && l.sentToMaster) {
          if (!l.shape || typeof l.shape !== 'object') l.shape = _shapeDefault();
          out.push({ lane: l, idx: i, cfg: _shapeNormalize(l.shape), color: SHAPE_COLORS[i % SHAPE_COLORS.length] });
        }
      });
      return out;
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
    function _shapeDrawWheelAt(ctx, cx, cy, R, cfg, color) {
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
      const tnow = performance.now();
      pts.forEach(p => {
        const flash = p.nd._flash ? Math.max(0, 1 - (tnow - p.nd._flash) / 180) : 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6 + flash * 5, 0, 2 * Math.PI);
        if (p.nd.muted) { ctx.fillStyle = 'rgba(40,40,60,0.85)'; ctx.fill(); ctx.strokeStyle = 'rgba(120,120,150,0.5)'; ctx.lineWidth = 1; ctx.stroke(); }
        else { ctx.fillStyle = flash > 0 ? '#ffffff' : color; ctx.fill(); }
      });
    }
    function _shapeMasterDraw(phase) {
      const ctx = _shapeMaster.ctx, cv = _shapeMaster.canvas; if (!ctx || !cv) return;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.width / dpr, H = cv.height / dpr;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const Rmax = Math.min(W, H) / 2 - 30, Rmin = Rmax * 0.3;
      const sl = _shapeMasterLanes();
      _shapeMasterLegend(sl);
      if (!sl.length) {
        ctx.fillStyle = 'rgba(120,120,150,0.7)'; ctx.font = '14px Segoe UI, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('No shapes sent yet — press “→ Master” in a Shape lane.', cx, cy);
        _shapeMaster.rings = []; return;
      }
      const N = sl.length;
      _shapeMaster.rings = sl.map((s, i) => ({
        idx: s.idx, cfg: s.cfg, color: s.color,
        radius: N > 1 ? (Rmin + (Rmax - Rmin) * ((N - 1 - i) / (N - 1))) : Rmax,
      }));
      // Shared playhead.
      const ph = (typeof phase === 'number') ? phase : (_shapeMaster.running ? _shapeMaster.lastPhase : 0);
      const pa = 2 * Math.PI * (((ph % 1) + 1) % 1);
      ctx.strokeStyle = 'rgba(79,209,197,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Rmax * Math.sin(pa), cy - Rmax * Math.cos(pa)); ctx.stroke();
      _shapeMaster.rings.forEach(r => _shapeDrawWheelAt(ctx, cx, cy, r.radius, r.cfg, r.color));
      ctx.fillStyle = 'rgba(203,213,224,0.8)'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fill();
    }
    function _shapeMasterLegend(sl) {
      const el = document.getElementById('shape-master-legend'); if (!el) return;
      el.innerHTML = '';
      if (!sl.length) {
        const hint = document.createElement('span'); hint.className = 'sm-leg'; hint.style.cursor = 'default';
        hint.textContent = 'No shapes sent — open a Shape lane in Make and press “→ Master”.';
        el.appendChild(hint); return;
      }
      sl.forEach(s => {
        const item = document.createElement('span'); item.className = 'sm-leg';
        const sw = document.createElement('span'); sw.className = 'sm-swatch'; sw.style.background = s.color;
        const nm = document.createElement('span');
        nm.textContent = (s.lane.name || ('Lane ' + (s.idx + 1))) + ' · ' + s.cfg.nodes.length;
        const jump = () => _shapeMasterJump(s.idx);
        sw.addEventListener('click', jump); nm.addEventListener('click', jump);
        const rm = document.createElement('span');
        rm.textContent = '✕'; rm.title = 'Remove from master';
        rm.style.cssText = 'cursor:pointer;color:#8a8aa8;margin-left:2px';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          s.lane.sentToMaster = false;
          try { if (typeof persistWorkspace === 'function') persistWorkspace(); } catch (x) {}
          _shapeMasterDraw(_shapeMaster.running ? _shapeMaster.lastPhase : 0);
        });
        item.appendChild(sw); item.appendChild(nm); item.appendChild(rm);
        el.appendChild(item);
      });
    }
    function _shapeMasterTick() {
      if (!_shapeMaster.running) return;
      const barSec = _shapeBarSec();
      const now = performance.now() / 1000;
      const phase = (((now - _shapeMaster.t0) % barSec) / barSec + 1) % 1;
      const last = _shapeMaster.lastPhase, wrapped = phase < last;
      _shapeMasterLanes().forEach(s => {
        const { eff, sortedAngles: sorted, idxOf } = _shapeSortedEff(s.cfg);
        eff.forEach(e => {
          if (e.nd.muted) return;
          const a = e.a;
          const crossed = wrapped ? (a > last || a <= phase) : (a > last && a <= phase);
          if (crossed) _shapeTriggerNode(s.cfg, e.nd, a, sorted, idxOf.get(e.nd));
        });
      });
      _shapeMaster.lastPhase = phase;
      _shapeMasterDraw(phase);
      _shapeMaster.raf = requestAnimationFrame(_shapeMasterTick);
    }
    function _shapeMasterStart() {
      if (_shapeMaster.running) return;
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
      if (b) { b.textContent = _shapeMaster.running ? '■ Stop' : '▶ Play all'; b.classList.toggle('active', _shapeMaster.running); }
    }
    function _shapeMasterJump(idx) {
      if (typeof lanes === 'undefined' || !lanes[idx]) return;
      _shapeMasterStop();
      try { activeLaneIdx = idx; } catch (e) {}
      try { if (typeof _aliasSequenceToActiveLane === 'function') _aliasSequenceToActiveLane(); } catch (e) {}
      try { if (typeof _syncFluidGridToActiveLane === 'function') _syncFluidGridToActiveLane(); } catch (e) {}
      try { const mk = document.getElementById('bloops-tab'); if (mk) mk.click(); } catch (e) {}
    }
    function _shapeMasterClick(e) {
      const cv = _shapeMaster.canvas; if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const dpr = window.devicePixelRatio || 1;
      const cx = (cv.width / dpr) / 2, cy = (cv.height / dpr) / 2;
      // Jump to edit ONLY when a NODE is clicked (within ~14px) — not anywhere
      // on the ring, which would yank you to Make on almost any click.
      let best = -1, bd = 14;
      (_shapeMaster.rings || []).forEach(r => {
        const rotFrac = (r.cfg.rotationDeg || 0) / 360;
        r.cfg.nodes.forEach(nd => {
          const p = _shapeNodeXY(cx, cy, r.radius, nd.angleFrac, rotFrac);
          const dd = Math.hypot(x - p.x, y - p.y);
          if (dd < bd) { bd = dd; best = r.idx; }
        });
      });
      if (best >= 0) _shapeMasterJump(best);
    }
    function _shapeMasterInit() {
      _shapeMaster.canvas = document.getElementById('shape-master-canvas');
      if (!_shapeMaster.canvas) return;
      if (!_shapeMaster.inited) {
        _shapeMaster.ctx = _shapeMaster.canvas.getContext('2d');
        const bar = document.getElementById('shape-master-bar');
        if (bar) {
          bar.innerHTML = '<button type="button" class="shape-btn" id="shape-master-play">▶ Play all</button>' +
            '<span style="color:#8a8aa8;font-size:0.72rem">All Shape lanes share one bar clock — click a node (or a legend entry) to edit its lane.</span>';
          const pb = bar.querySelector('#shape-master-play');
          if (pb) pb.addEventListener('click', () => { if (_shapeMaster.running) _shapeMasterStop(); else _shapeMasterStart(); });
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
      requestAnimationFrame(() => { _shapeMasterResize(); _shapeMasterDraw(0); });
    }
