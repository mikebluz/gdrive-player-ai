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
    function _shapeDefault() {
      return {
        nodeCount: 4,
        timingMode: 'equal',   // 'equal' (locked even) | 'free' (drag anywhere) | 'snap'
        snapDiv: 16,           // snap subdivisions per bar (timingMode 'snap')
        rotationDeg: 0,        // whole-wheel phase offset (off-beat)
        tone: '',              // '' = follow the lane/grid voice
        baseNote: null,        // default pitch for nodes (null = grid default)
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
        out.push({ angleFrac: i / n, muted: old ? !!old.muted : false, override: old && old.override });
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
      if (typeof s.tone !== 'string') s.tone = d.tone;
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
      pts.forEach((p) => {
        const flash = p.nd._flash ? Math.max(0, 1 - (tnow - p.nd._flash) / 180) : 0;
        const rad = 9 + flash * 6;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 2 * Math.PI);
        if (p.nd.muted) {
          ctx.fillStyle = 'rgba(40,40,60,0.9)'; ctx.fill();
          ctx.strokeStyle = 'rgba(120,120,150,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
        } else {
          ctx.fillStyle = flash > 0 ? '#ffffff' : '#4fd1c5'; ctx.fill();
          ctx.strokeStyle = flash > 0 ? 'rgba(79,209,197,0.9)' : 'rgba(13,13,24,0.9)';
          ctx.lineWidth = 2; ctx.stroke();
        }
        // Pitch label outside the node when it's tuned off the base note.
        const off = _shapeNodeOffset(p.nd);
        if (off !== 0 && !p.nd.muted) {
          const base = Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60;
          const a = 2 * Math.PI * (((p.nd.angleFrac + rotFrac) % 1 + 1) % 1);
          ctx.fillStyle = 'rgba(203,213,224,0.9)';
          ctx.font = '10px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(_shapeNoteName(base + off), p.x + Math.sin(a) * 17, p.y - Math.cos(a) * 17);
        }
      });
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
    function _shapeTriggerNode(cfg, nd, a, sortedAngles) {
      let next = null;
      for (let i = 0; i < sortedAngles.length; i++) { if (sortedAngles[i] > a + 1e-6) { next = sortedAngles[i]; break; } }
      if (next == null) next = (sortedAngles[0] != null ? sortedAngles[0] : a) + 1;
      const gap = Math.max(0.02, next - a);
      const durMs = Math.max(40, gap * _shapeBarSec() * 1000 * (Math.max(5, cfg.gatePct) / 100));
      const offset = (nd.override && Number.isFinite(nd.override.noteOffset)) ? nd.override.noteOffset : 0;
      const freq = _shapeBaseFreq(cfg) * Math.pow(2, offset / 12);
      const params = { type: _shapeToneType(cfg) };
      try { if (typeof Tone !== 'undefined' && Tone.start) Tone.start(); } catch (e) {}
      try { if (typeof playNote === 'function') playNote(freq, params, durMs); } catch (e) {}
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
      const eff = _shapeEffAngles(cfg);
      const sorted = eff.map(e => e.a).slice().sort((x, y) => x - y);
      eff.forEach(e => {
        if (e.nd.muted) return;
        const a = e.a;
        const crossed = wrapped ? (a > last || a <= phase) : (a > last && a <= phase);
        if (crossed) _shapeTriggerNode(cfg, e.nd, a, sorted);
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
      _shapeSpin.running = false;
      if (_shapeSpin.raf) { cancelAnimationFrame(_shapeSpin.raf); _shapeSpin.raf = 0; }
      if (_shapeRecording) { _shapeRecording = false; _shapeReflectRecBtn(); }   // stop also disarms record
      _shapeReflectSpinBtn();
      if (_shapeInited) _shapeDraw(0);
    }
    function _shapeReflectSpinBtn() {
      const btn = document.getElementById('shape-spin-btn');
      if (btn) { btn.textContent = _shapeSpin.running ? '■' : '▶'; btn.classList.toggle('active', _shapeSpin.running); }
    }
    function _shapeReflectSendBtn() {
      const btn = document.getElementById('shape-send-btn');
      const lane = _shapeLane();
      if (btn) {
        const on = !!(lane && lane.sentToMaster);
        btn.classList.toggle('active', on);
        btn.textContent = on ? '◉' : '◎';
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
      const tone = _shapeToneType(cfg);
      const baseM = Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60;
      const A = (typeof masterFreqA === 'number') ? masterFreqA : 440;
      const eff = _shapeEffAngles(cfg).filter(e => !e.nd.muted).sort((x, y) => x.a - y.a);
      if (!eff.length) return;
      const mkRest = (beats) => ({ freq: null, label: '—', cellIndex: null, duration: 1, subdivision: Math.max(0.0625, beats) });
      const mkNote = (midi, beats) => {
        const freq = A * Math.pow(2, (midi - 69) / 12);
        let label; try { label = (typeof Tone !== 'undefined') ? Tone.Frequency(freq).toNote() : ('M' + midi); } catch (e) { label = 'M' + midi; }
        return {
          freq, label,
          cellIndex: (typeof _findCellIdxForFreq === 'function') ? (_findCellIdxForFreq(freq) || null) : null,
          sound: tone, params: { type: tone }, duration: 1, subdivision: Math.max(0.0625, beats),
        };
      };
      const out = [];
      if (eff[0].a > 1e-4) out.push(mkRest(eff[0].a * 4));            // leading rest (bar = 4 beats)
      for (let i = 0; i < eff.length; i++) {
        const a = eff[i].a;
        const next = (i + 1 < eff.length) ? eff[i + 1].a : (eff[0].a + 1);   // wrap to first
        const beats = (next - a) * 4;
        const offset = (eff[i].nd.override && Number.isFinite(eff[i].nd.override.noteOffset)) ? eff[i].nd.override.noteOffset : 0;
        out.push(mkNote(baseM + offset, beats));
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
      if (btn) { btn.classList.toggle('active', _shapeRecording); btn.textContent = '●'; btn.title = _shapeRecording ? 'Recording… click to stop' : 'Record what plays into this lane (accumulative)'; }
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
      // Actions live in the toolbar row; all numeric/dropdown inputs live in a
      // single collapsible "⚙ Wheel" panel below it.
      bar.innerHTML =
        '<button type="button" class="shape-btn" id="shape-params-btn" title="Show / hide the wheel settings">⚙ ▾</button>' +
        '<button type="button" class="shape-btn" id="shape-spray-btn" title="Spray ascending scale pitches / flatten">Spray</button>' +
        '<button type="button" class="shape-btn shape-send" id="shape-send-btn" title="Send this wheel to the Mix ▸ Shapes master overview">◎</button>' +
        '<button type="button" class="shape-btn" id="shape-clear-btn" title="Clear this lane\'s recorded steps">Clear</button>' +
        '<button type="button" class="shape-btn" id="shape-spin-btn" title="Spin (audition) / Stop">▶</button>' +
        '<button type="button" class="shape-btn shape-rec" id="shape-rec-btn" title="Record what plays into this lane (accumulative)">●</button>' +
        '<div class="shape-params" id="shape-params" hidden>' +
          stepper('Nodes', 'shape-nodes', 1, 32, 1, '') +
          '<span class="shape-ctrl"><label>Timing</label><select id="shape-timing">' +
            '<option value="equal">Equal</option><option value="free">Free</option><option value="snap">Snap</option>' +
          '</select></span>' +
          stepper('Rotate', 'shape-rot', 0, 359, 15, '°') +
          '<span class="shape-ctrl"><label>Tone</label><select id="shape-tone" class="shape-tone-sel"></select></span>' +
          stepper('Note', 'shape-note', 24, 96, 1, '') +
          stepper('Gate', 'shape-gate', 5, 100, 5, '%') +
        '</div>';
      const nodesEl = bar.querySelector('#shape-nodes');
      const timingEl = bar.querySelector('#shape-timing');
      const rotEl = bar.querySelector('#shape-rot');
      const toneEl = bar.querySelector('#shape-tone');
      const noteEl = bar.querySelector('#shape-note');
      const gateEl = bar.querySelector('#shape-gate');
      const spinEl = bar.querySelector('#shape-spin-btn');
      try {
        if (typeof populateGroupedToneSelect === 'function' && typeof getAllSoundOptions === 'function') {
          populateGroupedToneSelect(toneEl, getAllSoundOptions(), { value: '', label: 'Grid voice' });
        }
      } catch (e) {}
      if (cfg) {
        nodesEl.value = cfg.nodeCount; timingEl.value = cfg.timingMode; rotEl.value = Math.round(cfg.rotationDeg);
        toneEl.value = cfg.tone || ''; noteEl.value = Number.isFinite(cfg.baseNote) ? cfg.baseNote : 60; gateEl.value = cfg.gatePct;
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
      rotEl.addEventListener('change', () => {
        const c = _shapeCfg(); if (!c) return;
        c.rotationDeg = ((parseInt(rotEl.value, 10) || 0) % 360 + 360) % 360;
        rotEl.value = Math.round(c.rotationDeg); _shapeDraw(); persist();
      });
      toneEl.addEventListener('change', () => { const c = _shapeCfg(); if (!c) return; c.tone = toneEl.value || ''; persist(); });
      noteEl.addEventListener('change', () => { const c = _shapeCfg(); if (!c) return; c.baseNote = Math.max(24, Math.min(96, parseInt(noteEl.value, 10) || 60)); noteEl.value = c.baseNote; persist(); });
      gateEl.addEventListener('change', () => { const c = _shapeCfg(); if (!c) return; c.gatePct = Math.max(5, Math.min(100, parseInt(gateEl.value, 10) || 80)); gateEl.value = c.gatePct; persist(); });
      if (spinEl) spinEl.addEventListener('click', () => { if (_shapeSpin.running) _shapeSpinStop(); else _shapeSpinStart(); });
      const paramsBtn = bar.querySelector('#shape-params-btn');
      const paramsPanel = bar.querySelector('#shape-params');
      if (paramsBtn && paramsPanel) paramsBtn.addEventListener('click', () => {
        const open = paramsPanel.hasAttribute('hidden');
        if (open) paramsPanel.removeAttribute('hidden'); else paramsPanel.setAttribute('hidden', '');
        paramsBtn.textContent = '⚙ ' + (open ? '▴' : '▾');
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
          if (!drag.moved && cfg) { cfg.nodes[drag.idx].muted = !cfg.nodes[drag.idx].muted; _shapeDraw(); }
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
        const eff = _shapeEffAngles(s.cfg);
        const sorted = eff.map(e => e.a).slice().sort((x, y) => x - y);
        eff.forEach(e => {
          if (e.nd.muted) return;
          const a = e.a;
          const crossed = wrapped ? (a > last || a <= phase) : (a > last && a <= phase);
          if (crossed) _shapeTriggerNode(s.cfg, e.nd, a, sorted);
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
      try { _shapeSpinStop(); } catch (e) {}   // Stop halts any shape audition
      _shapeMaster.running = false;
      if (_shapeMaster.raf) { cancelAnimationFrame(_shapeMaster.raf); _shapeMaster.raf = 0; }
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
      const d = Math.hypot(x - cx, y - cy);
      let best = -1, bd = 40;
      (_shapeMaster.rings || []).forEach(r => { const dd = Math.abs(d - r.radius); if (dd < bd) { bd = dd; best = r.idx; } });
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
            '<span style="color:#8a8aa8;font-size:0.72rem">All Shape lanes share one bar clock — click a ring to edit its lane.</span>';
          const pb = bar.querySelector('#shape-master-play');
          if (pb) pb.addEventListener('click', () => { if (_shapeMaster.running) _shapeMasterStop(); else _shapeMasterStart(); });
        }
        _shapeMaster.canvas.addEventListener('click', _shapeMasterClick);
        window.addEventListener('resize', () => {
          const v = document.getElementById('mix-view');
          if (v && v.classList.contains('mix-sub-shapes')) { _shapeMasterResize(); _shapeMasterDraw(_shapeMaster.running ? _shapeMaster.lastPhase : 0); }
        });
        _shapeMaster.inited = true;
      }
      try { _shapeSpinStop(); } catch (e) {}   // opening the master halts any editor audition
      _shapeMasterReflectBtn();
      requestAnimationFrame(() => { _shapeMasterResize(); _shapeMasterDraw(0); });
    }
