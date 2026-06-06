    // ---- Game-mode polygon pad -------------------------------------------
    // Third state of the Grid/Graph/Game toggle. Builds a regular polygon
    // whose side count matches notes.length (scale degrees × octaves) and
    // colors each side from the same per-pitch-class palette the grid uses.
    // A free ball lives inside; tap to start motion / pause. Ball→side hits
    // play that side's note. Polygon→canvas-edge hits play the last 3
    // ball-side notes as a chord.
    let _gameInited = false;
    let _gameActive = false;
    let _gameRunning = false;
    let _gamePadEl = null, _gameCanvasWrap = null, _gameCanvas = null, _gameCtx = null;
    let _gameRaf = 0, _gameLastT = 0;
    let _gameN = 0, _gameR = 100;
    let _gameSideColors = [];
    let _gameLastNotes = [];
    // One entry per polygon side, in the same order vertices are drawn.
    // { cellIdx: index into the chromatic `notes` array — used to look up
    //   freq + cellParams; freq: cached freq; pc: pitch class for color. }
    let _gameNotes = [];
    const _gameShape = { cx: 0, cy: 0, vx: 0, vy: 0, rot: 0, omega: 0 };
    const _gameBall  = { x: 0, y: 0, vx: 0, vy: 0, r: 9 };
    // User-tunable values driven by the four sliders. Defaults match
    // the input[type=range] value= attributes in the markup so the
    // first frame matches what the sliders show.
    let _gameUserBallSize  = 9;
    let _gameUserBallSpeed = 200;
    let _gameUserShapeFrac = 0.75; // 0.30..1.00 of max circumradius
    let _gameUserShapeSpeed = 80;
    let _gameBallMuted = false;
    let _gameShapeMuted = false;
    let _gameUserBallOct = 0;
    let _gameUserShapeOct = 0;
    let _gameUserBallTone  = null; // null/'' = inherit the cell's tone
    let _gameUserShapeTone = null;
    // When true, every chord-change rebuild scatters the chord's notes
    // across random octaves within the grid's octaveCount range. The
    // polygon keeps one side per chord note (no octave-driven side
    // multiplication) so a triad still renders as a triangle, but the
    // pitches roam between octaves each time the chord advances.
    let _gameRandomOctaves = false;
    // Ball physics mode — incrementally peels back the "classic" speed
    // clamp + stationary-frame reflection in three steps so the user
    // can A/B/C/D the feel:
    //   classic  → original (elastic, speed renormalized after every
    //              bounce, reflection ignores polygon motion).
    //   kinetic  → reflect in the contact side's frame of reference
    //              (subtract side velocity at contact, reflect, add
    //              back); speed still clamped, so the change shows up
    //              as a redirection cue from a spinning shape.
    //   momentum → kinetic + drop the speed clamp; small restitution
    //              loss per bounce keeps the ball from accelerating
    //              forever as the rotating polygon pumps energy in.
    //   gravity  → momentum + a downward force so the ball settles
    //              and rolls along the bottom side between hops.
    let _gameBallPhysics = 'classic';
    // Shape touch-interaction modes. 'off' keeps the legacy behavior
    // (canvas tap toggles run / pause). 'drag' lets the user grab the
    // shape and fling it with release momentum. 'magnet' steers the
    // shape toward the held pointer continuously. 'tap' impulses the
    // shape away from each tap point. The non-Off modes still treat a
    // quick stationary tap as a run/pause toggle so the user keeps that
    // gesture available without leaving the mode.
    let _gameShapeInteraction = 'off';
    const _gameInteract = {
      active: false, pointerId: null,
      startX: 0, startY: 0, startT: 0,
      curX: 0, curY: 0,
      // Recent (position, timestamp) samples — used to compute throw
      // velocity on drag-release from the last ~100 ms of motion so a
      // sharp wrist flick at the end of the gesture overrides any slow
      // build-up earlier in the drag.
      samples: [],
      // True after a drag-grab on the shape; pointer position drives
      // _gameShape.cx / cy until release.
      grabbed: false,
      grabDx: 0, grabDy: 0,
    };
    // Retrigger guards — when the ball gets "caught" on a side (rotating
    // shape pushing it tangent to a vertex, etc.) it can produce dozens
    // of hits per second; without a cooldown the synth voices stack and
    // the audio distorts. Per-side ms timestamp + global ms timestamp
    // for the shape's edge-bounce chord.
    const _GAME_SIDE_COOLDOWN_MS  = 70;
    const _GAME_SHAPE_COOLDOWN_MS = 110;
    let _gameSideLastHitMs = new Float64Array(0);
    let _gameShapeLastBounceMs = 0;

    function _gameSize() {
      if (!_gameCanvas) return;
      const margin = 14;
      const W = _gameCanvas.width, H = _gameCanvas.height;
      const maxR = Math.max(20, Math.min(W, H) / 2 - margin);
      _gameR = maxR * _gameUserShapeFrac;
      _gameBall.r = _gameUserBallSize;
    }
    function _gameRecenter() {
      if (!_gameCanvas) return;
      _gameShape.cx = _gameCanvas.width / 2;
      _gameShape.cy = _gameCanvas.height / 2;
      _gameShape.rot = 0;
      _gameShape.vx = _gameShape.vy = _gameShape.omega = 0;
      _gameBall.x = _gameShape.cx;
      _gameBall.y = _gameShape.cy;
      _gameBall.vx = _gameBall.vy = 0;
    }
    function _gameResize() {
      if (!_gameCanvas) return;
      const host = _gameCanvasWrap || _gamePadEl;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const w = Math.max(2, Math.round(rect.width));
      const h = Math.max(2, Math.round(rect.height));
      const oldW = _gameCanvas.width, oldH = _gameCanvas.height;
      if (_gameCanvas.width !== w)  _gameCanvas.width  = w;
      if (_gameCanvas.height !== h) _gameCanvas.height = h;
      _gameSize();
      if (!_gameRunning) {
        _gameRecenter();
      } else if (oldW > 0 && oldH > 0 && (oldW !== w || oldH !== h)) {
        // Mid-play resize: scale shape + ball positions to the new
        // canvas so the relative layout survives, then let the inside-
        // polygon guard catch anything that still ends up outside.
        const sx = w / oldW, sy = h / oldH;
        _gameShape.cx *= sx; _gameShape.cy *= sy;
        _gameBall.x *= sx;   _gameBall.y *= sy;
        _gameEnsureBallInside();
      }
    }
    function _gameRefresh() {
      _gameNotes = [];
      _gameSideColors = [];
      // Chord override — when set, the polygon's sides are the chord's
      // notes rooted on rootIdx, repeated across octaveCount octaves.
      // Falls back to the scale-filter path otherwise.
      const activeEntry = _activeChordEntry();
      const chordType = (activeEntry && CHORDS && CHORDS[activeEntry.quality]) || null;
      if (chordType && Array.isArray(notes) && notes.length > 0) {
        // Drive freq directly off the root cell's freq + semi shift so
        // chord extensions (9 / 11 / 13) aren't clipped by the active
        // octave count. cellIdx wraps modulo notes.length for palette
        // and cellParams lookup (params are per-pitch-class anyway).
        // rootOffset transposes the chord from the grid root up to the
        // chord's own per-chip root (so "D minor" in a C-rooted grid
        // starts at D, not C).
        const oct = Math.max(1, (typeof octaveCount === 'number') ? octaveCount : 1);
        const baseFreq = notes[0].freq;
        const rootOffset = (((activeEntry.rootPC - rootIdx) % 12) + 12) % 12;
        if (_gameRandomOctaves) {
          // One side per chord note; each note's octave is freshly
          // picked at refresh time, so every chord advance reshuffles
          // the pitches without changing the polygon's side count.
          for (const semi of chordType.semis) {
            const randOct = Math.floor(Math.random() * oct);
            const totalSemi = randOct * 12 + rootOffset + semi;
            const cellIdx = ((totalSemi % notes.length) + notes.length) % notes.length;
            const freq = baseFreq * Math.pow(2, totalSemi / 12);
            const pc = (((rootIdx + totalSemi) % 12) + 12) % 12;
            _gameNotes.push({ cellIdx, freq, pc });
            _gameSideColors.push((palette && palette[pc]) || '#9f7aea');
          }
        } else {
          for (let o = 0; o < oct; o++) {
            for (const semi of chordType.semis) {
              const totalSemi = o * 12 + rootOffset + semi;
              const cellIdx = ((totalSemi % notes.length) + notes.length) % notes.length;
              const freq = baseFreq * Math.pow(2, totalSemi / 12);
              const pc = (((rootIdx + totalSemi) % 12) + 12) % 12;
              _gameNotes.push({ cellIdx, freq, pc });
              _gameSideColors.push((palette && palette[pc]) || '#9f7aea');
            }
          }
        }
      } else {
        // Side count = scale-degrees × octaves. Chromatic falls through to
        // 12 × oct. Non-chromatic scales filter the chromatic `notes`
        // array down to in-scale pitch classes.
        const intervals = (typeof SCALES !== 'undefined' && SCALES && SCALES[currentScale])
          || (typeof SCALES !== 'undefined' && SCALES && SCALES['chromatic'])
          || [];
        const tonic = (typeof _effectiveScaleTonic === 'function')
          ? _effectiveScaleTonic()
          : (typeof rootIdx === 'number' ? rootIdx : 0);
        const scalePCs = new Set(intervals.map(s => (((tonic + s) % 12) + 12) % 12));
        if (Array.isArray(notes)) {
          for (let i = 0; i < notes.length; i++) {
            const pc = (((rootIdx + i) % 12) + 12) % 12;
            if (!intervals.length || scalePCs.has(pc)) {
              _gameNotes.push({ cellIdx: i, freq: notes[i].freq, pc });
              _gameSideColors.push((palette && palette[pc]) || '#9f7aea');
            }
          }
        }
      }
      _gameN = _gameNotes.length;
      // Don't wipe the last-hit history on a polygon rebuild —
      // shape-edge bounces echo those indices, and clearing them after
      // a chord-progression advance left the very next bounce silent
      // (and the first bounce of a session, before the ball had hit
      // anything). Filter out stale indices that the new polygon
      // doesn't have a side for so _gamePlayNoteAt can't index past
      // _gameNotes.length.
      _gameLastNotes = Array.isArray(_gameLastNotes)
        ? _gameLastNotes.filter(i => Number.isInteger(i) && i >= 0 && i < _gameN)
        : [];
      _gameSideLastHitMs = new Float64Array(_gameN);
      _gameShapeLastBounceMs = 0;
      _gameSize();
      if (!_gameRunning) {
        _gameRecenter();
      } else {
        // Polygon shape just changed (chord/scale pick, octave change,
        // etc.) — if the ball is suddenly outside the new shape it'd
        // drift off-canvas; snap it back inside.
        _gameEnsureBallInside();
      }
      _gameUpdateOverlay();
      _gameSyncKeySelect();
      try { if (typeof window._populateProgressionRoot === 'function') window._populateProgressionRoot(); } catch (_) {}
      try { if (typeof window._renderProgressionChips === 'function') window._renderProgressionChips(); } catch (_) {}
    }

    function _gameSyncKeySelect() {
      const sel = document.getElementById('game-key-select');
      if (!sel) return;
      const want = String(((rootIdx % 12) + 12) % 12);
      if (sel.value !== want) sel.value = want;
    }

    function _gameUpdateOverlay() {
      const el = document.getElementById('game-info-overlay');
      if (!el) return;
      const keyLabel = (typeof CHROMATIC !== 'undefined' && CHROMATIC[((rootIdx % 12) + 12) % 12]) || 'C';
      const scaleLabel = (currentScale && currentScale !== 'chromatic'
          && typeof prettyScaleName === 'function')
        ? prettyScaleName(currentScale)
        : 'Chromatic';
      const parts = [keyLabel + ' ' + scaleLabel];
      const entry = _activeChordEntry();
      if (currentProgression.length > 0 && entry) {
        parts.push(_chipLabel(entry) + ' (' + (_gameProgressionIdx + 1) + '/' + currentProgression.length + ')');
      } else if (entry) {
        parts.push(_chipLabel(entry));
      }
      el.textContent = parts.join(' · ');
    }
    function _gameKick() {
      // Shape heads toward one of the four canvas corners (with a small
      // ±0.2 rad jitter) so the initial direction is always diagonal-ish
      // instead of occasionally near-horizontal/vertical.
      const W = _gameCanvas ? _gameCanvas.width  : 0;
      const H = _gameCanvas ? _gameCanvas.height : 0;
      const corners = [
        { x: 0, y: 0 }, { x: W, y: 0 }, { x: 0, y: H }, { x: W, y: H },
      ];
      const target = corners[(Math.random() * 4) | 0];
      const ang = Math.atan2(target.y - _gameShape.cy, target.x - _gameShape.cx)
                + (Math.random() - 0.5) * 0.4;
      _gameShape.vx = Math.cos(ang) * _gameUserShapeSpeed;
      _gameShape.vy = Math.sin(ang) * _gameUserShapeSpeed;
      _gameShape.omega = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.0);
      const a2 = Math.random() * Math.PI * 2;
      _gameBall.vx = Math.cos(a2) * _gameUserBallSpeed;
      _gameBall.vy = Math.sin(a2) * _gameUserBallSpeed;
    }
    function _gameVertices() {
      const out = new Array(_gameN);
      for (let i = 0; i < _gameN; i++) {
        const a = _gameShape.rot + (Math.PI * 2 * i) / _gameN - Math.PI / 2;
        out[i] = { x: _gameShape.cx + _gameR * Math.cos(a), y: _gameShape.cy + _gameR * Math.sin(a) };
      }
      return out;
    }
    // Inside-polygon guard — radial-shrink variant. Instead of snapping
    // the ball to the shape's center on any escape (which read as a
    // teleport every time chord mutation rebuilt the polygon), we
    // measure the ball's distance from the shape center against the
    // polygon's inscribed-circle radius (R · cos(π/N), invariant under
    // rotation) and, if the ball is outside that safe disc, pull it
    // radially inward to the inscribed boundary minus a small clearance.
    // The position correction is the minimum needed, so genuinely-inside
    // play never sees a snap and post-mutation escapes look like a quick
    // settle rather than a jump.
    function _gameEnsureBallInside() {
      if (_gameN < 3) return true;
      const inradius = _gameR * Math.cos(Math.PI / _gameN);
      const safe = Math.max(0, inradius - _gameBall.r - 2);
      const dx = _gameBall.x - _gameShape.cx;
      const dy = _gameBall.y - _gameShape.cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= safe) return true;
      if (dist > 0.001) {
        const k = safe / dist;
        _gameBall.x = _gameShape.cx + dx * k;
        _gameBall.y = _gameShape.cy + dy * k;
      } else {
        _gameBall.x = _gameShape.cx;
        _gameBall.y = _gameShape.cy;
      }
      if (_gameUserBallSpeed > 0) {
        const mag = Math.hypot(_gameBall.vx, _gameBall.vy);
        if (mag < 0.5) {
          const a = Math.random() * Math.PI * 2;
          _gameBall.vx = Math.cos(a) * _gameUserBallSpeed;
          _gameBall.vy = Math.sin(a) * _gameUserBallSpeed;
        }
      }
      return false;
    }

    function _gamePlayNoteAt(sideIdx, octShift, toneOverride) {
      if (sideIdx == null || !_gameNotes || !_gameNotes[sideIdx] || typeof playNote !== 'function') return;
      const meta = _gameNotes[sideIdx];
      // Clone so the override doesn't mutate the cell's stored params.
      const base = (Array.isArray(cellParams) && cellParams[meta.cellIdx]) ? cellParams[meta.cellIdx] : {};
      const params = { ...base };
      if (toneOverride) params.type = toneOverride;
      const freq = octShift ? meta.freq * Math.pow(2, octShift) : meta.freq;
      try { playNote(freq, params); } catch (e) {}
    }

    // Build a chord-voice / single-note payload mirroring the shape the
    // cell-grid Keep paths use, so an addToSequence(step) call from the
    // game produces a step indistinguishable from a Grid-mode tap.
    function _gameMakeVoice(sideIdx, octShift, toneOverride) {
      if (sideIdx == null || !_gameNotes || !_gameNotes[sideIdx]) return null;
      const meta = _gameNotes[sideIdx];
      const cellIdx = meta.cellIdx;
      const base = (Array.isArray(cellParams) && cellParams[cellIdx]) ? cellParams[cellIdx] : {};
      const params = { ...base };
      if (toneOverride) params.type = toneOverride;
      const freq = octShift ? meta.freq * Math.pow(2, octShift) : meta.freq;
      const label = (Array.isArray(notes) && notes[cellIdx]) ? notes[cellIdx].label : '';
      return { freq, label, cellIndex: cellIdx, sound: params.type, params };
    }
    function _gameKeepAvailable() {
      return typeof keepMode !== 'undefined' && keepMode
          && typeof addToSequence === 'function';
    }
    function _gameAppendBallStep(sideIdx) {
      if (!_gameKeepAvailable()) return;
      const v = _gameMakeVoice(sideIdx, _gameUserBallOct, _gameUserBallTone);
      if (!v) return;
      const step = {
        freq: v.freq,
        label: v.label,
        cellIndex: v.cellIndex,
        sound: v.sound,
        params: v.params,
        duration: 1,
        subdivision: (typeof stepSubdivision === 'number') ? stepSubdivision : 1,
      };
      try { addToSequence(step); } catch (_) {}
    }
    // Grid-mode chord progression — when chords are queued, a cell press
    // plays the current chord with the pressed note as root, then
    // advances the progression counter (same _gameProgressionIdx /
    // _gameProgressionHits state Game mode uses). Returns true if it
    // played a chord (so the caller can skip the normal single-note
    // play); false otherwise.
    function _gridChordPlayAt(cellIdx) {
      if (currentProgression.length === 0) return false;
      if (typeof notes === 'undefined' || !notes[cellIdx]) return false;
      const entry = _activeChordEntry();
      if (!entry) return false;
      const chordType = CHORDS && CHORDS[entry.quality];
      if (!chordType) return false;
      if (typeof playNote !== 'function') return false;
      const rootFreq = notes[cellIdx].freq;
      const baseParams = (Array.isArray(cellParams) && cellParams[cellIdx]) ? cellParams[cellIdx] : {};
      const voices = chordType.semis.map(semi => {
        const freq = rootFreq * Math.pow(2, semi / 12);
        const noteIdx = (((rootIdx + cellIdx + semi) % 12) + 12) % 12;
        const label = (typeof CHROMATIC !== 'undefined') ? (CHROMATIC[noteIdx] || '') : '';
        return {
          freq,
          label,
          cellIndex: cellIdx,
          sound: baseParams.type,
          params: { ...baseParams },
        };
      });
      for (const v of voices) {
        try { playNote(v.freq, v.params); } catch (e) {}
      }
      if (typeof keepMode !== 'undefined' && keepMode && typeof addToSequence === 'function') {
        const chordStep = {
          chord: voices,
          label: voices.map(v => v.label).join('·'),
          duration: 1,
          subdivision: (typeof stepSubdivision === 'number') ? stepSubdivision : 1,
        };
        try { addToSequence(chordStep); } catch (e) {}
      }
      _gameProgressionHits++;
      if (_gameProgressionHits >= _gameUserHitsPerChord) {
        _gameProgressionHits = 0;
        _gameProgressionIdx = (_gameProgressionIdx + 1) % currentProgression.length;
        try { if (typeof window._renderProgressionChips === 'function') window._renderProgressionChips(); } catch (_) {}
      }
      return true;
    }

    function _gameAppendShapeChordStep(fireIdxs) {
      if (!_gameKeepAvailable()) return;
      // Default to the recent ball-hit echo when no explicit fire-set
      // is passed; callers in the bounce handler pass the polygon's
      // full set as a fallback so the recorded step matches what the
      // user just heard.
      const idxs = (Array.isArray(fireIdxs) && fireIdxs.length > 0)
        ? fireIdxs
        : _gameLastNotes;
      if (!idxs || idxs.length === 0) return;
      const voices = idxs
        .map(idx => _gameMakeVoice(idx, _gameUserShapeOct, _gameUserShapeTone))
        .filter(Boolean);
      if (voices.length === 0) return;
      const chordStep = {
        chord: voices,
        label: voices.map(v => v.label).join('·'),
        duration: 1,
        subdivision: (typeof stepSubdivision === 'number') ? stepSubdivision : 1,
      };
      try { addToSequence(chordStep); } catch (_) {}
    }
    function _gameUpdate(dt) {
      if (_gameN < 3) return;
      // Magnet steering — while the user holds the pointer in 'magnet'
      // mode, nudge the shape's velocity toward the pointer. Capped at
      // ~2× the shape-speed slider so the magnet can pick up speed but
      // doesn't spike to an off-canvas velocity in a single frame.
      if (_gameShapeInteraction === 'magnet' && _gameInteract.active) {
        const dx = _gameInteract.curX - _gameShape.cx;
        const dy = _gameInteract.curY - _gameShape.cy;
        const dist = Math.hypot(dx, dy);
        if (dist > 1) {
          const baseSpeed = Math.max(20, _gameUserShapeSpeed || 80);
          // Stronger pull when far from the pointer (proportional to
          // dist, capped). Feels more responsive than a constant force.
          const pull = Math.min(dist * 6, baseSpeed * 4);
          _gameShape.vx += (dx / dist) * pull * dt;
          _gameShape.vy += (dy / dist) * pull * dt;
          const sp = Math.hypot(_gameShape.vx, _gameShape.vy);
          const cap = baseSpeed * 2;
          if (sp > cap) {
            const k = cap / sp;
            _gameShape.vx *= k; _gameShape.vy *= k;
          }
        }
      }
      // Drag-grab freezes the shape's autopilot motion — its position
      // is driven by the pointer until release, so any residual
      // velocity here would fight the user's input on each frame.
      if (_gameShapeInteraction === 'drag' && _gameInteract.grabbed) {
        _gameShape.vx = 0; _gameShape.vy = 0;
      }
      // Sub-step the physics so a single frame's motion can't overshoot
      // a side's overlap window. Bound by half the ball's radius; the
      // worst case considers ball velocity, shape translation, and the
      // tangential speed of a side under rotation (omega × R).
      const ballSpeed = Math.hypot(_gameBall.vx, _gameBall.vy);
      const shapeSpeed = Math.hypot(_gameShape.vx, _gameShape.vy);
      const tangentialSpeed = Math.abs(_gameShape.omega) * _gameR;
      const maxSpeed = Math.max(ballSpeed, shapeSpeed + tangentialSpeed, 1);
      const maxDist  = Math.max(2, _gameBall.r * 0.5);
      const steps    = Math.min(16, Math.max(1, Math.ceil(maxSpeed * dt / maxDist)));
      const subDt    = dt / steps;
      let bounced = false;
      for (let s = 0; s < steps; s++) {
        if (_gameSubStep(subDt)) bounced = true;
      }
      // Safety net — sub-stepping + the unconditional position-push in
      // _gameSubStep should keep the ball inside under steady-state
      // physics. This catches anything that slipped past after a
      // polygon-mutating change (chord/scale/octave) or a degenerate
      // overlap at a vertex.
      _gameEnsureBallInside();
      if (bounced) {
        const nowMs = performance.now();
        if (nowMs - _gameShapeLastBounceMs >= _GAME_SHAPE_COOLDOWN_MS) {
          _gameShapeLastBounceMs = nowMs;
          // Pick a fire-set for the bounce. The ball's recent hits drive
          // it whenever the user has been bouncing notes — that's the
          // echo behavior. If nothing has been hit yet (start of session
          // or first bounce after a chord-progression rebuild), fall
          // back to firing every polygon side so the user reliably hears
          // the chord on every boundary bounce.
          const fireIdxs = (Array.isArray(_gameLastNotes) && _gameLastNotes.length > 0)
            ? _gameLastNotes
            : _gameNotes.map((_, i) => i);
          if (!_gameShapeMuted) {
            for (const idx of fireIdxs) _gamePlayNoteAt(idx, _gameUserShapeOct, _gameUserShapeTone);
          }
          _gameAppendShapeChordStep(fireIdxs);
          if (currentProgression.length > 0) {
            _gameProgressionHits++;
            if (_gameProgressionHits >= _gameUserHitsPerChord) {
              _gameProgressionHits = 0;
              _gameProgressionIdx = (_gameProgressionIdx + 1) % currentProgression.length;
              try { _gameRefresh(); } catch (_) {}
            }
          }
        }
      }
    }

    // One physics integration step. Returns true if the shape bounced
    // off a canvas edge during this step so the outer driver can fire
    // the chord (deduped by the global shape cooldown).
    function _gameSubStep(dt) {
      // Gravity acts as a constant downward acceleration on the ball
      // only in the gravity mode. Apply before the position update so
      // the half-second of motion this substep covers picks up the
      // delta-v. Magnitude tuned for canvas pixels — a feel-good
      // bounce-and-roll without sucking the ball to the bottom in one
      // frame.
      if (_gameBallPhysics === 'gravity') {
        _gameBall.vy += 900 * dt;
      }
      _gameShape.cx += _gameShape.vx * dt;
      _gameShape.cy += _gameShape.vy * dt;
      _gameShape.rot += _gameShape.omega * dt;
      _gameBall.x += _gameBall.vx * dt;
      _gameBall.y += _gameBall.vy * dt;

      const verts = _gameVertices();

      // Ball vs polygon sides — collect every overlapping side this
      // substep, average their inward normals weighted by overlap depth,
      // then do ONE position correction + ONE velocity reflection +
      // ONE note trigger. Single-side hits behave like the old per-side
      // path; corner overlaps (where two sides meet) no longer trigger
      // duelling pushes that read as jitter, and they fire only one
      // note (the side with the deepest overlap) instead of two.
      // bestCX/CY capture the deepest contact point so the non-classic
      // physics modes can compute side velocity at that point for a
      // frame-of-reference reflection.
      let bestI = -1, bestOverlap = 0, bestCX = 0, bestCY = 0;
      let sumNx = 0, sumNy = 0, sumW = 0;
      for (let i = 0; i < _gameN; i++) {
        const A = verts[i], B = verts[(i + 1) % _gameN];
        const dx = B.x - A.x, dy = B.y - A.y;
        const lenSq = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((_gameBall.x - A.x) * dx + (_gameBall.y - A.y) * dy) / lenSq));
        const cX = A.x + t * dx, cY = A.y + t * dy;
        const ddx = _gameBall.x - cX, ddy = _gameBall.y - cY;
        const distSq = ddx * ddx + ddy * ddy;
        if (distSq < _gameBall.r * _gameBall.r) {
          const midX = (A.x + B.x) / 2, midY = (A.y + B.y) / 2;
          let nx = _gameShape.cx - midX, ny = _gameShape.cy - midY;
          const nlen = Math.hypot(nx, ny) || 1;
          nx /= nlen; ny /= nlen;
          const dist = Math.sqrt(distSq) || 0.0001;
          const overlap = _gameBall.r - dist;
          sumNx += nx * overlap;
          sumNy += ny * overlap;
          sumW  += overlap;
          if (overlap > bestOverlap) {
            bestOverlap = overlap; bestI = i;
            bestCX = cX; bestCY = cY;
          }
        }
      }
      if (bestI >= 0) {
        const nlen = Math.hypot(sumNx, sumNy) || 1;
        const nx = sumNx / nlen;
        const ny = sumNy / nlen;
        // Unconditional position push along the combined inward normal,
        // amount = deepest overlap so the ball ends up at the boundary
        // of the deepest-penetrating side.
        _gameBall.x += bestOverlap * nx;
        _gameBall.y += bestOverlap * ny;
        // Side velocity at the deepest contact point — translation
        // plus the rotational contribution ω × r. Stays at (0, 0) for
        // classic mode so behavior is byte-for-byte the same as before.
        let vsx = 0, vsy = 0;
        if (_gameBallPhysics !== 'classic') {
          const rx = bestCX - _gameShape.cx;
          const ry = bestCY - _gameShape.cy;
          vsx = _gameShape.vx + (-_gameShape.omega * ry);
          vsy = _gameShape.vy + ( _gameShape.omega * rx);
        }
        // Reflect in the side's frame: subtract side velocity, mirror
        // about the normal, add back. Classic falls through as vRel = v
        // since (vsx, vsy) = (0, 0).
        const vRelX = _gameBall.vx - vsx;
        const vRelY = _gameBall.vy - vsy;
        const vRelN = vRelX * nx + vRelY * ny;
        if (vRelN < 0) {
          let newRelX = vRelX - 2 * vRelN * nx;
          let newRelY = vRelY - 2 * vRelN * ny;
          // Restitution loss bleeds energy out so the rotating polygon
          // can't pump the ball to infinity in modes that drop the
          // speed clamp. Kept at 1 for classic / kinetic which still
          // renormalize speed below.
          if (_gameBallPhysics === 'momentum' || _gameBallPhysics === 'gravity') {
            newRelX *= 0.94;
            newRelY *= 0.94;
          }
          _gameBall.vx = vsx + newRelX;
          _gameBall.vy = vsy + newRelY;
          if (_gameBallPhysics === 'classic' || _gameBallPhysics === 'kinetic') {
            // Original speed-clamp behavior — the user-set speed is the
            // ball's invariant. Kinetic still benefits from the
            // frame-of-reference reflection above changing the
            // direction so a spinning shape steers the ball.
            if (_gameUserBallSpeed > 0) {
              const mag = Math.hypot(_gameBall.vx, _gameBall.vy) || 1;
              const k = _gameUserBallSpeed / mag;
              _gameBall.vx *= k;
              _gameBall.vy *= k;
            }
          } else {
            // Momentum / gravity: no speed clamp, but cap absolute
            // velocity at 8× the slider so a frantic spin can't fire
            // the ball off-canvas in one substep.
            const mag = Math.hypot(_gameBall.vx, _gameBall.vy);
            const cap = Math.max(60, (_gameUserBallSpeed || 200) * 8);
            if (mag > cap) {
              const k = cap / mag;
              _gameBall.vx *= k;
              _gameBall.vy *= k;
            }
          }
          // Per-side retrigger cooldown — keyed by the deepest-overlap
          // side so corner hits only fire one note. lastNotes dedupes
          // adjacent duplicates so a caught ball never fills the chord
          // buffer with a single repeated pitch.
          const i = bestI;
          const nowMs = performance.now();
          if (_gameSideLastHitMs[i] === undefined
              || nowMs - _gameSideLastHitMs[i] >= _GAME_SIDE_COOLDOWN_MS) {
            _gameSideLastHitMs[i] = nowMs;
            if (!_gameBallMuted) _gamePlayNoteAt(i, _gameUserBallOct, _gameUserBallTone);
            if (_gameLastNotes.length === 0
                || _gameLastNotes[_gameLastNotes.length - 1] !== i) {
              _gameLastNotes.push(i);
              if (_gameLastNotes.length > 3) _gameLastNotes.shift();
            }
            _gameAppendBallStep(i);
          }
        }
      }

      // Polygon vs canvas edges — AABB of its vertices.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const v of verts) {
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }
      const W = _gameCanvas.width, H = _gameCanvas.height;
      let bounced = false;
      if (minX < 0) { _gameShape.cx += -minX; if (_gameShape.vx < 0) { _gameShape.vx = -_gameShape.vx; bounced = true; } }
      if (maxX > W) { _gameShape.cx -= (maxX - W); if (_gameShape.vx > 0) { _gameShape.vx = -_gameShape.vx; bounced = true; } }
      if (minY < 0) { _gameShape.cy += -minY; if (_gameShape.vy < 0) { _gameShape.vy = -_gameShape.vy; bounced = true; } }
      if (maxY > H) { _gameShape.cy -= (maxY - H); if (_gameShape.vy > 0) { _gameShape.vy = -_gameShape.vy; bounced = true; } }
      return bounced;
    }
    function _gameRender() {
      if (!_gameCtx) return;
      const W = _gameCanvas.width, H = _gameCanvas.height;
      _gameCtx.fillStyle = '#0a0a14';
      _gameCtx.fillRect(0, 0, W, H);
      if (_gameN < 3) {
        _gameCtx.fillStyle = '#4a5568';
        _gameCtx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        _gameCtx.textAlign = 'center';
        _gameCtx.textBaseline = 'middle';
        _gameCtx.fillText('No notes — pick a scale', W / 2, H / 2);
        return;
      }
      const verts = _gameVertices();
      _gameCtx.lineWidth = 4;
      _gameCtx.lineCap = 'round';
      for (let i = 0; i < _gameN; i++) {
        const A = verts[i], B = verts[(i + 1) % _gameN];
        _gameCtx.strokeStyle = _gameSideColors[i] || '#fff';
        _gameCtx.beginPath();
        _gameCtx.moveTo(A.x, A.y);
        _gameCtx.lineTo(B.x, B.y);
        _gameCtx.stroke();
      }
      _gameCtx.beginPath();
      _gameCtx.arc(_gameBall.x, _gameBall.y, _gameBall.r, 0, Math.PI * 2);
      _gameCtx.fillStyle = '#ffffff';
      _gameCtx.fill();
    }
    function _gameLoop(t) {
      if (!_gameActive) { _gameRaf = 0; return; }
      const dt = Math.min(0.033, (t - _gameLastT) / 1000);
      _gameLastT = t;
      if (_gameRunning) _gameUpdate(dt);
      _gameRender();
      _gameRaf = requestAnimationFrame(_gameLoop);
    }
    function _gameInit() {
      if (_gameInited) return;
      _gameInited = true;
      _gamePadEl = document.getElementById('game-pad');
      _gameCanvasWrap = document.querySelector('.game-canvas-wrap');
      _gameCanvas = document.getElementById('game-canvas');
      if (!_gamePadEl || !_gameCanvas) return;
      _gameCtx = _gameCanvas.getContext('2d');
      // Canvas pointer event coordinates → canvas-pixel space (the
      // canvas's CSS box is scaled, so a raw clientX/Y won't line up
      // with _gameShape.cx / cy or polygon vertices).
      const _gameCanvasPos = (e) => {
        const rect = _gameCanvas.getBoundingClientRect();
        const sx = (rect.width  > 0) ? (_gameCanvas.width  / rect.width)  : 1;
        const sy = (rect.height > 0) ? (_gameCanvas.height / rect.height) : 1;
        return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
      };
      const _gameToggleRunning = () => {
        if (_gameRunning) {
          _gameRunning = false;
        } else {
          const moving = Math.abs(_gameShape.vx) > 1 || Math.abs(_gameShape.vy) > 1
                      || Math.abs(_gameBall.vx) > 1  || Math.abs(_gameBall.vy) > 1;
          if (!moving) _gameKick();
          _gameRunning = true;
        }
      };
      _gameCanvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const { x, y } = _gameCanvasPos(e);
        _gameInteract.active = true;
        _gameInteract.pointerId = e.pointerId;
        _gameInteract.startX = x; _gameInteract.startY = y;
        _gameInteract.curX   = x; _gameInteract.curY   = y;
        _gameInteract.startT = performance.now();
        _gameInteract.samples = [{ x, y, t: _gameInteract.startT }];
        _gameInteract.grabbed = false;
        if (_gameShapeInteraction === 'drag') {
          const dx = x - _gameShape.cx, dy = y - _gameShape.cy;
          // Generous grab radius (1.2× polygon radius) so the polygon's
          // pointier sides don't require pixel-perfect aim to grab.
          if (Math.hypot(dx, dy) <= _gameR * 1.2) {
            _gameInteract.grabbed = true;
            _gameInteract.grabDx = dx;
            _gameInteract.grabDy = dy;
            _gameShape.vx = 0; _gameShape.vy = 0;
            try { _gameCanvas.setPointerCapture(e.pointerId); } catch (err) {}
          }
        } else if (_gameShapeInteraction === 'tap') {
          // Impulse the shape away from the tap point so the user
          // "shoves" it. Speed matches the shape-speed slider so
          // existing momentum tuning carries over.
          const dx = _gameShape.cx - x, dy = _gameShape.cy - y;
          const dist = Math.hypot(dx, dy) || 1;
          const speed = Math.max(20, _gameUserShapeSpeed || 80);
          _gameShape.vx = (dx / dist) * speed;
          _gameShape.vy = (dy / dist) * speed;
          if (!_gameRunning) {
            // First impulse from a paused state also starts the loop —
            // the user is clearly engaging, no reason to make them
            // hunt for a separate start gesture.
            _gameRunning = true;
          }
        } else if (_gameShapeInteraction === 'magnet') {
          try { _gameCanvas.setPointerCapture(e.pointerId); } catch (err) {}
        }
      });
      _gameCanvas.addEventListener('pointermove', (e) => {
        if (!_gameInteract.active || e.pointerId !== _gameInteract.pointerId) return;
        const { x, y } = _gameCanvasPos(e);
        _gameInteract.curX = x; _gameInteract.curY = y;
        const now = performance.now();
        _gameInteract.samples.push({ x, y, t: now });
        // Keep only the last ~100 ms of samples — that's the window
        // _gameInteract release uses to compute throw velocity.
        while (_gameInteract.samples.length > 1
            && now - _gameInteract.samples[0].t > 100) {
          _gameInteract.samples.shift();
        }
        if (_gameShapeInteraction === 'drag' && _gameInteract.grabbed) {
          _gameShape.cx = x - _gameInteract.grabDx;
          _gameShape.cy = y - _gameInteract.grabDy;
          // Ball can otherwise pop outside when the user yanks the
          // polygon to a new spot.
          if (typeof _gameEnsureBallInside === 'function') _gameEnsureBallInside();
        }
      });
      const _gameEndPointer = (e) => {
        if (!_gameInteract.active || e.pointerId !== _gameInteract.pointerId) return;
        const now = performance.now();
        const totalT = now - _gameInteract.startT;
        const moveDist = Math.hypot(
          _gameInteract.curX - _gameInteract.startX,
          _gameInteract.curY - _gameInteract.startY,
        );
        if (_gameShapeInteraction === 'drag' && _gameInteract.grabbed) {
          // Throw velocity from the recent sample window. Short window
          // = wrist-flick captured cleanly; long releases (slow drift)
          // fall back to zero so the shape stays put.
          const s = _gameInteract.samples;
          if (s.length >= 2) {
            const s0 = s[0], s1 = s[s.length - 1];
            const dt = Math.max(0.016, (s1.t - s0.t) / 1000);
            const vx = (s1.x - s0.x) / dt;
            const vy = (s1.y - s0.y) / dt;
            const mag = Math.hypot(vx, vy);
            // Clamp to a reasonable upper bound so a frantic flick
            // doesn't fire the shape off-canvas in one frame.
            const cap = Math.max(60, Math.min(900, (_gameUserShapeSpeed || 80) * 4));
            if (mag > 1) {
              const k = Math.min(1, cap / mag);
              _gameShape.vx = vx * k;
              _gameShape.vy = vy * k;
            }
          }
          try { _gameCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
        } else if (_gameShapeInteraction === 'magnet') {
          try { _gameCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        // Quick stationary tap toggles run/pause across every mode —
        // 'tap' is excluded because pointerdown already kicked the
        // shape and starting/stopping on the same gesture would feel
        // ambiguous.
        const isTap = totalT < 250 && moveDist < 8;
        if (isTap && _gameShapeInteraction !== 'tap') {
          _gameToggleRunning();
        }
        _gameInteract.active = false;
        _gameInteract.pointerId = null;
        _gameInteract.grabbed = false;
        _gameInteract.samples = [];
      };
      _gameCanvas.addEventListener('pointerup',     _gameEndPointer);
      _gameCanvas.addEventListener('pointercancel', _gameEndPointer);
      // ---- shape touch-interaction selector ----
      const si = document.getElementById('game-shape-interaction');
      if (si) {
        si.value = _gameShapeInteraction;
        si.addEventListener('change', () => {
          _gameShapeInteraction = si.value || 'off';
          // Reset any in-progress drag/magnet state so a mode switch
          // mid-gesture doesn't leave the shape pinned to the pointer.
          _gameInteract.active = false;
          _gameInteract.grabbed = false;
        });
      }
      // ---- ball physics mode selector ----
      const bp = document.getElementById('game-ball-physics');
      if (bp) {
        bp.value = _gameBallPhysics;
        bp.addEventListener('change', () => {
          _gameBallPhysics = bp.value || 'classic';
        });
      }
      // ---- sliders ----
      const bsz = document.getElementById('game-ball-size');
      const bsp = document.getElementById('game-ball-speed');
      const ssz = document.getElementById('game-shape-size');
      const ssp = document.getElementById('game-shape-speed');
      if (bsz) {
        _gameUserBallSize = Number(bsz.value) || _gameUserBallSize;
        bsz.addEventListener('input', () => {
          const v = Number(bsz.value);
          if (!Number.isFinite(v)) return;
          _gameUserBallSize = v;
          _gameBall.r = v;
        });
      }
      if (bsp) {
        _gameUserBallSpeed = Number(bsp.value) || _gameUserBallSpeed;
        bsp.addEventListener('input', () => {
          const v = Number(bsp.value);
          if (!Number.isFinite(v)) return;
          _gameUserBallSpeed = v;
          const mag = Math.hypot(_gameBall.vx, _gameBall.vy);
          if (mag > 0.5) {
            const k = v / mag;
            _gameBall.vx *= k;
            _gameBall.vy *= k;
          }
        });
      }
      if (ssz) {
        _gameUserShapeFrac = (Number(ssz.value) || 75) / 100;
        ssz.addEventListener('input', () => {
          const v = Number(ssz.value);
          if (!Number.isFinite(v)) return;
          _gameUserShapeFrac = Math.max(0.30, Math.min(1.00, v / 100));
          _gameSize();
          if (!_gameRunning) {
            _gameBall.x = _gameShape.cx;
            _gameBall.y = _gameShape.cy;
          } else {
            // Running: the polygon just resized under the ball; if it's
            // now outside, snap it back so it doesn't fly off-canvas.
            _gameEnsureBallInside();
          }
        });
      }
      if (ssp) {
        _gameUserShapeSpeed = Number(ssp.value) || _gameUserShapeSpeed;
        ssp.addEventListener('input', () => {
          const v = Number(ssp.value);
          if (!Number.isFinite(v)) return;
          _gameUserShapeSpeed = v;
          const mag = Math.hypot(_gameShape.vx, _gameShape.vy);
          if (mag > 0.5) {
            const k = v / mag;
            _gameShape.vx *= k;
            _gameShape.vy *= k;
          }
        });
      }
      _gameBall.r = _gameUserBallSize;
      // ---- mute toggles ----
      const bm = document.getElementById('game-ball-mute');
      const sm = document.getElementById('game-shape-mute');
      if (bm) {
        bm.addEventListener('click', () => {
          _gameBallMuted = !_gameBallMuted;
          bm.setAttribute('aria-pressed', _gameBallMuted ? 'true' : 'false');
        });
      }
      if (sm) {
        sm.addEventListener('click', () => {
          _gameShapeMuted = !_gameShapeMuted;
          sm.setAttribute('aria-pressed', _gameShapeMuted ? 'true' : 'false');
        });
      }
      // ---- octave selectors ----
      const bo = document.getElementById('game-ball-oct');
      const so = document.getElementById('game-shape-oct');
      if (bo) {
        _gameUserBallOct = parseInt(bo.value, 10) || 0;
        bo.addEventListener('change', () => {
          const v = parseInt(bo.value, 10);
          if (Number.isFinite(v)) _gameUserBallOct = v;
        });
      }
      if (so) {
        _gameUserShapeOct = parseInt(so.value, 10) || 0;
        so.addEventListener('change', () => {
          const v = parseInt(so.value, 10);
          if (Number.isFinite(v)) _gameUserShapeOct = v;
        });
      }
      // ---- random-octave toggle (shape chord) ----
      // Refresh on toggle so the polygon rebuilds with / without the
      // octave scatter immediately, instead of waiting for the next
      // chord change.
      const sro = document.getElementById('game-shape-random-oct');
      if (sro) {
        sro.checked = !!_gameRandomOctaves;
        sro.addEventListener('change', () => {
          _gameRandomOctaves = !!sro.checked;
          try { _gameRefresh(); } catch (_) {}
        });
      }
      // ---- tone selectors ----
      const bt = document.getElementById('game-ball-tone');
      const st = document.getElementById('game-shape-tone');
      function _gamePopulateTones() {
        if (typeof getAllSoundOptions !== 'function') return;
        const opts = getAllSoundOptions() || [];
        [bt, st].forEach((sel) => {
          if (!sel) return;
          const prev = sel.value;
          while (sel.options.length > 1) sel.remove(1);
          for (const o of opts) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            sel.appendChild(opt);
          }
          sel.value = prev || '';
        });
      }
      _gamePopulateTones();
      if (bt) {
        _gameUserBallTone = bt.value || null;
        bt.addEventListener('change', () => { _gameUserBallTone = bt.value || null; });
      }
      if (st) {
        _gameUserShapeTone = st.value || null;
        st.addEventListener('change', () => { _gameUserShapeTone = st.value || null; });
      }
      // ---- popover menus ----
      const _gameMenuPairs = [
        { btn: document.getElementById('game-ball-menu-btn'),  menu: document.getElementById('game-ball-menu')  },
        { btn: document.getElementById('game-shape-menu-btn'), menu: document.getElementById('game-shape-menu') },
      ];
      function _gameCloseAllMenus() {
        for (const p of _gameMenuPairs) {
          if (!p.menu) continue;
          p.menu.classList.remove('open');
          if (p.btn) p.btn.setAttribute('aria-expanded', 'false');
        }
      }
      for (const p of _gameMenuPairs) {
        if (!p.btn || !p.menu) continue;
        p.btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = p.menu.classList.contains('open');
          _gameCloseAllMenus();
          if (!isOpen) {
            try { _gamePopulateTones(); } catch (_) {}
            p.menu.classList.add('open');
            p.btn.setAttribute('aria-expanded', 'true');
          }
        });
        // Keep clicks inside the menu from closing it.
        p.menu.addEventListener('click', (e) => { e.stopPropagation(); });
      }
      document.addEventListener('click', () => { _gameCloseAllMenus(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _gameCloseAllMenus();
      });
      try {
        const ro = new ResizeObserver(() => { _gameResize(); });
        ro.observe(_gameCanvasWrap || _gamePadEl);
      } catch (e) {
        window.addEventListener('resize', _gameResize);
      }
    }
    function _onGameModeChanged(active) {
      if (active) {
        _gameInit();
        _gameActive = true;
        _gameResize();
        // Progression position is now stashed per-mode by
        // _syncFluidGridToActiveLane — don't reset here, or the user's
        // game-mode progression cursor would snap back to chord 1 on
        // every re-entry.
        _gameRefresh();
        if (!_gameRaf) {
          _gameLastT = performance.now();
          _gameRaf = requestAnimationFrame(_gameLoop);
        }
      } else {
        _gameActive = false;
        _gameRunning = false;
        if (_gameRaf) { cancelAnimationFrame(_gameRaf); _gameRaf = 0; }
        _gameRecenter();
      }
    }

