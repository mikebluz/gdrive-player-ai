    // ---- Tracks (multi-track sequencer) ----

    let tracks = JSON.parse(localStorage.getItem('sounds-tracks') || '[]');
    // Ensure runtime fields on each track (these aren't persisted)
    tracks.forEach(t => {
      t.playing = false;
      t.currentItemIdx = null;
      t.timer = null;
      if (!t.eq) t.eq = { low: 0, mid: 0, high: 0 };
      if (!Number.isFinite(t.pan)) t.pan = 0;
      if (t.stereo === undefined) t.stereo = true;
    });
    let trackIdCounter = Math.max(0, ...tracks.map(t => t.id || 0)) + 1;

    function persistTracks() {
      const serial = tracks.map(t => ({
        id: t.id, name: t.name, items: t.items, loopMode: !!t.loopMode, solo: !!t.solo,
        eq: t.eq || { low: 0, mid: 0, high: 0 },
        pan: Number.isFinite(t.pan) ? t.pan : 0,
        stereo: t.stereo !== false,
      }));
      localStorage.setItem('sounds-tracks', JSON.stringify(serial));
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    function anySoloed() {
      return tracks.some(t => t.solo);
    }
    function shouldTrackPlay(track) {
      const soloMode = anySoloed();
      return soloMode ? !!track.solo : true;
    }

    function cloneStep(s) {
      const copy = { ...s };
      if (s.chord) copy.chord = s.chord.map(n => ({ ...n, params: n.params ? { ...n.params } : undefined }));
      if (s.params) copy.params = { ...s.params };
      // Per-step bypass switches — copy by value so duplicated/banked steps
      // don't share the active/bypass state object with the original.
      if (s._off) copy._off = { ...s._off };
      if (s.subSteps) copy.subSteps = s.subSteps.map(cloneStep);
      if (s.bend) copy.bend = { ...s.bend };
      // Wrap-level override tone — deep-copy so a cloned/banked wrap doesn't
      // share the params object with the live template.
      if (s.wrapToneParams) copy.wrapToneParams = { ...s.wrapToneParams };
      // Variance: deep-copy the alternates pool so duplicated steps
      // don't share references with the original.
      if (s.variance && Array.isArray(s.variance.notes)) {
        copy.variance = {
          mode: s.variance.mode,
          itersPerVariant: Number.isFinite(s.variance.itersPerVariant) ? s.variance.itersPerVariant : 1,
          randomEachIter: !!s.variance.randomEachIter,
          notes: s.variance.notes.map(n => ({
            ...n,
            params: n.params ? { ...n.params } : undefined,
          })),
        };
      }
      return copy;
    }

    // Duplicate the step at stepIndex by inserting a deep clone right
    // after it. Snapshots for undo, slides insertionPoint right when
    // it would otherwise land between original and copy, and re-renders.
    function duplicateStep(stepIndex) {
      if (!Array.isArray(sequence) || stepIndex < 0 || stepIndex >= sequence.length) return;
      const original = sequence[stepIndex];
      if (!original) return;
      snapshotForUndo('Duplicate step');
      const copy = cloneStep(original);
      sequence.splice(stepIndex + 1, 0, copy);
      if (insertionPoint !== null && insertionPoint > stepIndex) insertionPoint++;
      renderSequence();
      const saveBtn = document.getElementById('save-btn');
      if (saveBtn) saveBtn.disabled = sequence.length === 0;
    }

    // Fold: replace the step at stepIndex with two copies, each half
    // its original playtime. Equivalent to "halve, then duplicate" —
    // a 1/4 note becomes two 1/8 notes; a held quarter (duration: 2)
    // becomes two 1/4 notes; a 1/16 step becomes two 1/32 steps. Sub
    // and chord steps fold as a whole because the scheduler reads
    // duration/subdivision off the parent.
    //
    // Halving rule: when duration > 1 we halve duration (keeps the
    // step on a quantized subdivision), otherwise we halve subdivision
    // (so a 1/4 → 1/8 split stays musically clean instead of producing
    // a duration:0.5 step). Both paths preserve the wider time math
    // because (60/bpm) * subdivision * duration scales linearly.
    function foldStep(stepIndex) {
      if (!Array.isArray(sequence) || stepIndex < 0 || stepIndex >= sequence.length) return;
      const original = sequence[stepIndex];
      if (!original) return;
      snapshotForUndo('Fold step');
      const halveTiming = (s) => {
        const c = cloneStep(s);
        const d = c.duration || 1;
        if (d > 1) {
          c.duration = d / 2;
        } else {
          const sub = (c.subdivision != null) ? c.subdivision : stepSubdivision;
          c.subdivision = sub / 2;
        }
        return c;
      };
      let halved;
      if (original.isSub && Array.isArray(original.subSteps)) {
        // Sub playback unrolls every child's own duration/subdivision —
        // the parent's timing fields aren't read. Halving the parent
        // alone produces an identical-sounding fold, so walk the
        // subSteps and halve each leaf's timing instead.
        halved = cloneStep(original);
        halved.subSteps = (halved.subSteps || []).map(halveTiming);
      } else {
        halved = halveTiming(original);
      }
      sequence[stepIndex] = halved;
      sequence.splice(stepIndex + 1, 0, cloneStep(halved));
      if (insertionPoint !== null && insertionPoint > stepIndex) insertionPoint++;
      // Clear selection: the original step ref no longer exists in the
      // sequence (we replaced it with `halved`), so any selection that
      // pointed at it would reference an orphan.
      selectedStepRefs = [];
      syncStepEditorFromSelection();
      renderSequence();
      const saveBtn = document.getElementById('save-btn');
      if (saveBtn) saveBtn.disabled = sequence.length === 0;
    }

    // When a saved sequence is overwritten via Save, sync the new contents into
    // every track item that was sourced from it (matched by name, since track
    // items snapshot the name at add-time). Keeps the saved bank and any track
    // placements consistent so an edit in one place shows up everywhere.
    function propagateSavedToTracks(prevName, updated) {
      if (!prevName || updated.type === 'audio') return;
      let touched = false;
      tracks.forEach(track => {
        track.items.forEach(item => {
          if (item.type === 'audio') return;
          if (item.name === prevName) {
            item.steps = (updated.steps || []).map(cloneStep);
            item.bpm = updated.bpm;
            item.subdivision = updated.subdivision || 1;
            item.name = updated.name;
            touched = true;
          }
        });
      });
      if (touched) {
        persistTracks();
        renderTracks();
      }
    }

    // Decode a saved audio chip's data URL just far enough to read its
    // channel count. Used to auto-pick mono vs stereo for tracks created
    // from a chip's long-press menu. Returns 2 on failure so we err on
    // the side of stereo.
    async function detectAudioChannelCount(dataUrl) {
      try {
        if (!dataUrl) return 2;
        const blob = dataUrlToBlob(dataUrl);
        if (!blob) return 2;
        const buf = await blob.arrayBuffer();
        const ctx = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
          ? Tone.context.rawContext
          : (window.AudioContext ? new AudioContext() : null);
        if (!ctx) return 2;
        const decoded = await new Promise((resolve, reject) => {
          const p = ctx.decodeAudioData(buf, resolve, reject);
          if (p && typeof p.then === 'function') p.then(resolve, reject);
        });
        return decoded?.numberOfChannels || 2;
      } catch (e) {
        return 2;
      }
    }

    function addTrack(opts) {
      maybeSnapshotForUndo('Add track');
      tracks.push({
        id: trackIdCounter++,
        name: `${tracks.length + 1}`,
        items: [],
        loopMode: false,
        solo: false,
        playing: false,
        currentItemIdx: null,
        timer: null,
        eq: { low: 0, mid: 0, high: 0 },
        pan: 0,
        // True = stereo bus (default). False = mono — output is summed
        // through Tone.Mono so L+R collapse, useful when the source audio
        // is mono or the user wants a mono image.
        stereo: opts && opts.stereo === false ? false : true,
      });
      persistTracks();
      renderTracks();
      return tracks.length - 1;
    }

    function removeTrack(trackIdx) {
      maybeSnapshotForUndo('Remove track');
      stopTrack(trackIdx);
      const track = tracks[trackIdx];
      // Forcefully drain any deferred item teardowns parked by
      // stopTrack — the track itself is going away, so there's no
      // point letting their timers fire after track._bus is disposed
      // below (they'd just leak the audio nodes for another few
      // seconds).
      if (typeof _drainPendingItemDisposes === 'function') {
        try { _drainPendingItemDisposes(track); } catch (e) {}
      }
      if (track && track._recording) {
        try { track._recorder?.stop(); } catch (e) {}
        if (track._recStream) {
          try { track._recStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        }
        track._recording = false;
        track._recorder = null;
        track._recStream = null;
      }
      if (track && track._bus) {
        try { track._bus.dispose(); } catch (e) {}
        track._bus = null;
      }
      if (track && track._panner) {
        try { track._panner.dispose(); } catch (e) {}
        track._panner = null;
      }
      if (track && track._mono) {
        try { track._mono.dispose(); } catch (e) {}
        track._mono = null;
      }
      if (track && track._samplers) {
        track._samplers.forEach(s => { try { s.dispose(); } catch (e) {} });
        track._samplers = null;
      }
      tracks.splice(trackIdx, 1);
      persistTracks();
      renderTracks();
    }

    function clearTrack(trackIdx) {
      maybeSnapshotForUndo('Clear track');
      stopTrack(trackIdx);
      tracks[trackIdx].items = [];
      persistTracks();
      renderTracks();
    }

    function toggleTrackLoop(trackIdx) {
      maybeSnapshotForUndo('Toggle loop');
      tracks[trackIdx].loopMode = !tracks[trackIdx].loopMode;
      persistTracks();
      renderTracks();
    }

    function toggleTrackStereo(trackIdx) {
      const track = tracks[trackIdx];
      if (!track) return;
      maybeSnapshotForUndo('Toggle stereo');
      track.stereo = track.stereo === false ? true : false;
      // Tear down the bus chain so getTrackBus rebuilds it with/without
      // the Tone.Mono node on next playback.
      if (track._bus)    { try { track._bus.dispose(); }    catch (e) {} track._bus = null; }
      if (track._panner) { try { track._panner.dispose(); } catch (e) {} track._panner = null; }
      if (track._mono)   { try { track._mono.dispose(); }   catch (e) {} track._mono = null; }
      // Per-track samplers are bound to the old bus — drop them too.
      if (track._samplers) {
        track._samplers.forEach(s => { try { s.dispose(); } catch (e) {} });
        track._samplers = null;
      }
      persistTracks();
      renderTracks();
    }

    function toggleTrackSolo(trackIdx) {
      const track = tracks[trackIdx];
      if (!track) return;
      maybeSnapshotForUndo('Toggle solo');
      track.solo = !track.solo;
      // After flipping the flag, stop any currently-playing track that's now
      // blocked by the new solo state (e.g., user solos one track while a
      // different non-soloed track is mid-playback).
      tracks.forEach((t, i) => {
        if (t.playing && !shouldTrackPlay(t)) stopTrack(i);
      });
      persistTracks();
      renderTracks();
    }

    function addSavedToTrack(trackIdx, saved) {
      maybeSnapshotForUndo('Add to track');
      const snapshot = {
        name: saved.name,
        bpm: saved.bpm,
        subdivision: saved.subdivision || 1,
        // Per-item volume (0–200, default 100 = unity). Applied as a
        // Tone.Gain between the item's playback nodes and the trackBus
        // in both live playback and offline export.
        volume: 100,
        // Carry the saved sequence's FX state with it so the item knows
        // what FX it "should" sound like. The live track bus currently
        // pulls FX wet from the global FX panel, so a future per-item
        // FX recall pass can apply this snapshot during playback.
        globalFx: (saved.globalFx && typeof saved.globalFx === 'object')
          ? JSON.parse(JSON.stringify(saved.globalFx))
          : null,
      };
      if (saved.type === 'audio') {
        snapshot.type = 'audio';
        snapshot.audioDataUrl = saved.audioDataUrl;
        snapshot.durationSec = saved.durationSec || 0;
        snapshot.steps = [];
      } else {
        // Steps stay for backward compat — older render / duration
        // helpers read item.steps. For multi-lane saves we ALSO carry
        // lanes so playTrackItem can fan out one timer per lane and
        // play them simultaneously into the track bus, instead of
        // collapsing the whole sequence onto the single active-lane
        // step list.
        snapshot.steps = (saved.steps || []).map(cloneStep);
        if (Array.isArray(saved.lanes) && saved.lanes.length > 0) {
          snapshot.lanes = saved.lanes.map(l => ({
            name: l.name,
            steps: Array.isArray(l.steps) ? l.steps.map(cloneStep) : [],
            muted: !!l.muted,
            solo:  !!l.solo,
            pan:    Number.isFinite(l.pan)    ? l.pan    : 0,
            volume: Number.isFinite(l.volume) ? l.volume : 100,
            slip:   Number.isFinite(l.slip)   ? l.slip   : 0,
            // Per-lane FX wet levels follow the sequence onto the
            // track. Used by per-item FX recall during playback.
            sends: l.sends ? { ...l.sends } : null,
          }));
        }
      }
      tracks[trackIdx].items.push(snapshot);
      persistTracks();
      renderTracks();
    }

    function removeTrackItem(trackIdx, itemIdx) {
      const track = tracks[trackIdx];
      if (!track) return;
      maybeSnapshotForUndo('Remove item');
      track.items.splice(itemIdx, 1);
      if (track.playing && track.currentItemIdx === itemIdx) {
        stopTrack(trackIdx);
      }
      persistTracks();
      renderTracks();
    }

    // Total wall-clock duration of a track item in ms (handles audio items,
    // step sequences, and nested subsequences). Used for time-proportional
    // sizing in the tracks view so a sequence twice as long in time renders
    // twice as wide regardless of step count or BPM.
    function stepDurationMs(s, bpm, parentSub) {
      const sSub = (s.subdivision != null) ? s.subdivision : parentSub;
      const sDur = s.duration || 1;
      if (s.isSub && Array.isArray(s.subSteps) && s.subSteps.length > 0) {
        return s.subSteps.reduce((acc, child) => acc + stepDurationMs(child, bpm, parentSub), 0);
      }
      return (60000 / bpm) * sSub * sDur;
    }
    function itemDurationMs(item) {
      if (!item) return 0;
      if (item.type === 'audio' || item.type === 'silent') return (item.durationSec || 0) * 1000;
      const bpm = item.bpm || 120;
      const itemSub = item.subdivision || 1;
      const stepListMs = (steps) => {
        let ms = 0;
        (steps || []).forEach(s => { ms += stepDurationMs(s, bpm, itemSub); });
        return ms;
      };
      // Multi-lane items: duration is the LONGEST lane (matching live
      // playback, where the item only advances after every lane has
      // run out of steps). Mute / solo are honored so a soloed lane
      // drives duration alone.
      if (Array.isArray(item.lanes) && item.lanes.length > 0) {
        const anySolo = item.lanes.some(l => l && l.solo);
        const playable = item.lanes.filter(l => l && Array.isArray(l.steps)
          && l.steps.length > 0
          && (anySolo ? !!l.solo : !l.muted));
        if (playable.length > 0) {
          return Math.max(...playable.map(l => stepListMs(l.steps)));
        }
      }
      return stepListMs(item.steps);
    }
    // Flatten a step list into leaf steps for track playback/export. Sub
    // wrappers carry no audio of their own (duration 1, no subdivision), and
    // their children already fall back to itemSub for subdivision, so the
    // flattened list plays back identically to walking the tree.
    function flattenItemSteps(steps) {
      const out = [];
      (steps || []).forEach(s => {
        if (s && s.isSub && Array.isArray(s.subSteps) && s.subSteps.length > 0) {
          out.push(...flattenItemSteps(s.subSteps));
        } else if (s) {
          out.push(s);
        }
      });
      return out;
    }
    // 1 grid cell = 500 ms (a quarter note at 120 BPM). Picked so a typical
    // 16-step / 1/4-div / 120-BPM sequence still renders ≈16 cells wide,
    // matching the previous step-count layout.
    const TRACK_CELL_MS = 500;
    // Each track-grid renders one TRACK_CELL_MS chunk per
    // TRACK_PX_PER_CELL pixels (column width + 2 px gap). The base
    // column width is 18 px (matching the .track-grid CSS default).
    // Both values mutate when the user changes the Mix zoom — see
    // setTracksZoom — so loop-ruler / drop-indicator math and the
    // grid-auto-columns CSS variable stay in lockstep.
    const TRACK_BASE_CELL_W = 18;
    const TRACK_CELL_GAP    = 2;
    let   tracksZoom        = 1;
    try {
      const z = parseFloat(localStorage.getItem('bloops-tracks-zoom'));
      if (Number.isFinite(z) && z > 0) tracksZoom = Math.max(0.25, Math.min(4, z));
    } catch (e) {}
    let TRACK_PX_PER_CELL = Math.round(TRACK_BASE_CELL_W * tracksZoom) + TRACK_CELL_GAP;
    let TRACK_PX_PER_SEC  = (TRACK_PX_PER_CELL * 1000) / TRACK_CELL_MS;
    // Push the cell width to a CSS variable so .track-grid's
    // grid-auto-columns picks it up; gap stays at the CSS default.
    function _applyTracksZoomToCss() {
      const cellW = Math.round(TRACK_BASE_CELL_W * tracksZoom);
      document.documentElement.style.setProperty('--track-cell-w', cellW + 'px');
    }
    _applyTracksZoomToCss();
    // Fixed zoom stops so every in / out click lands on a round %
     // value. With multiplicative steps the user could drift to a non-
     // standard zoom (1.25 × 0.8 = 1, but 1 × 1.25 × 1.25 / 1.25 = 1.25
     // — and counting clicks to get back to 100 % is awkward).
    const TRACKS_ZOOM_STEPS = [0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
    function _nearestZoomStepIdx(z) {
      let idx = 0;
      let best = Infinity;
      for (let i = 0; i < TRACKS_ZOOM_STEPS.length; i++) {
        const d = Math.abs(TRACKS_ZOOM_STEPS[i] - z);
        if (d < best) { best = d; idx = i; }
      }
      return idx;
    }
    function _stepTracksZoom(dir) {
      const cur = tracksZoom;
      const nearIdx = _nearestZoomStepIdx(cur);
      const onStep  = Math.abs(TRACKS_ZOOM_STEPS[nearIdx] - cur) < 1e-3;
      // If the current zoom is already sitting on a preset, step to
      // the next one. If it landed between presets (legacy multiplicative
      // value from an older build), snap to the nearest stop in the
      // requested direction so the first click "corrects" without
      // skipping a stop.
      if (onStep) {
        const ni = Math.max(0, Math.min(TRACKS_ZOOM_STEPS.length - 1,
          nearIdx + Math.sign(dir)));
        return TRACKS_ZOOM_STEPS[ni];
      }
      if (dir > 0) {
        for (let i = 0; i < TRACKS_ZOOM_STEPS.length; i++) {
          if (TRACKS_ZOOM_STEPS[i] > cur + 1e-3) return TRACKS_ZOOM_STEPS[i];
        }
        return TRACKS_ZOOM_STEPS[TRACKS_ZOOM_STEPS.length - 1];
      }
      for (let i = TRACKS_ZOOM_STEPS.length - 1; i >= 0; i--) {
        if (TRACKS_ZOOM_STEPS[i] < cur - 1e-3) return TRACKS_ZOOM_STEPS[i];
      }
      return TRACKS_ZOOM_STEPS[0];
    }
    function setTracksZoom(next) {
      const z = Math.max(0.25, Math.min(4, Number(next) || 1));
      if (Math.abs(z - tracksZoom) < 1e-4) return;
      tracksZoom = z;
      TRACK_PX_PER_CELL = Math.round(TRACK_BASE_CELL_W * tracksZoom) + TRACK_CELL_GAP;
      TRACK_PX_PER_SEC  = (TRACK_PX_PER_CELL * 1000) / TRACK_CELL_MS;
      _applyTracksZoomToCss();
      try { localStorage.setItem('bloops-tracks-zoom', String(tracksZoom)); } catch (e) {}
      // Re-render so item cell widths + the loop ruler + drop indicator
      // all redraw against the new pixel scale.
      if (typeof renderTracks === 'function') renderTracks();
      const zoomLabel = document.getElementById('tracks-zoom-label');
      if (zoomLabel) zoomLabel.textContent = Math.round(tracksZoom * 100) + '%';
    }
    function itemStepCount(item) {
      const ms = itemDurationMs(item);
      return Math.max(1, Math.round(ms / TRACK_CELL_MS));
    }
    // Per-track time ranges: walk items, return {startSec, endSec} for
    // each. Used by the loop-region handles for soft-lock snapping and
    // by track playback to decide which items fall inside the region.
    function _trackItemTimeRanges(track) {
      let t = 0;
      return (track && Array.isArray(track.items) ? track.items : []).map(item => {
        const d = itemDurationMs(item) / 1000;
        const r = { startSec: t, endSec: t + d };
        t += d;
        return r;
      });
    }
    function _maxTracksDurationSec() {
      let max = 0;
      tracks.forEach(t => {
        const ranges = _trackItemTimeRanges(t);
        if (ranges.length) max = Math.max(max, ranges[ranges.length - 1].endSec);
      });
      return max;
    }
    // Visual ranges for the longest-duration track, returning both
    // audio sec and the cell-aligned pixel offsets (left edge of each
    // item's first cell, right edge of each item's last cell). The
    // sec↔px helpers below map sec values through this list so
    // handle / cursor positions track the real visual cell layout —
    // necessary because itemStepCount rounds duration to whole cells,
    // so `sec * TRACK_PX_PER_SEC` drifts from the visual layout when
    // an item's duration isn't a multiple of TRACK_CELL_MS.
    function _longestVisualRanges() {
      let bestTrack = null;
      let bestEnd = -1;
      tracks.forEach(t => {
        const ranges = _trackItemTimeRanges(t);
        const endSec = ranges.length ? ranges[ranges.length - 1].endSec : 0;
        if (endSec > bestEnd) { bestEnd = endSec; bestTrack = t; }
      });
      if (!bestTrack) return [];
      let secCum = 0;
      let cellCum = 0;
      return (bestTrack.items || []).map(item => {
        const dur = itemDurationMs(item) / 1000;
        const span = (typeof itemStepCount === 'function') ? itemStepCount(item) : 1;
        const r = {
          startSec: secCum,
          endSec:   secCum + dur,
          startPx:  cellCum * TRACK_PX_PER_CELL,
          endPx:    (cellCum + span) * TRACK_PX_PER_CELL - TRACK_CELL_GAP,
        };
        secCum += dur;
        cellCum += span;
        return r;
      });
    }
    // Sec → x (offset from pad). `edge` picks the right cell edge at
    // item boundaries: 'start' uses the next item's first-cell left
    // edge, 'end' uses the prior item's last-cell right edge.
    function _secToVisualPx(sec, edge) {
      const s = Number(sec) || 0;
      if (s <= 0) return 0;
      const ranges = _longestVisualRanges();
      if (!ranges.length) return s * TRACK_PX_PER_SEC;
      for (const r of ranges) {
        if (edge === 'end' && Math.abs(s - r.endSec) < 1e-6) return r.endPx;
        if (edge === 'start' && Math.abs(s - r.startSec) < 1e-6) return r.startPx;
        if (s > r.startSec && s < r.endSec) {
          const span = Math.max(1e-9, r.endSec - r.startSec);
          const t01 = (s - r.startSec) / span;
          return r.startPx + t01 * (r.endPx - r.startPx);
        }
      }
      const last = ranges[ranges.length - 1];
      return last.endPx + (s - last.endSec) * TRACK_PX_PER_SEC;
    }
    // Inverse: x (offset from pad) → sec. Walks the same visual
    // ranges so click-to-seek + handle-drag math agree with the
    // pixel positions used to render the handles.
    function _visualPxToSec(px) {
      const p = Number(px) || 0;
      if (p <= 0) return 0;
      const ranges = _longestVisualRanges();
      if (!ranges.length) return p / TRACK_PX_PER_SEC;
      for (const r of ranges) {
        if (p <= r.endPx + 1e-6) {
          const span = Math.max(1e-9, r.endPx - r.startPx);
          const t01 = Math.max(0, Math.min(1, (p - r.startPx) / span));
          return r.startSec + t01 * (r.endSec - r.startSec);
        }
      }
      const last = ranges[ranges.length - 1];
      return last.endSec + (p - last.endPx) / TRACK_PX_PER_SEC;
    }
    // Visual end of the longest track (in px, offset from pad). Used
    // to size the ruler width so the right edge — and the default
    // end handle at maxSec — line up with the last sequence's right
    // cell edge instead of overshooting via the linear scale.
    function _maxTracksVisualPx() {
      const ranges = _longestVisualRanges();
      return ranges.length ? ranges[ranges.length - 1].endPx : 0;
    }
    // Every distinct item boundary time across every track — used as the
    // soft-lock target set when the user drags a loop handle.
    function _allItemBoundarySecs() {
      const out = new Set([0]);
      tracks.forEach(t => {
        _trackItemTimeRanges(t).forEach(r => {
          out.add(+r.startSec.toFixed(4));
          out.add(+r.endSec.toFixed(4));
        });
      });
      return [...out].sort((a, b) => a - b);
    }
    // Snap a candidate time to the nearest item boundary within
    // `thresholdPx` pixels. Used by loop-handle drag for the "soft
    // lock to sequence boundaries" behavior.
    function _snapSecToBoundary(sec, thresholdPx) {
      const candidates = _allItemBoundarySecs();
      let best = sec, bestDist = Infinity;
      const px = thresholdPx || 10;
      candidates.forEach(b => {
        const dist = Math.abs(b - sec) * TRACK_PX_PER_SEC;
        if (dist <= px && dist < bestDist) { best = b; bestDist = dist; }
      });
      return best;
    }

    function togglePlayTrack(trackIdx) {
      const track = tracks[trackIdx];
      if (!track) return;
      if (track.playing) stopTrack(trackIdx);
      else startTrack(trackIdx);
    }

    async function startTrack(trackIdx) {
      const track = tracks[trackIdx];
      if (!track || track.items.length === 0) return;
      // Effective playback start time: cursor position, clamped into
      // the loop region when masterLoop is on. _trackStartItemForTime
      // picks the first item whose end passes that time so the track
      // begins at (or just after) the playhead.
      const requestedSec = Math.max(0, _tracksCursorSec || 0);
      let effectiveSec = requestedSec;
      if (tracksMasterLoop) {
        const ranges = _trackItemTimeRanges(track);
        const loopEnd = (tracksLoopEndSec == null) ? Infinity : tracksLoopEndSec;
        const hasInLoop = ranges.some(r => r.endSec > tracksLoopStartSec + 1e-6
          && r.startSec < loopEnd - 1e-6);
        if (!hasInLoop) return; // nothing in the loop region — stay silent
        // Snap the playhead into the region so playback starts inside it.
        effectiveSec = Math.max(tracksLoopStartSec,
          Math.min(loopEnd - 1e-6, requestedSec));
      }
      await Tone.start();
      // Wait for any pending sample buffers (Piano / Organ / imported, etc.)
      // to finish loading. Without this, sampler.loaded is false at the
      // first triggerAttackRelease and the note is silently dropped — making
      // sample-based tracks appear to "not play" until the second pass.
      // Capped: ~130 remote GM samplers stream from a third-party CDN; if it's
      // down they stay pending forever and a bare await would hang playback.
      try { await Promise.race([Tone.loaded(), new Promise((r) => setTimeout(r, 500))]); } catch (e) {}
      track.playing = true;
      const startIdx = (typeof _trackStartItemForTime === 'function')
        ? _trackStartItemForTime(track, effectiveSec)
        : 0;
      track.currentItemIdx = startIdx;
      renderTracks();
      // Capture / reuse the shared Mix audio epoch. When playAllTracks
      // launched this call, _tracksAudioEpoch is already set against a
      // single Tone.now() snapshot so every parallel track lines up.
      // When this track is being toggled in isolation (no other tracks
      // playing), seed a fresh epoch — the 60 ms warmup is baked in
      // here instead of a per-track setTimeout.
      if (_tracksAudioEpoch == null
          && typeof Tone !== 'undefined' && typeof Tone.now === 'function') {
        _tracksAudioEpoch = Tone.now() + 0.06;
      }
      // Per-track epoch offset: items index against the track timeline,
      // but playback may start mid-track at startIdx. Setting
      // track._epoch = sharedEpoch - itemStartSec[startIdx] means
      // playTrackItem(track, startIdx) plays the item at the shared
      // epoch (its head, even if the visual cursor sits mid-item — the
      // pre-existing "audio begins from item head" tradeoff). Subsequent
      // items follow at their exact mathematical offsets.
      const ranges = _trackItemTimeRanges(track);
      const startItemSec = (ranges[startIdx] && Number.isFinite(ranges[startIdx].startSec))
        ? ranges[startIdx].startSec : 0;
      track._epoch = (_tracksAudioEpoch != null)
        ? _tracksAudioEpoch - startItemSec
        : null;
      // Safeguard for late-joining tracks: if the shared epoch was
      // captured seconds ago (another track has been running when this
      // one joins), the computed first fireTime would land in the past
      // and Tone would race to fire it ASAP — a clipped attack. Only
      // bump when firstFire is genuinely in the past (Tone.now() has
      // overtaken the scheduled time) so the few-ms event-loop drift
      // between playAllTracks's epoch capture and this startTrack's
      // execution doesn't trigger spurious per-track offsets that
      // would break parallel lockstep at session start.
      if (track._epoch != null
          && typeof Tone !== 'undefined' && typeof Tone.now === 'function') {
        const firstFire = track._epoch + startItemSec;
        const nowAudio  = Tone.now();
        if (firstFire < nowAudio) {
          track._epoch += (nowAudio + 0.06 - firstFire);
        }
      }
      if (track.playing) playTrackItem(trackIdx, startIdx, 0);
    }

    let tracksMasterLoop = false;
    // Loop region for Mix. tracksLoopStartSec defaults to 0 and
    // tracksLoopEndSec to null ("all the way to the end of the longest
    // track") so the default behavior matches pre-region playback —
    // masterLoop wraps after every track finishes. Once the user
    // drags a handle, both are stamped into localStorage and
    // playback restricts to the region.
    let tracksLoopStartSec = 0;
    let tracksLoopEndSec   = null;
    try {
      const raw = localStorage.getItem('bloops-tracks-loop');
      if (raw) {
        const v = JSON.parse(raw);
        if (Number.isFinite(v.start)) tracksLoopStartSec = Math.max(0, v.start);
        if (Number.isFinite(v.end))   tracksLoopEndSec   = Math.max(0, v.end);
      }
    } catch (e) {}
    function _persistTracksLoop() {
      try {
        localStorage.setItem('bloops-tracks-loop', JSON.stringify({
          start: tracksLoopStartSec,
          end:   tracksLoopEndSec,
        }));
      } catch (e) {}
    }
    // Effective end time: explicit value or "natural end" = longest track.
    function _effectiveLoopEndSec() {
      const fallback = _maxTracksDurationSec();
      const explicit = (tracksLoopEndSec == null) ? fallback : tracksLoopEndSec;
      return Math.max(tracksLoopStartSec, Math.min(explicit, fallback || explicit));
    }
    // Item index for a track at which playback should begin given a
    // target time in seconds. Soft-locked boundaries usually put the
    // target right on an item edge; if it falls inside an item, we
    // start from that item (audio begins from its head, even if the
    // visual cursor is mid-item — accepted tradeoff for not splitting
    // items mid-flight).
    function _trackStartItemForTime(track, sec) {
      const ranges = _trackItemTimeRanges(track);
      const t = Math.max(0, Number(sec) || 0);
      for (let i = 0; i < ranges.length; i++) {
        if (ranges[i].endSec > t + 1e-6) return i;
      }
      return 0;
    }
    function _trackStartItemForLoop(track) {
      return _trackStartItemForTime(track, tracksLoopStartSec);
    }
    // ---- Play cursor ----
    // Tracks where the playback head sits along the Mix timeline. The
    // cursor moves left → right while any track is playing (driven by
    // a RAF loop reading wall-clock + base time) and stays put when
    // playback stops. Clicks on the ruler / empty grid space update
    // _tracksCursorSec and call seekTracksTo so the next Play (or the
    // live in-progress play) jumps to the new position.
    let _tracksCursorSec          = 0;
    let _tracksPlaybackBaseSec    = 0;   // cursor time when playback started
    let _tracksPlaybackStartWallMs = null; // performance.now() at playback start
    let _tracksCursorRafId        = null;
    // ---- Shared Mix-mode audio epoch ----
    // One Tone-audio-time anchor shared by every track in the current
    // playback session. Tracks compute every note's fireTime as
    // (track._epoch + cumulativeItemStartSec + intra-item offsetSec)
    // — so parallel tracks stay lockstep, and item-to-item handoffs
    // inside one track stop drifting (they used to take a fresh
    // Tone.now() on every playTrackItem entry, which slipped against
    // the previous item's mathematical end).
    // Null when no playback session is active; set by playAllTracks /
    // startTrack at session start, cleared by stopTrack once every
    // track has stopped.
    let _tracksAudioEpoch = null;
    function _currentTracksTimeSec() {
      if (_tracksPlaybackStartWallMs != null) {
        return _tracksPlaybackBaseSec
          + (performance.now() - _tracksPlaybackStartWallMs) / 1000;
      }
      return _tracksCursorSec;
    }
    function _updatePlayCursor() {
      const cursor = document.getElementById('tracks-play-cursor');
      if (!cursor) return;
      const firstGrid = document.querySelector('#tracks-container .track-row .track-grid');
      const maxSec = _maxTracksDurationSec();
      if (!firstGrid || maxSec <= 0) {
        cursor.hidden = true;
        return;
      }
      cursor.hidden = false;
      let sec = _currentTracksTimeSec();
      // Clamp into the playable range so the cursor can't drift past
      // the end (or out of the loop region while masterLoop is on).
      const cap = (tracksMasterLoop && tracksLoopEndSec != null)
        ? tracksLoopEndSec : maxSec;
      if (sec < 0) sec = 0;
      if (sec > cap) sec = cap;
      // Horizontal: anchor to the first track's grid (same alignment
      // strategy as the loop ruler — works regardless of zoom level
      // or controls-column width).
      const section = cursor.parentElement;
      if (!section) return;
      const sectionRect = section.getBoundingClientRect();
      const gridRect    = firstGrid.getBoundingClientRect();
      const offsetX     = gridRect.left - sectionRect.left + 4;
      // Use the piecewise sec→cell-px mapping so the cursor lands on
      // the actual visual position of `sec` within the current item,
      // not the drifting linear `sec * TRACK_PX_PER_SEC` projection.
      cursor.style.left = (offsetX + _secToVisualPx(sec, 'start')) + 'px';
      // Vertical: from just below the loop ruler to the bottom of
      // the last track. Both edges measured live so the cursor
      // tracks layout changes (Mix tracks-fullscreen, scroll, etc.).
      const ruler = document.getElementById('tracks-loop-ruler');
      const lastRow = section.querySelector('#tracks-container .track-row:last-of-type');
      if (ruler && lastRow) {
        const rulerRect = ruler.getBoundingClientRect();
        const lastRect  = lastRow.getBoundingClientRect();
        cursor.style.top    = (rulerRect.bottom - sectionRect.top) + 'px';
        cursor.style.height = (lastRect.bottom  - rulerRect.bottom) + 'px';
      }
    }
    function _startPlayCursorAnim() {
      _stopPlayCursorAnim();
      const tick = () => {
        _updatePlayCursor();
        // Mid-sequence loop end: when masterLoop is on and the
        // playhead reaches loopEnd, force every still-playing track
        // to a natural stop so the masterLoop restart wraps playback
        // back to loopStart. Without this, loop boundaries that
        // fall inside a sequence wait for the containing item to
        // finish before wrapping.
        if (tracksMasterLoop && tracksLoopEndSec != null
            && _tracksPlaybackStartWallMs != null) {
          const cur = _currentTracksTimeSec();
          if (cur >= tracksLoopEndSec - 1e-3) {
            tracks.forEach((_, i) => {
              if (tracks[i].playing) stopTrack(i, true);
            });
            // stopTrack's "all stopped + masterLoop" branch resets
            // the cursor + kicks off playAllTracks; the new RAF
            // will spin up from there. Bail so we don't keep ticking.
            _tracksCursorRafId = null;
            return;
          }
        }
        // Keep ticking as long as playback is logically active —
        // `_tracksPlaybackStartWallMs` is set synchronously by
        // playAllTracks (before any awaits) and cleared by stopTrack
        // once every track is down. Checking `track.playing` here
        // froze the cursor immediately because startTrack flips
        // `track.playing = true` only AFTER `await Tone.start()` /
        // `await Tone.loaded()`, which is several event-loop ticks
        // after the RAF first fires.
        if (_tracksPlaybackStartWallMs != null) {
          _tracksCursorRafId = requestAnimationFrame(tick);
        } else {
          _tracksCursorRafId = null;
          _updatePlayCursor();
        }
      };
      tick();
    }
    function _stopPlayCursorAnim() {
      if (_tracksCursorRafId != null) {
        cancelAnimationFrame(_tracksCursorRafId);
        _tracksCursorRafId = null;
      }
    }
    // Jump the playback head to a specific time. If any track is
    // currently playing, all tracks stop and restart from that time —
    // matching the "click to seek" expectation. Snaps to the nearest
    // item boundary across all tracks (within ~12 px) so playback
    // starts cleanly on a sequence edge.
    function seekTracksTo(timeSec) {
      const snapped = (typeof _snapSecToBoundary === 'function')
        ? _snapSecToBoundary(Math.max(0, Number(timeSec) || 0), 12)
        : Math.max(0, Number(timeSec) || 0);
      const wasPlaying = tracks.some(t => t.playing);
      _tracksCursorSec = snapped;
      _tracksPlaybackStartWallMs = null;
      // Moving the cursor implies "play from here" — if anything was
      // already playing we stop + restart at the new position; if
      // nothing was playing we kick off playback fresh. Without this
      // second branch, clicking the ruler / grid only repositioned
      // the cursor visually and the user had to hit Play All
      // separately, which felt inconsistent with the "click to seek"
      // affordance.
      const anyItems = tracks.some(t => (t.items || []).length > 0);
      if (wasPlaying) {
        stopAllTracks();
        // Tiny defer so any in-flight teardown timers don't race the
        // restart's lane-bus construction.
        setTimeout(() => {
          if (typeof playAllTracks === 'function') playAllTracks();
        }, 40);
      } else if (anyItems) {
        _updatePlayCursor();
        if (typeof playAllTracks === 'function') playAllTracks();
      } else {
        _updatePlayCursor();
      }
    }
    // True when an item index is beyond the loop region — playback
    // treats that as a natural end and lets masterLoop restart.
    function _itemIsBeyondLoopEnd(track, itemIdx) {
      if (tracksLoopEndSec == null) return false;
      const ranges = _trackItemTimeRanges(track);
      const r = ranges[itemIdx];
      return !!(r && r.startSec >= tracksLoopEndSec - 1e-6);
    }

    // Build a per-track-item lane bus that mirrors Make's getLaneBus —
    // signal flows synth → head → Volume → Panner → [lazy FX chain] →
    // destination (trackBus). Pulls volume/pan/sends straight off the
    // saved lane snapshot, so the user's per-lane mix carried with the
    // sequence into the track. Returns null for a missing lane (legacy
    // single-stream item path — handled by routing to trackBus directly).
    function _buildItemLaneBus(lane, dest, fxOverride) {
      if (!lane) return null;
      try {
        const head    = new Tone.Gain(1);
        const volNorm = Math.max(0, Math.min(1, (Number.isFinite(lane.volume) ? lane.volume : 100) / 100));
        const volDb   = volNorm <= 0 ? -Infinity : Tone.gainToDb(volNorm);
        const volume  = new Tone.Volume(volDb);
        const panNorm = Math.max(-1, Math.min(1, (Number.isFinite(lane.pan) ? lane.pan : 0) / 100));
        const panner  = new Tone.Panner(panNorm);
        head.connect(volume);
        volume.connect(panner);
        // Build only the FX nodes whose send is > 0 — mirrors the lazy
        // build in applyLaneSends. Wire in series after panner.
        const fxNodes = {};
        const fxChain = [];
        const sends = (lane.sends && typeof lane.sends === 'object') ? lane.sends : {};
        FX_NAMES.forEach(name => {
          const v = Number(sends[name]);
          if (!Number.isFinite(v) || v <= 0) return;
          const node = (typeof _buildOneLaneFxNode === 'function') ? _buildOneLaneFxNode(name) : null;
          if (!node) return;
          fxNodes[name] = node;
          fxChain.push({ name, node });
          // Push shape + wet. fxOverride lets the caller pin the
          // shape params to the item's saved globalFx so each item's
          // per-lane FX renders with its own room size / delay time
          // / etc. in the export, instead of all items sharing the
          // live workspace globalFx.
          try { _applyLaneFxNodeParams(name, node, { sends }, fxOverride); } catch (e) {}
        });
        let upstream = panner;
        for (const { node } of fxChain) {
          try { upstream.connect(node); } catch (e) {}
          upstream = node;
        }
        try { upstream.connect(dest); } catch (e) {}
        return { head, volume, panner, fxNodes, fxChain };
      } catch (e) {
        return null;
      }
    }
    function _disposeItemBuses(buses) {
      if (!Array.isArray(buses)) return;
      buses.forEach(b => {
        if (!b) return;
        // Per-item-lane samplers built in playTrackItem so sample
        // notes route through the lane FX chain. Dispose alongside
        // the bus so the (sometimes many) Tone.Samplers don't leak
        // when the user adds a long sample-heavy track and swaps
        // items repeatedly. The map carries null placeholders for
        // sample types that never fired in this item — skip those
        // so we don't try to dispose a null.
        if (b._laneSamplerMap && typeof b._laneSamplerMap.forEach === 'function') {
          b._laneSamplerMap.forEach(samp => {
            if (!samp) return;
            try { samp.disconnect(); } catch (e) {}
            try { samp.dispose();    } catch (e) {}
          });
          b._laneSamplerMap = null;
          if (b.head) b.head._laneSamplers = null;
        }
        try { b.head?.disconnect(); } catch (e) {}
        try { b.head?.dispose(); } catch (e) {}
        try { b.volume?.dispose(); } catch (e) {}
        try { b.panner?.dispose(); } catch (e) {}
        if (b.fxNodes) {
          Object.values(b.fxNodes).forEach(n => {
            try { n.disconnect(); } catch (e) {}
            try { n.dispose(); } catch (e) {}
          });
        }
      });
    }
    // Build a per-item Tone.Gain inserted between the item's playback
    // nodes and the trackBus. Used by every item type (multi-lane,
    // legacy single-stream, audio) so the per-item volume slider applies
    // uniformly. Returns the gain node (caller stashes for disposal)
    // and the dest the rest of the item should route into. When the
    // item is at unity (or has no volume set) we still allocate a Gain
    // so callers can rely on a uniform shape; the cost is negligible
    // and keeps stopTrack / cleanup simple.
    function _buildItemGain(item, dest) {
      const vol = Number.isFinite(item?.volume) ? item.volume : 100;
      try {
        const gain = new Tone.Gain(Math.max(0, vol / 100)).connect(dest);
        return gain;
      } catch (e) {
        return null;
      }
    }
    function _disposeItemGain(gain) {
      if (!gain) return;
      try { gain.disconnect(); } catch (e) {}
      try { gain.dispose(); } catch (e) {}
    }
    // Roughly how many seconds of audible tail this item could produce
    // after its last step fires — used to keep the per-item audio graph
    // alive long enough for sustain / release / FX trails to bleed into
    // the next item without a click. Pulls from the live globalFx, the
    // item's own globalFx snapshot, and every lane's FX send so the
    // worst-case reverb / delay decay sets the floor.
    function _estimateItemTailSec(item) {
      let tail = 0;
      try {
        tail = (typeof fxTailSec === 'function')
          ? fxTailSec(
              globalFx.reverb, globalFx.reverbSize,
              globalFx.delay,  globalFx.delayTime, globalFx.delayFeedback
            )
          : 0;
      } catch (e) {}
      if (item && item.globalFx) {
        try {
          const f = item.globalFx;
          tail = Math.max(tail, fxTailSec(
            f.reverb || 0, Number.isFinite(f.reverbSize)    ? f.reverbSize    : 70,
            f.delay  || 0, Number.isFinite(f.delayTime)     ? f.delayTime     : 250,
                           Number.isFinite(f.delayFeedback) ? f.delayFeedback : 40
          ));
        } catch (e) {}
      }
      if (item && Array.isArray(item.lanes)) {
        item.lanes.forEach(l => {
          if (!l || !l.sends) return;
          try {
            tail = Math.max(tail, fxTailSec(
              l.sends.reverb || 0, globalFx.reverbSize,
              l.sends.delay  || 0, globalFx.delayTime, globalFx.delayFeedback
            ));
          } catch (e) {}
        });
      }
      // 1.5 s on top covers synth envelope release past the FX tail.
      // Clamp so an extreme feedback setting can't park dozens of node
      // chains on a multi-minute timer.
      return Math.min(20, Math.max(0.3, tail) + 1.5);
    }
    // Defer disposal of the just-finished item's lane buses + gain so
    // sustains, releases, and FX trails can ring into the next item
    // instead of getting chopped (the pop the user reported). The
    // timer is tracked on the track so a later stopTrack / removeTrack
    // can drain everything in one go if needed.
    function _scheduleItemTeardown(track, buses, gain, tailSec) {
      if (!track || (!buses && !gain)) return;
      if (!Array.isArray(track._pendingDisposes)) track._pendingDisposes = [];
      const delayMs = Math.max(50, Math.round((Number(tailSec) || 2) * 1000));
      const entry = { buses, gain, timer: null };
      entry.timer = setTimeout(() => {
        const list = track._pendingDisposes;
        if (Array.isArray(list)) {
          const i = list.indexOf(entry);
          if (i >= 0) list.splice(i, 1);
        }
        if (buses) _disposeItemBuses(buses);
        if (gain)  _disposeItemGain(gain);
      }, delayMs);
      track._pendingDisposes.push(entry);
    }
    function _drainPendingItemDisposes(track) {
      if (!track || !Array.isArray(track._pendingDisposes)) return;
      const list = track._pendingDisposes;
      track._pendingDisposes = [];
      list.forEach(e => {
        try { clearTimeout(e.timer); } catch (err) {}
        if (e.buses) _disposeItemBuses(e.buses);
        if (e.gain)  _disposeItemGain(e.gain);
      });
    }

    function stopTrack(trackIdx, natural = false) {
      const track = tracks[trackIdx];
      if (!track) return;
      if (track.timer) clearTimeout(track.timer);
      track.timer = null;
      // Multi-lane track items run one setTimeout chain per lane, all
      // tracked in track.timers. Cancel every one so a stop mid-item
      // doesn't leave orphan voices firing in the background.
      if (Array.isArray(track.timers)) {
        track.timers.forEach(t => { try { clearTimeout(t); } catch (e) {} });
      }
      track.timers = null;
      track._lanesRemaining = 0;
      // Defer the current item's audio chain so any in-flight release
      // tails / FX trails fade out naturally instead of clicking off
      // when the user hits Stop (or a natural end). Pending teardowns
      // from earlier item swaps just keep ticking on their own timers.
      if (track._itemBuses || track._itemGain) {
        const curItem = (Number.isFinite(track.currentItemIdx) && track.currentItemIdx >= 0)
          ? track.items[track.currentItemIdx]
          : null;
        const tail = (typeof _estimateItemTailSec === 'function')
          ? _estimateItemTailSec(curItem)
          : 2.5;
        _scheduleItemTeardown(track, track._itemBuses, track._itemGain, tail);
        track._itemBuses = null;
        track._itemGain  = null;
      }
      track.playing = false;
      track.currentItemIdx = null;
      renderTracks();
      // Master loop: if this track finished on its own AND it was the last
      // one still playing AND the master-loop toggle is on, restart everything.
      if (natural && tracksMasterLoop && tracks.length > 0 && tracks.every(t => !t.playing)) {
        // Reset the play cursor to the loop start so the visual line
        // wraps back along with the audio (playAllTracks reads
        // _tracksCursorSec to pick each track's restart item).
        _tracksCursorSec = tracksLoopStartSec;
        _tracksPlaybackStartWallMs = null;
        if (typeof _updatePlayCursor === 'function') _updatePlayCursor();
        setTimeout(() => { if (tracksMasterLoop) playAllTracks(); }, 30);
      } else if (tracks.every(t => !t.playing)) {
        // No more tracks playing — freeze the cursor at the last
        // computed time so it stops moving and reflects where audio
        // ended. Stop the RAF anim to free the loop.
        if (_tracksPlaybackStartWallMs != null) {
          _tracksCursorSec = _currentTracksTimeSec();
        }
        _tracksPlaybackStartWallMs = null;
        if (typeof _stopPlayCursorAnim === 'function') _stopPlayCursorAnim();
        if (typeof _updatePlayCursor === 'function') _updatePlayCursor();
        // Drop the shared Mix epoch + per-track epoch offsets so the
        // next play session captures a fresh one. Keeping a stale
        // epoch would point all baseAudioTime calculations at audio
        // times far in the past, and Tone would race to fire every
        // queued note ASAP on the next Play press.
        _tracksAudioEpoch = null;
        tracks.forEach(t => { if (t) t._epoch = null; });
      }
    }

    // Lazy per-track audio chain — synth → EQ3 → Panner → masterBus. Both
    // nodes are built on first access and reused thereafter, keeping the
    // playback hot path cheap. getTrackBus returns the EQ3 (the entry that
    // synths/players connect to); the panner is reachable as track._panner.
    function getTrackBus(trackIdx) {
      const track = tracks[trackIdx];
      if (!track) return masterBus;
      if (!track._bus) {
        const eq  = track.eq || { low: 0, mid: 0, high: 0 };
        const pan = Math.max(-1, Math.min(1, Number.isFinite(track.pan) ? track.pan : 0));
        const eqIsFlat = !(eq.low || 0) && !(eq.mid || 0) && !(eq.high || 0);
        // Chain order: [EQ →] [Mono →] Panner → globalSendTap. Tone.EQ3
        // splits the signal into three frequency bands and sums them —
        // at flat 0/0/0 the reconstruction has small crossover dips,
        // audibly quieter than the lane bus's transparent Volume node
        // used in Bloops playback. Skip the EQ3 when the user hasn't
        // set any EQ; setTrackEq below routes through it directly via
        // track._bus either way so the on-demand path still works
        // after dialing in a band. The Mono node optionally sums L+R
        // before the panner; skip it entirely on stereo tracks.
        // Routing through globalSendTap (instead of masterBus) puts
        // track audio on the same FX-return rails as live cell presses
        // — without this, the master FX panel was silent for tracks.
        track._panner = new Tone.Panner(pan).connect(globalSendTap);
        if (track.stereo === false) {
          track._mono = new Tone.Mono().connect(track._panner);
        } else {
          track._mono = null;
        }
        if (eqIsFlat) {
          // Plain unity Gain — same node type that lane buses use as
          // their entry point. Transparent at default settings.
          track._bus = new Tone.Gain(1).connect(track._mono || track._panner);
          track._busIsEq = false;
        } else {
          track._bus = new Tone.EQ3({
            low:  eq.low  || 0,
            mid:  eq.mid  || 0,
            high: eq.high || 0,
          }).connect(track._mono || track._panner);
          track._busIsEq = true;
        }
      }
      return track._bus;
    }
    // Swap a track's bus node between Gain (flat) and EQ3 (any band
    // non-zero). Called after a Mix dialog edit so we only carry the
    // EQ3 cost when the user actually wants tone shaping. Existing
    // panner stays put; we only swap the entry-point bus node and
    // dispose any per-track samplers that pointed at the old bus.
    function _retuneTrackBus(trackIdx) {
      const track = tracks[trackIdx];
      if (!track || !track._bus) return;
      const eq  = track.eq || { low: 0, mid: 0, high: 0 };
      const eqIsFlat = !(eq.low || 0) && !(eq.mid || 0) && !(eq.high || 0);
      if (track._busIsEq === !eqIsFlat) return; // already the right kind
      const downstream = track._mono || track._panner;
      try { track._bus.dispose(); } catch (e) {}
      if (eqIsFlat) {
        track._bus = new Tone.Gain(1).connect(downstream);
        track._busIsEq = false;
      } else {
        track._bus = new Tone.EQ3({
          low:  eq.low  || 0,
          mid:  eq.mid  || 0,
          high: eq.high || 0,
        }).connect(downstream);
        track._busIsEq = true;
      }
      // Per-track samplers were connected to the disposed bus node —
      // rebuild on next playNote call by clearing the cache.
      if (track._samplers) {
        track._samplers.forEach(s => { try { s.dispose(); } catch (e) {} });
        track._samplers = null;
      }
    }
    function isTrackMixActive(track) {
      if (!track) return false;
      const eq = track.eq || { low: 0, mid: 0, high: 0 };
      return !!(eq.low || eq.mid || eq.high) || Math.abs(track.pan || 0) > 0.01;
    }
    function refreshTrackMixButton(trackIdx) {
      const track = tracks[trackIdx];
      const container = document.getElementById('tracks-container');
      const row = container?.children[trackIdx];
      const btn = row?.querySelector('.track-eq');
      if (btn) btn.classList.toggle('active', isTrackMixActive(track));
    }
    function setTrackEq(trackIdx, eq) {
      const track = tracks[trackIdx];
      if (!track) return;
      maybeSnapshotForUndo('Track EQ');
      track.eq = {
        low:  Number.isFinite(eq.low)  ? eq.low  : 0,
        mid:  Number.isFinite(eq.mid)  ? eq.mid  : 0,
        high: Number.isFinite(eq.high) ? eq.high : 0,
      };
      // Lazily build the bus first; then upgrade Gain → EQ3 (or
      // downgrade EQ3 → Gain) if the user dialed the EQ in or
      // zeroed it back out. Live-update the EQ band gains only when
      // the bus is the EQ3 variant (the flat Gain has no .low/.mid/.high).
      getTrackBus(trackIdx);
      _retuneTrackBus(trackIdx);
      const bus = getTrackBus(trackIdx);
      if (track._busIsEq) {
        try {
          bus.low.value  = track.eq.low;
          bus.mid.value  = track.eq.mid;
          bus.high.value = track.eq.high;
        } catch (e) {}
      }
      persistTracks();
      refreshTrackMixButton(trackIdx);
    }
    function setTrackPan(trackIdx, pan) {
      const track = tracks[trackIdx];
      if (!track) return;
      const v = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
      maybeSnapshotForUndo('Track pan');
      track.pan = v;
      getTrackBus(trackIdx); // make sure the panner exists
      try { track._panner.pan.value = v; } catch (e) {}
      persistTracks();
      refreshTrackMixButton(trackIdx);
    }
    // Per-track Tone.Sampler instances bound to track._bus so sample-based
    // notes (Piano, Organ, …) flow through the same EQ + panner path the
    // synth voices already use. The shared live samplers connect straight
    // to masterBus and would otherwise bypass per-track Mix settings.
    function getOrCreateTrackSampler(trackIdx, sampleId) {
      const track = tracks[trackIdx];
      if (!track) return null;
      if (!track._samplers) track._samplers = new Map();
      if (track._samplers.has(sampleId)) return track._samplers.get(sampleId);
      const info = sampleSamplers.get(sampleId);
      if (!info || !info.urls) return null;
      try {
        const samp = new Tone.Sampler({
          urls: info.urls,
          baseUrl: info.baseUrl,
          release: 1,
        }).connect(getTrackBus(trackIdx));
        track._samplers.set(sampleId, samp);
        return samp;
      } catch (e) {
        console.warn('Failed to create per-track sampler', sampleId, e);
        return null;
      }
    }
    function showTrackEqDialog(trackIdx) {
      const track = tracks[trackIdx];
      if (!track) return;
      if (!track.eq) track.eq = { low: 0, mid: 0, high: 0 };
      if (!Number.isFinite(track.pan)) track.pan = 0;
      const overlay = document.createElement('div');
      overlay.className = 'sm-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
      const e = track.eq;
      const fmt = (v) => (v >= 0 ? '+' : '') + Number(v).toFixed(1) + ' dB';
      const fmtPan = (v) => {
        const pct = Math.round(Math.abs(v) * 100);
        if (pct === 0) return 'Center';
        return (v < 0 ? 'L ' : 'R ') + pct;
      };
      modal.innerHTML = `
        <div class="sm-title">Mix — ${track.name}</div>
        <div class="sm-section-label">EQ</div>
        <div class="sm-param">
          <div class="sm-param-row">Low <span class="sm-val" id="eq-low-v">${fmt(e.low)}</span></div>
          <input type="range" id="eq-low" min="-12" max="12" step="0.5" value="${e.low}" />
        </div>
        <div class="sm-param">
          <div class="sm-param-row">Mid <span class="sm-val" id="eq-mid-v">${fmt(e.mid)}</span></div>
          <input type="range" id="eq-mid" min="-12" max="12" step="0.5" value="${e.mid}" />
        </div>
        <div class="sm-param">
          <div class="sm-param-row">High <span class="sm-val" id="eq-high-v">${fmt(e.high)}</span></div>
          <input type="range" id="eq-high" min="-12" max="12" step="0.5" value="${e.high}" />
        </div>
        <div class="sm-section-label">Pan</div>
        <div class="sm-param">
          <div class="sm-param-row">Position <span class="sm-val" id="mix-pan-v">${fmtPan(track.pan)}</span></div>
          <input type="range" id="mix-pan" min="-100" max="100" step="1" value="${Math.round(track.pan * 100)}" />
        </div>
        <div class="sm-footer">
          <button type="button" class="sm-preview" id="eq-reset">Flat</button>
          <button type="button" class="sm-apply" id="eq-done">Done</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });

      const lowSel  = modal.querySelector('#eq-low');
      const midSel  = modal.querySelector('#eq-mid');
      const highSel = modal.querySelector('#eq-high');
      const panSel  = modal.querySelector('#mix-pan');
      const lowVal  = modal.querySelector('#eq-low-v');
      const midVal  = modal.querySelector('#eq-mid-v');
      const highVal = modal.querySelector('#eq-high-v');
      const panVal  = modal.querySelector('#mix-pan-v');
      const applyEq = () => {
        const next = {
          low:  parseFloat(lowSel.value)  || 0,
          mid:  parseFloat(midSel.value)  || 0,
          high: parseFloat(highSel.value) || 0,
        };
        lowVal.textContent  = fmt(next.low);
        midVal.textContent  = fmt(next.mid);
        highVal.textContent = fmt(next.high);
        setTrackEq(trackIdx, next);
      };
      const applyPan = () => {
        const v = (parseInt(panSel.value, 10) || 0) / 100;
        panVal.textContent = fmtPan(v);
        setTrackPan(trackIdx, v);
      };
      // Coalesce each slider drag into a single undo entry. `input`
      // fires many times per second; without the batch, the history
      // would fill up with noise per pixel of drag.
      const startEqBatch  = () => beginUndoBatch('Track EQ');
      const startPanBatch = () => beginUndoBatch('Track pan');
      const endBatch      = () => endUndoBatch();
      [lowSel, midSel, highSel].forEach(s => {
        s.addEventListener('pointerdown', startEqBatch);
        s.addEventListener('pointerup',   endBatch);
        s.addEventListener('pointercancel', endBatch);
        s.addEventListener('change',      endBatch);
      });
      panSel.addEventListener('pointerdown', startPanBatch);
      panSel.addEventListener('pointerup',   endBatch);
      panSel.addEventListener('pointercancel', endBatch);
      panSel.addEventListener('change',      endBatch);
      lowSel.addEventListener('input',  applyEq);
      midSel.addEventListener('input',  applyEq);
      highSel.addEventListener('input', applyEq);
      panSel.addEventListener('input',  applyPan);
      modal.querySelector('#eq-reset').addEventListener('click', () => {
        beginUndoBatch('Reset EQ/Pan');
        try {
          lowSel.value = '0'; midSel.value = '0'; highSel.value = '0';
          panSel.value = '0';
          applyEq(); applyPan();
        } finally { endUndoBatch(); }
      });
      modal.querySelector('#eq-done').addEventListener('click', () => overlay.remove());
    }
    // Cheap active-item highlight that skips the full renderTracks DOM
    // rebuild — used inside the playback timer so item transitions (and
    // especially loop wraps) don't stall waiting on layout work.
    // ---- Per-track audio recording ------------------------------------
    // Records mic input directly into a track as an audio item, while
    // playing every OTHER non-empty track in parallel for monitoring (so
    // you can lay down a vocal or instrument take against the rest of the
    // mix). Stopping the recorder appends the captured blob as a new
    // audio item to the track and stops any monitor tracks the recording
    // started.
    function toggleTrackRecording(trackIdx) {
      const track = tracks[trackIdx];
      if (!track) return;
      if (track._countingIn || track._recording) stopTrackRecording(trackIdx);
      else                                       startTrackRecording(trackIdx);
    }
    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      });
    }
    async function startTrackRecording(trackIdx) {
      const track = tracks[trackIdx];
      if (!track || track._recording) return;
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
      // Only one track recording at a time. Stop any other ongoing track
      // recordings (and the saved-bank recorder) before starting this one.
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch (e) {}
      }
      tracks.forEach((t, i) => {
        if (i !== trackIdx && t._recording && t._recorder) {
          try { t._recorder.stop(); } catch (e) {}
        }
      });
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        alert('Microphone access was denied or unavailable.');
        return;
      }
      const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      const mimeType = prefs.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      track._recorder    = recorder;
      track._recStream   = stream;
      track._recChunks   = chunks;
      track._recMimeType = recorder.mimeType || mimeType || 'audio/webm';

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        const durationSec = Math.max(0.05, (performance.now() - (track._recStartMs || performance.now())) / 1000);
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        // Stop the monitor tracks this recording brought up — leave any
        // tracks the user had already playing alone.
        const monitor = track._recMonitorTracks || [];
        monitor.forEach(i => stopTrack(i));
        track._recording        = false;
        track._recorder         = null;
        track._recStream        = null;
        track._recChunks        = null;
        track._recMonitorTracks = null;
        track._recStartMs       = 0;
        if (chunks.length === 0) { renderTracks(); return; }
        try {
          const blob = new Blob(chunks, { type: track._recMimeType });
          const dataUrl = await blobToDataUrl(blob);
          const takeNum = (track.items || []).filter(it => it.type === 'audio').length + 1;
          track.items = track.items || [];
          track.items.push({
            type: 'audio',
            name: `Take ${takeNum}`,
            audioDataUrl: dataUrl,
            durationSec,
            steps: [],
          });
          try { persistTracks(); } catch (e) {
            track.items.pop();
            alert('Recorded clip is too large to persist in browser storage. Track recorded but not saved across reloads — export soon.');
          }
        } catch (e) {
          console.error(e);
          alert(`Failed to attach recording: ${e.message || e}`);
        }
        renderTracks();
      };

      // Optional count-in at workspace tempo before the recorder + monitor
      // playback start. _countingIn flips the rec button to a counting
      // visual and gates re-clicks until the count finishes.
      if (countInEnabled) {
        track._countingIn = true;
        renderTracks();
        try { await playCountIn(); } finally { track._countingIn = false; }
        // If the track or recorder was torn down during the count (e.g. via
        // applyProjectSnapshot or removeTrack), bail out cleanly.
        if (!track._recorder || track._recorder !== recorder) {
          try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
          renderTracks();
          return;
        }
      }

      track._recStartMs = performance.now();
      track._recording  = true;
      try {
        recorder.start();
      } catch (e) {
        track._recording = false;
        track._recorder = null;
        try { stream.getTracks().forEach(t => t.stop()); } catch (er) {}
        alert(`Couldn't start recorder: ${e.message || e}`);
        renderTracks();
        return;
      }

      // Bring up every other non-empty track so the user can play / sing
      // along with the existing mix. Track which ones we started so we can
      // tear them down on stop without disturbing user-initiated playback.
      const monitor = [];
      tracks.forEach((t, i) => {
        if (i === trackIdx) return;
        if (!t.items || t.items.length === 0) return;
        if (t.playing) return;
        try { startTrack(i); monitor.push(i); } catch (e) {}
      });
      track._recMonitorTracks = monitor;

      renderTracks();
    }
    function stopTrackRecording(trackIdx) {
      const track = tracks[trackIdx];
      if (!track) return;
      // Clicking stop during the count-in cancels the upcoming recording.
      if (track._countingIn) {
        track._countingIn = false;
        try { track._recStream?.getTracks().forEach(t => t.stop()); } catch (e) {}
        track._recorder = null;
        track._recStream = null;
        renderTracks();
        return;
      }
      if (!track._recording || !track._recorder) return;
      try { track._recorder.stop(); } catch (e) {}
      // Cleanup happens inside the recorder.onstop handler above.
    }

    function setActiveTrackItem(trackIdx, itemIdx) {
      const container = document.getElementById('tracks-container');
      if (!container) return;
      const row = container.children[trackIdx];
      if (!row) return;
      const blocks = row.querySelectorAll('.track-item');
      blocks.forEach((b, i) => b.classList.toggle('active', i === itemIdx));
    }

    // Advance a track's epoch by exactly one loop length so the wrapped
    // playTrackItem(trackIdx, restartIdx) call computes a baseAudioTime
    // that picks up exactly where the prior iteration ended. Called
    // from every loop-restart site (step-item past-end branch, silent-
    // item loop, audio-item loop) so every restart path keeps the
    // shared Mix epoch phase-locked.
    function _advanceTrackEpochForLoop(track, restartIdx) {
      if (!track || track._epoch == null) return;
      const ranges = _trackItemTimeRanges(track);
      if (ranges.length === 0) return;
      const lastEndSec = ranges[ranges.length - 1].endSec;
      const restartSec = (ranges[restartIdx] && Number.isFinite(ranges[restartIdx].startSec))
        ? ranges[restartIdx].startSec : 0;
      track._epoch += Math.max(0, lastEndSec - restartSec);
    }

    // Silent placeholder — left behind when a saved sequence is removed.
    // Holds its slot in the track so following items don't shift sooner;
    // playback just runs out the duration without scheduling any audio.
    function playSilentItem(trackIdx, itemIdx, item) {
      const track = tracks[trackIdx];
      if (!track || !track.playing) return;
      const advanceMs = Math.max(50, (item.durationSec || 0) * 1000);
      track.timer = setTimeout(() => {
        const nextItem = itemIdx + 1;
        if (nextItem < track.items.length) {
          playTrackItem(trackIdx, nextItem, 0);
        } else if (track.loopMode && track.items.length > 0) {
          _advanceTrackEpochForLoop(track, 0);
          playTrackItem(trackIdx, 0, 0);
        } else {
          stopTrack(trackIdx, true);
        }
      }, advanceMs);
      if (track.currentItemIdx !== itemIdx) {
        track.currentItemIdx = itemIdx;
        setActiveTrackItem(trackIdx, itemIdx);
      }
    }

    function playAudioItem(trackIdx, itemIdx, item) {
      const track = tracks[trackIdx];
      if (!track || !track.playing) return;
      const playbackRate = Number.isFinite(item.playbackRate) && item.playbackRate > 0
        ? item.playbackRate : 1;
      // Audio items route through the per-item Gain like step items do
      // so the per-item volume slider lifts/cuts them uniformly with
      // sequence items. Stashed on the track for stopTrack cleanup.
      const itemGain = _buildItemGain(item, getTrackBus(trackIdx));
      track._itemGain = itemGain;
      const playerDest = itemGain || getTrackBus(trackIdx);
      const player = new Tone.Player({
        url: item.audioDataUrl,
        autostart: false,
        playbackRate,
        onload: () => { try { player.start(); } catch (e) {} },
      }).connect(playerDest);
      const advanceMs = Math.max(50, (item.durationSec || 0) * 1000);
      track.timer = setTimeout(() => {
        try { player.stop(); } catch (e) {}
        setTimeout(() => { try { player.dispose(); } catch (e) {} }, 200);
        const nextItem = itemIdx + 1;
        if (nextItem < track.items.length) {
          playTrackItem(trackIdx, nextItem, 0);
        } else if (track.loopMode && track.items.length > 0) {
          _advanceTrackEpochForLoop(track, 0);
          playTrackItem(trackIdx, 0, 0);
        } else {
          stopTrack(trackIdx, true);
        }
      }, advanceMs);
      if (track.currentItemIdx !== itemIdx) {
        track.currentItemIdx = itemIdx;
        setActiveTrackItem(trackIdx, itemIdx);
      }
    }

    // Plays one step from a lane's flat-step array, schedules the
    // next step via setTimeout, and calls onLaneEnd when the lane runs
    // out. Used by playTrackItem's multi-lane fan-out so every lane
    // advances independently while sharing the track's bus.
    //
    // Drift correction: each lane carries baseAudioTime (Tone audio
    // clock at lane start), startWallMs (performance.now() at lane
    // start), and offsetSec (cumulative musical time so far). Audio
    // fires at the exact Tone time `baseAudioTime + offsetSec` so
    // the AUDIO clock stays sample-accurate regardless of JS-thread
    // jitter. The next setTimeout's delay is computed against the
    // wall-clock target (startWallMs + nextOffsetSec * 1000), so any
    // late tick shortens its own delay — drift can't accumulate.
    // setTimeout-only chains used to slip noticeably slower than the
    // Bloops scheduler over multi-lane / long-sequence playback.
    function _trackLaneTick(track, trackIdx, item, flatSteps, stepIdx, onLaneEnd, laneState) {
      if (!track || !track.playing) return;
      const step = flatSteps[stepIdx];
      const stepSub = (step.subdivision != null) ? step.subdivision : (item.subdivision || 1);
      const bpm = item.bpm || 120;
      const waitSec = (60 / bpm) * stepSub * (step.duration || 1);
      const waitMs  = waitSec * 1000;
      const fireTime = laneState.baseAudioTime + laneState.offsetSec;
      // Destination: prefer the lane's own bus (volume + pan + FX from
      // the saved sequence's per-lane state) so track playback sounds
      // like Make playback. Falls back to trackBus for legacy single-
      // stream items that don't carry per-lane state.
      const dest = laneState.destination || getTrackBus(trackIdx);
      if (step.isFluid && Array.isArray(step.samples)) {
        // Fluid XY recording — replay the captured gesture as a single
        // sustained voice that ramps through every sample. Routed
        // through the lane bus so per-lane volume / pan / FX apply.
        _playFluidStep(step, fireTime, dest);
      } else if (step.chord) {
        const size = step.chord.length;
        step.chord.forEach(n => playNote(n.freq, paramsWithBend(chordVoiceParams(n.params || n.sound || 'sine', size, step), step.bend), waitMs, fireTime, dest, trackIdx));
      } else if (step.freq !== null && step.freq !== undefined) {
        playNote(step.freq, paramsWithBend(step.params || step.sound || 'sine', step.bend), waitMs, fireTime, dest, trackIdx);
      }
      laneState.offsetSec += waitSec;
      const targetWall = laneState.startWallMs + laneState.offsetSec * 1000;
      const delay = Math.max(0, targetWall - performance.now());
      const t = setTimeout(() => {
        if (Array.isArray(track.timers)) {
          const i = track.timers.indexOf(t);
          if (i >= 0) track.timers.splice(i, 1);
        }
        // Loop until the lane has covered laneState.targetSec — short
        // lanes wrap to the start so they fill the same window the
        // longest lane occupies, matching Bloops poly playback's
        // independent-loops behavior. End of one pass through the
        // step list (nextStep === flatSteps.length) loops back to 0
        // when there's still target time left.
        const reachedTarget = Number.isFinite(laneState.targetSec)
          && laneState.offsetSec >= laneState.targetSec - 1e-6;
        if (reachedTarget) {
          onLaneEnd();
          return;
        }
        const nextStep = (stepIdx + 1) % flatSteps.length;
        _trackLaneTick(track, trackIdx, item, flatSteps, nextStep, onLaneEnd, laneState);
      }, delay);
      if (!Array.isArray(track.timers)) track.timers = [];
      track.timers.push(t);
    }

    function playTrackItem(trackIdx, itemIdx) {
      const track = tracks[trackIdx];
      if (!track || !track.playing) return;
      // Loop region (only enforced while masterLoop is on): if the
      // item we'd play sits past the loop end, treat it as the
      // track's natural end so the masterLoop restart kicks in and
      // every track wraps back to the loop start together.
      if (tracksMasterLoop
        && typeof _itemIsBeyondLoopEnd === 'function'
        && _itemIsBeyondLoopEnd(track, itemIdx)) {
        stopTrack(trackIdx, true);
        return;
      }
      if (itemIdx >= track.items.length) {
        if (track.loopMode && track.items.length > 0) {
          // Per-track loop: replay from the loop-region start when
          // masterLoop is on, otherwise from the head of the track.
          const restartIdx = tracksMasterLoop && typeof _trackStartItemForLoop === 'function'
            ? _trackStartItemForLoop(track)
            : 0;
          _advanceTrackEpochForLoop(track, restartIdx);
          playTrackItem(trackIdx, restartIdx);
        } else {
          stopTrack(trackIdx, true);
        }
        return;
      }
      const item = track.items[itemIdx];
      // Per-item FX recall: if the item carries a captured globalFx
      // snapshot (set by addSavedToTrack), copy it into the live state
      // and push it to the audio graph. This is how each saved
      // sequence's FX actually reaches the track audio — the trackBus
      // routes through globalSendTap which reads from live globalFx,
      // so the FX wet you hear is always whatever the most-recently-
      // started item put there. Restore-on-stop is intentionally NOT
      // wired up (the user is free to dial the panel back themselves).
      if (item && item.globalFx && typeof applyGlobalFx === 'function') {
        try {
          Object.keys(GLOBAL_FX_DEFAULTS).forEach(k => {
            if (k in item.globalFx) globalFx[k] = item.globalFx[k];
          });
          applyGlobalFx();
        } catch (e) {}
      }
      // Defer disposal of the previous item's lane buses + gain so
      // synth releases and FX trails bleed into the next item instead
      // of being clicked off mid-decay. Without this, every iteration
      // of a looped sequence (or two saved sequences placed back-to-
      // back) produces an audible pop because the audio graph is
      // disconnected the instant the last step fires. _scheduleItem
      // Teardown parks them on a timer keyed to the worst-case tail
      // (reverb / delay decay + ~1.5 s for envelope release).
      const _prevItem  = (Number.isFinite(track.currentItemIdx) && track.currentItemIdx >= 0)
        ? track.items[track.currentItemIdx]
        : null;
      const _prevTail  = (typeof _estimateItemTailSec === 'function')
        ? _estimateItemTailSec(_prevItem)
        : 2.5;
      if ((track._itemBuses && track._itemBuses.length > 0) || track._itemGain) {
        _scheduleItemTeardown(track, track._itemBuses, track._itemGain, _prevTail);
        track._itemBuses = null;
        track._itemGain  = null;
      }
      if (item && item.type === 'audio') {
        playAudioItem(trackIdx, itemIdx, item);
        return;
      }
      if (item && item.type === 'silent') {
        playSilentItem(trackIdx, itemIdx, item);
        return;
      }
      // Resolve which step lists make up this item, paired with their
      // source lane so each can route through its own per-lane bus
      // (volume / panner / FX chain). For legacy single-stream items
      // (no item.lanes), one stream routes through the trackBus
      // directly — no per-lane bus needed since there's no per-lane
      // state to apply.
      let laneEntries; // [{ flat, lane | null }]
      if (Array.isArray(item.lanes) && item.lanes.length > 0) {
        const anySolo = item.lanes.some(l => l && l.solo);
        laneEntries = item.lanes
          .filter(l => l && Array.isArray(l.steps) && l.steps.length > 0
            && (anySolo ? !!l.solo : !l.muted))
          .map(l => ({ flat: flattenItemSteps(l.steps), lane: l }))
          .filter(e => e.flat.length > 0);
      } else if (item && Array.isArray(item.steps) && item.steps.length > 0) {
        const flat = flattenItemSteps(item.steps);
        laneEntries = flat.length > 0 ? [{ flat, lane: null }] : [];
      } else {
        laneEntries = [];
      }
      if (laneEntries.length === 0) {
        playTrackItem(trackIdx, itemIdx + 1);
        return;
      }
      // Build the per-lane buses now that we know which lanes are
      // playable. Each gets a Gain head → Volume → Panner → lane FX
      // chain → trackBus. Lanes whose sends are all zero skip the
      // FX chain entirely; their head connects straight through the
      // pan/vol pair to trackBus.
      // Per-item Gain sits between the lane buses and the track bus so
      // the user's per-item volume slider scales the whole item. At
      // unity it's a no-op node — kept uniform across items so cleanup
      // doesn't need to branch.
      const trackBusEnd  = getTrackBus(trackIdx);
      const itemGain     = _buildItemGain(item, trackBusEnd);
      track._itemGain    = itemGain;
      const trackBusForItem = itemGain || trackBusEnd;
      const itemBuses = laneEntries.map(e => _buildItemLaneBus(e.lane, trackBusForItem));
      track._itemBuses = itemBuses;
      // Walk a step list and collect every sample:<id> referenced as
      // a synth type. Used both to prefetch the per-track samplers
      // and to build per-item-lane samplers below.
      const collectSampleTypes = (arr, into) => {
        if (!Array.isArray(arr)) return;
        for (const s of arr) {
          if (!s) continue;
          if (s.isSub && Array.isArray(s.subSteps)) { collectSampleTypes(s.subSteps, into); continue; }
          if (Array.isArray(s.chord)) {
            s.chord.forEach(n => {
              const t = (n && n.params && n.params.type) || (n && n.sound);
              if (typeof t === 'string' && t.startsWith('sample:')) into.add(t.slice(7));
            });
          } else {
            const t = (s.params && s.params.type) || s.sound;
            if (typeof t === 'string' && t.startsWith('sample:')) into.add(t.slice(7));
          }
        }
      };
      // Per-item-lane samplers: when a lane carries non-zero FX sends
      // its lane bus head sits in front of the FX chain. Sample-based
      // notes need to enter the chain through that head — but the
      // per-track sampler is wired straight to the trackBus, so it
      // skips the FX entirely. Build a fresh Sampler per (item-lane,
      // sample-id) routed to the lane head so reverb / delay / etc.
      // are actually audible on sample lanes. Stash the map on the
      // bus head; playNote reads it via `destination._laneSamplers`.
      // Lanes without FX skip this work — they sound identical
      // whether the sampler hits the head or the trackBus.
      //
      // Lazy creation: instead of constructing every per-item-lane
      // sampler upfront when the item starts, the maps below carry
      // null entries that playNote materialises on first use. Eager
      // construction was firing N parallel HTTP fetches across every
      // (track, lane, sample) tuple the moment playAllTracks ran —
      // on a phone with two or more tracks that piled up enough
      // concurrent decodes to stall (and sometimes crash) Safari /
      // Chrome iOS. Lazy build spreads the cost across actual note
      // events and skips samplers whose sample type never fires.
      try {
        laneEntries.forEach((e, li) => {
          const bus = itemBuses[li];
          if (!bus || !bus.head) return;
          const hasFx = bus.fxChain && bus.fxChain.length > 0;
          if (!hasFx) return;
          const types = new Set();
          collectSampleTypes(e.flat, types);
          if (types.size === 0) return;
          const sMap = new Map();
          types.forEach(id => { sMap.set(id, null); }); // placeholder
          sMap._busHead = bus.head;
          sMap._materialize = (sampleId) => {
            const existing = sMap.get(sampleId);
            if (existing) return existing;
            const info = sampleSamplers.get(sampleId);
            if (!info || !info.urls) return null;
            try {
              const samp = new Tone.Sampler({
                urls: info.urls,
                baseUrl: info.baseUrl,
                release: 1,
              }).connect(bus.head);
              sMap.set(sampleId, samp);
              return samp;
            } catch (err) {
              sMap.delete(sampleId);
              return null;
            }
          };
          bus.head._laneSamplers = sMap;
          bus._laneSamplerMap    = sMap; // kept for teardown
        });
      } catch (e) {}
      // Also prefetch the per-track samplers for any sample type used
      // anywhere in the item. These cover lanes WITHOUT FX (which still
      // route the trackBus path) and the no-lanes legacy path. Without
      // this the first wave of sample-type voices falls back to the
      // shared sampler (no per-track EQ / pan) until the per-track
      // sampler finishes its load.
      try {
        const allSampleTypes = new Set();
        laneEntries.forEach(e => collectSampleTypes(e.flat, allSampleTypes));
        allSampleTypes.forEach(id => { try { getOrCreateTrackSampler(trackIdx, id); } catch (e) {} });
      } catch (e) {}
      // One setTimeout chain per lane; advance to the next item only
      // after every chain has finished (the LONGEST lane drives the
      // item's effective duration). _trackLaneTick pushes its timers
      // onto track.timers so stopTrack can cancel them all in one go.
      track.timers = [];
      track._lanesRemaining = laneEntries.length;
      const onLaneEnd = () => {
        if (!track.playing) return;
        track._lanesRemaining = Math.max(0, (track._lanesRemaining || 0) - 1);
        if (track._lanesRemaining === 0) {
          playTrackItem(trackIdx, itemIdx + 1);
        }
      };
      // Anchor every lane in this item against the track's epoch + the
      // item's cumulative start time. Falls back to Tone.now() only if
      // the epoch isn't set (defensive — every normal entry path sets
      // it in startTrack). With the epoch, item N's first note lands at
      // exactly (sessionStart + N's mathematical offset), so item-to-
      // item handoffs and parallel-track sync are sample-accurate
      // instead of callback-driven.
      const _itemRanges       = _trackItemTimeRanges(track);
      const _itemStartSec     = (_itemRanges[itemIdx] && Number.isFinite(_itemRanges[itemIdx].startSec))
        ? _itemRanges[itemIdx].startSec : 0;
      const baseAudioTime = (track._epoch != null)
        ? track._epoch + _itemStartSec
        : ((typeof Tone !== 'undefined' && typeof Tone.now === 'function') ? Tone.now() : 0);
      const startWallMs = performance.now();
      const itemBpmL = item.bpm || 120;
      const itemSubL = item.subdivision || 1;
      const onePassSec = (flat) => {
        let s = 0;
        flat.forEach(step => {
          const ss = (step.subdivision != null) ? step.subdivision : itemSubL;
          const sm = Math.round(60000 / itemBpmL * ss);
          s += (sm * (step.duration || 1)) / 1000;
        });
        return s;
      };
      const targetSec = Math.max(...laneEntries.map(e => onePassSec(e.flat)));
      laneEntries.forEach((e, i) => {
        // Per-lane destination: the lane's own bus head, or trackBus
        // for the legacy single-stream case (e.lane = null).
        const dest = (itemBuses[i] && itemBuses[i].head) || trackBusForItem;
        _trackLaneTick(track, trackIdx, item, e.flat, 0, onLaneEnd, {
          baseAudioTime,
          startWallMs,
          targetSec,
          offsetSec: 0,
          destination: dest,
        });
      });
      if (track.currentItemIdx !== itemIdx) {
        track.currentItemIdx = itemIdx;
        setActiveTrackItem(trackIdx, itemIdx);
      }
    }

    function stopAllTracks() {
      tracks.forEach((_, i) => stopTrack(i));
    }

    async function playAllTracks() {
      await Tone.start();
      // Wait for any pending sample buffers (Piano / Organ / imported,
      // etc.) to finish loading BEFORE we capture the shared audio
      // epoch. If a track's own await Tone.loaded() resolves later than
      // the epoch, its first note's fireTime would already be in the
      // past, Tone would fire it ASAP, and that track would start
      // ahead of the others. Resolving here makes every startTrack a
      // synchronous-feeling sibling against the same epoch.
      // Capped (see togglePlayTrack): a down remote-sample CDN must not hang
      // the transport on a bare await.
      try { await Promise.race([Tone.loaded(), new Promise((r) => setTimeout(r, 500))]); } catch (e) {}
      // Snap cursor into the loop region when masterLoop is on so
      // playback always starts inside the loop bounds (and the
      // visual cursor lines up with where audio actually starts).
      // When the loop end is left at "all the way" (tracksLoopEndSec
      // null), use maxSec as the effective end — earlier this used
      // Infinity, so a cursor parked at maxSec from a previous
      // unlooped play-through never reset and the first loop pass
      // stayed frozen at the end before snapping back on iteration 2.
      if (tracksMasterLoop) {
        const maxSecPA = (typeof _maxTracksDurationSec === 'function')
          ? _maxTracksDurationSec()
          : 0;
        const loopEnd = (tracksLoopEndSec == null) ? maxSecPA : tracksLoopEndSec;
        if (_tracksCursorSec < tracksLoopStartSec - 1e-6
          || _tracksCursorSec >= loopEnd - 1e-6) {
          _tracksCursorSec = tracksLoopStartSec;
        }
      }
      // Single shared audio epoch — 60 ms of warmup baked in so the
      // first note's scheduled time sits comfortably ahead of
      // currentTime even after a cold audio context. Every track in
      // this session derives its baseAudioTime from this anchor, so
      // parallel tracks stay in lockstep and item boundaries become
      // pure arithmetic instead of callback-driven Tone.now() reads.
      _tracksAudioEpoch = (typeof Tone !== 'undefined' && typeof Tone.now === 'function')
        ? Tone.now() + 0.06
        : null;
      // Capture the playback base so the RAF cursor anim can compute
      // current time as base + wall-elapsed. Each startTrack consults
      // _tracksCursorSec to pick its starting item.
      _tracksPlaybackBaseSec    = _tracksCursorSec;
      _tracksPlaybackStartWallMs = performance.now();
      tracks.forEach((t, i) => {
        if (t.playing) return;
        if (t.items.length === 0) return;
        if (!shouldTrackPlay(t)) return;
        startTrack(i);
      });
      if (typeof _startPlayCursorAnim === 'function') _startPlayCursorAnim();
    }

    function renderTracks() {
      const container = document.getElementById('tracks-container');
      if (!container) return;
      container.innerHTML = '';

      const playAllBtn = document.getElementById('tracks-play-all');
      const anyPlaying = tracks.some(t => t.playing);
      if (playAllBtn) playAllBtn.textContent = anyPlaying ? '⏹' : '▶';

      if (tracks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'track-empty';
        empty.textContent = 'No tracks yet. Click "+ New" to start.';
        container.appendChild(empty);
        return;
      }

      tracks.forEach((track, trackIdx) => {
        const row = document.createElement('div');
        row.className = 'track-row';

        const mixOn = isTrackMixActive(track);
        const recOn = !!track._recording;
        const counting = !!track._countingIn;
        const recIcon = counting ? '…' : (recOn ? '⏹' : '●');
        const recCls  = counting ? ' counting' : (recOn ? ' recording' : '');
        const recTitle = counting
          ? 'Counting in… click to cancel'
          : recOn
            ? 'Stop recording'
            : 'Record from mic into this track. Other tracks play as monitoring while recording.';
        const controls = document.createElement('div');
        controls.className = 'track-controls';
        const isMono = track.stereo === false;
        const stereoLabel = isMono ? 'M' : 'S';
        const stereoTitle = isMono
          ? 'Mono track — output summed to mono. Click to switch to stereo.'
          : 'Stereo track. Click to switch to mono.';
        controls.innerHTML = `
          <span class="track-name${track.solo ? ' soloed' : ''}" title="Click to solo, double-click to rename">${track.name}</span>
          <button class="track-rec${recCls}" type="button" title="${recTitle}">${recIcon}</button>
          <button class="track-stereo${isMono ? ' mono' : ''}" type="button" title="${stereoTitle}">${stereoLabel}</button>
          <button class="track-eq${mixOn ? ' active' : ''}" type="button" title="Mix — EQ + Pan">Mix</button>
          <label class="track-multi-toggle" title="When on, clicking a sequence adds it to the selection instead of replacing it">
            <input type="checkbox" ${_tracksMultiSelect ? 'checked' : ''} />
            <span>Multi</span>
          </label>
          <button class="track-clear" type="button" title="Empty this track (keep the track, drop all of its items)">Clear</button>
          <button class="track-remove" title="Remove track">×</button>
        `;
        // Single click toggles solo; double click toggles twice (cancelling
        // out) and the dblclick handler below opens the rename dialog.
        controls.querySelector('.track-name').addEventListener('click', () => toggleTrackSolo(trackIdx));
        controls.querySelector('.track-rec').addEventListener('click', () => toggleTrackRecording(trackIdx));
        controls.querySelector('.track-stereo').addEventListener('click', () => toggleTrackStereo(trackIdx));
        controls.querySelector('.track-eq').addEventListener('click', () => showTrackEqDialog(trackIdx));
        controls.querySelector('.track-clear').addEventListener('click', () => {
          if ((track.items || []).length === 0) return;
          if (!confirm(`Empty ${track.name}? Removes every item in this track but keeps the track itself.`)) return;
          clearTrack(trackIdx);
        });
        controls.querySelector('.track-remove').addEventListener('click', () => {
          if (track.items.length === 0 || confirm(`Remove ${track.name}?`)) removeTrack(trackIdx);
        });
        // Multi-select toggle — global flag, but the checkbox lives on
        // every track row so it's visible no matter which row the user
        // is working from. Toggling any row's checkbox flips the flag
        // and re-syncs every other row's checkbox so the visual state
        // stays consistent.
        const multiCb = controls.querySelector('.track-multi-toggle input[type="checkbox"]');
        if (multiCb) {
          multiCb.addEventListener('change', () => {
            _tracksMultiSelect = !!multiCb.checked;
            _syncTracksMultiCheckboxes();
          });
        }
        const nameEl = controls.querySelector('.track-name');
        nameEl.addEventListener('dblclick', () => {
          const name = prompt('Rename track:', track.name);
          if (name && name.trim()) { track.name = name.trim(); persistTracks(); renderTracks(); }
        });
        row.appendChild(controls);

        const gridEl = document.createElement('div');
        gridEl.className = 'track-grid';
        gridEl.dataset.trackIdx = String(trackIdx);
        // Vertical drop indicator — anchored inside the track-grid and
        // moved by the dragover handlers to the snapped drop position.
        // Persists for the entire dragover lifecycle; the dragleave /
        // drop / dragend handlers hide it again.
        const dropIndicator = document.createElement('div');
        dropIndicator.className = 'track-drop-indicator';
        dropIndicator.hidden = true;
        gridEl.style.position = 'relative';
        gridEl.appendChild(dropIndicator);
        // Convert pointer-X within the grid into a target time in
        // seconds, then snap to any item boundary across every track
        // (the "soft-lock to sequence boundaries" behavior).
        const computeSnapSec = (clientX) => {
          const rect = gridEl.getBoundingClientRect();
          const padding = 4; // matches .track-grid CSS padding
          const x = (clientX - rect.left) - padding + gridEl.scrollLeft;
          const raw = Math.max(0, x / TRACK_PX_PER_SEC);
          return _snapSecToBoundary(raw, 12);
        };
        const positionIndicator = (snapSec) => {
          const padding = 4;
          const px = padding + snapSec * TRACK_PX_PER_SEC - gridEl.scrollLeft;
          dropIndicator.style.left = px + 'px';
          dropIndicator.hidden = false;
        };
        gridEl.addEventListener('dragover', (e) => {
          if (_dragIdx !== null) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            gridEl.classList.add('drag-over');
            return;
          }
          if (_dragTrackItem) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            gridEl.classList.add('drag-over');
            const sec = computeSnapSec(e.clientX);
            _dragSnapTimeSec = sec;
            positionIndicator(sec);
          }
        });
        gridEl.addEventListener('dragleave', (e) => {
          if (!gridEl.contains(e.relatedTarget)) {
            gridEl.classList.remove('drag-over');
            dropIndicator.hidden = true;
          }
        });
        gridEl.addEventListener('drop', (e) => {
          e.preventDefault();
          gridEl.classList.remove('drag-over');
          dropIndicator.hidden = true;
          if (_dragIdx !== null && savedSequences[_dragIdx]) {
            addSavedToTrack(trackIdx, savedSequences[_dragIdx]);
            _dragIdx = null;
            return;
          }
          if (_dragTrackItem) {
            const src  = _dragTrackItem;
            const sec  = (typeof _dragSnapTimeSec === 'number')
              ? _dragSnapTimeSec
              : computeSnapSec(e.clientX);
            _dragTrackItem  = null;
            _dragSnapTimeSec = null;
            _dropAtTimeInTrack(src.trackIdx, src.itemIdx, trackIdx, sec);
          }
        });
        // Click on the empty grid background (not on an item, not on
        // the drop indicator) → seek the playback head to that time.
        // Lets the user click "between" items along any track row.
        gridEl.addEventListener('click', (e) => {
          if (e.target !== gridEl) return;
          const rect = gridEl.getBoundingClientRect();
          const padding = 4;
          const x = (e.clientX - rect.left) - padding + gridEl.scrollLeft;
          const sec = Math.max(0, x / TRACK_PX_PER_SEC);
          seekTracksTo(sec);
        });
        if (track.items.length === 0) {
          const emptyItem = document.createElement('div');
          emptyItem.className = 'track-empty';
          emptyItem.textContent = 'Long-press a saved sequence to add it →';
          gridEl.appendChild(emptyItem);
        } else {
          // Precompute item time ranges once per track so we can tag
          // each block as in-loop / out-of-loop without recomputing
          // cumulative time for every item.
          const itemRanges = _trackItemTimeRanges(track);
          const loopEnd = (tracksLoopEndSec == null) ? Infinity : tracksLoopEndSec;
          track.items.forEach((item, itemIdx) => {
            const span = Math.max(1, itemStepCount(item));
            const isAudio  = item.type === 'audio';
            const isSilent = item.type === 'silent';
            const r = itemRanges[itemIdx] || { startSec: 0, endSec: 0 };
            // An item counts as "in loop" if any part of its time
            // range falls inside [loopStart, loopEnd]. Items that end
            // before loopStart or start at/after loopEnd are out.
            const inLoop = r.endSec > tracksLoopStartSec + 1e-6
                        && r.startSec < loopEnd - 1e-6;
            const block = document.createElement('div');
            const isSelected = _isTrackItemSelected(trackIdx, itemIdx);
            const isPrimary  = !!(_selectedTrackItem
              && _selectedTrackItem.trackIdx === trackIdx
              && _selectedTrackItem.itemIdx === itemIdx);
            block.className = 'track-item'
              + (isAudio  ? ' audio-item'  : '')
              + (isSilent ? ' silent-item' : '')
              + (track.playing && track.currentItemIdx === itemIdx ? ' active' : '')
              + (isSelected ? ' selected' : '')
              + (isPrimary  ? ' selected-primary' : '')
              + (inLoop ? ' in-loop' : ' out-of-loop');
            block.addEventListener('click', (e) => {
              e.stopPropagation();
              // Additive when the user holds ctrl/cmd/shift OR the
              // Mix-header Multi toggle is on — the toggle exists so
              // mobile users can multi-select without modifier keys.
              const additive = _tracksMultiSelect
                || e.ctrlKey || e.metaKey || e.shiftKey;
              const wasSelected = _isTrackItemSelected(trackIdx, itemIdx);
              const wasSole = wasSelected && _selectedTrackItems.size === 1;
              if (additive) {
                _toggleTrackItemInSelection(trackIdx, itemIdx);
              } else if (wasSole) {
                _clearTrackItemSelection();
              } else {
                _setSingleTrackItemSelection(trackIdx, itemIdx);
              }
              refreshTrackItemActionsVisibility();
              renderTracks();
              // After re-render, anchor the popover to the new primary
              // selection (or dismiss it if nothing is selected).
              if (_selectedTrackItems.size === 0) {
                dismissTrackItemPopover();
                return;
              }
              const primary = _selectedTrackItem || _trackItemSelectionList()[0];
              if (!primary) { dismissTrackItemPopover(); return; }
              const fresh = document.querySelector(
                `.track-grid[data-track-idx="${primary.trackIdx}"] [data-track-item-idx="${primary.itemIdx}"]`
              );
              if (fresh) showTrackItemEditPopover(primary.trackIdx, primary.itemIdx, fresh);
              else dismissTrackItemPopover();
            });
            block.dataset.trackItemIdx = String(itemIdx);
            block.style.gridColumn = `span ${span}`;
            const itemSeconds = (itemDurationMs(item) / 1000).toFixed(1);
            block.textContent = isSilent
              ? `— ${itemSeconds}s —`
              : (item.name || `#${itemIdx + 1}`) + (isAudio ? ` · ${(item.durationSec || 0).toFixed(1)}s` : '');
            const stepCount = (item.steps || []).length;
            block.title = isSilent
              ? `Silent gap · ${itemSeconds}s (left behind by a removed saved sequence)`
              : isAudio
                ? `${item.name} · audio · ${itemSeconds}s`
                : `${item.name} · ${stepCount} step${stepCount !== 1 ? 's' : ''} · ${itemSeconds}s @ ${item.bpm || 120} BPM`;
            const itemActions = () => {
              const acts = [];
              if (!isSilent) {
                acts.push({ label: 'Reverse', fn: () => reverseTrackItem(trackIdx, itemIdx) });
                acts.push({ label: 'Change speed…', fn: () => {
                  const raw = prompt('Speed change %  (positive = faster, negative = slower):', '10');
                  if (raw == null) return;
                  const v = parseFloat(raw);
                  if (!Number.isFinite(v)) { alert('Invalid number.'); return; }
                  changeTrackItemSpeed(trackIdx, itemIdx, v);
                } });
              }
              acts.push({ label: 'Remove from track', danger: true, fn: () => removeTrackItem(trackIdx, itemIdx) });
              return acts;
            };
            // Right-click and long-press both open an explicit menu so the
            // delete action is discoverable rather than a hidden gesture.
            block.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              showCtxMenu(e.clientX, e.clientY, itemActions());
            });
            let lpt = null;
            block.addEventListener('pointerdown', (e) => {
              lpt = setTimeout(() => {
                lpt = null;
                navigator.vibrate?.(40);
                showCtxMenu(e.clientX, e.clientY, itemActions());
              }, 500);
            });
            const cancelLp = () => { clearTimeout(lpt); lpt = null; };
            block.addEventListener('pointerup', cancelLp);
            block.addEventListener('pointercancel', cancelLp);
            block.addEventListener('pointermove', cancelLp);

            // HTML5 drag-and-drop: items reorder within a track and
            // move to another track. Silent placeholders aren't
            // draggable — they exist purely as time-aligned gaps for
            // sequences that were deleted upstream. The popover gets
            // dismissed at dragstart so the user doesn't drag with a
            // stale floating panel still pinned to the source position.
            if (!isSilent) {
              block.draggable = true;
              block.addEventListener('dragstart', (e) => {
                cancelLp();
                dismissTrackItemPopover();
                _dragTrackItem = { trackIdx, itemIdx };
                try { e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
                try { e.dataTransfer.setData('text/plain', `track-item:${trackIdx}:${itemIdx}`); } catch (err) {}
                block.classList.add('dragging');
              });
              block.addEventListener('dragend', () => {
                _dragTrackItem = null;
                _dragSnapTimeSec = null;
                document.querySelectorAll('.track-item.dragging, .track-item.drop-before, .track-item.drop-after')
                  .forEach(el => el.classList.remove('dragging', 'drop-before', 'drop-after'));
                document.querySelectorAll('.track-grid.drag-over')
                  .forEach(el => el.classList.remove('drag-over'));
                document.querySelectorAll('.track-drop-indicator')
                  .forEach(el => { el.hidden = true; });
              });
              // Per-item dragover/drop are intentionally absent now —
              // the grid-level handlers above compute a snapped drop
              // time across every track and call _dropAtTimeInTrack,
              // which figures out the destination index (or inserts a
              // silent gap when the drop lands past the current end).
              // The vertical drop indicator inside .track-grid shows
              // where the dropped item will land.
            }
            gridEl.appendChild(block);
          });
        }
        row.appendChild(gridEl);

        container.appendChild(row);
      });

      // Track controls live on their own row above each grid now, so
      // the grids are full-width and no horizontal padding sync between
      // track names is needed. Reset any min-width left behind by an
      // earlier render pass so the controls reflow naturally.
      container.querySelectorAll('.track-name').forEach(el => { el.style.minWidth = ''; });
      // Refresh the loop ruler so its width tracks the longest track
      // and the handles sit at the persisted start / end times.
      if (typeof renderTracksLoopRuler === 'function') {
        try { renderTracksLoopRuler(); } catch (e) {}
      }
    }
    // Position the loop ruler's fill + handles based on the current
    // tracksLoopStartSec / tracksLoopEndSec values. Width tracks the
    // longest track's natural width so the user can place handles
    // anywhere within the actual playable region. The ruler dims
    // when masterLoop is off so the user can see that the region is
    // currently visual-only.
    function renderTracksLoopRuler() {
      const ruler  = document.getElementById('tracks-loop-ruler');
      if (!ruler) return;
      const fill   = document.getElementById('tracks-loop-fill');
      const startH = document.getElementById('tracks-loop-handle-start');
      const endH   = document.getElementById('tracks-loop-handle-end');
      const maxSec = _maxTracksDurationSec();
      // Hide the ruler entirely when there's nothing to loop yet.
      if (maxSec <= 0 || tracks.length === 0) {
        ruler.style.display = 'none';
        return;
      }
      ruler.style.display = '';
      // Align the ruler with the first track grid. Done after layout
      // has settled by reading both bounding rects and shifting the
      // ruler's margin-left by the delta. Wrapped in requestAnimation
      // Frame because renderTracks is sometimes called while Mix is
      // still hidden (display:none on #mix-view) and rects measured
      // then are zero / clipped — RAF re-runs after the view is on-
      // screen so the alignment lands on the next paint.
      const alignToGrid = () => {
        const firstGrid = document.querySelector('#tracks-container .track-row .track-grid');
        if (!firstGrid) return;
        // Reset and force a sync reflow so the rect we read isn't biased
        // by any margin left from a prior alignment pass.
        ruler.style.marginLeft = '0px';
        // eslint-disable-next-line no-unused-expressions
        ruler.offsetWidth;
        const rulerRect = ruler.getBoundingClientRect();
        const gridRect  = firstGrid.getBoundingClientRect();
        if (rulerRect.width <= 0 || gridRect.width <= 0) return; // layout not ready yet
        const delta = gridRect.left - rulerRect.left;
        if (Number.isFinite(delta) && delta >= 0) {
          ruler.style.marginLeft = delta + 'px';
        }
      };
      alignToGrid();
      // Second pass next frame catches the "Mix just became visible"
      // case where the first call ran while #mix-view was still
      // display:none and the measurements were stale.
      requestAnimationFrame(alignToGrid);
      // Match the .track-grid's 4 px content padding so 0 s on the
      // ruler lines up with the first cell of every track grid below.
      // Without matching padding the ruler's tick at 0 sat ~2 px to
      // the right of where the first item actually starts.
      const pad = 4;
      // Ruler spans the visual extent of the longest track in cell
      // pixels. The linear `sec * TRACK_PX_PER_SEC` math drifts when
      // an item's duration doesn't divide evenly by TRACK_CELL_MS
      // (itemStepCount rounds), so use the cell-aligned right edge
      // instead — the ruler then ends exactly where the last item
      // ends visually.
      const maxVisualPx = _maxTracksVisualPx();
      const rulerW = Math.max(80, maxVisualPx + pad * 2);
      ruler.style.width = rulerW + 'px';
      // Pick a major-tick cadence that keeps the time grid readable
      // across short bars (every 1 s) and long tracks (every 30 s)
      // without crowding the labels.
      const majorSec =
          maxSec <= 8   ? 1
        : maxSec <= 24  ? 2
        : maxSec <= 60  ? 5
        : maxSec <= 240 ? 10
        :                 30;
      const minorSec = (majorSec >= 5) ? 1 : Math.max(0.5, majorSec / 4);
      ruler.style.setProperty('--ruler-pad',   pad + 'px');
      ruler.style.setProperty('--ruler-minor', (minorSec * TRACK_PX_PER_SEC) + 'px');
      ruler.style.setProperty('--ruler-major', (majorSec * TRACK_PX_PER_SEC) + 'px');
      // (Re)build the second-marker labels so the user can read where
      // each tick sits on the timeline.
      let labels = ruler.querySelector('.tracks-loop-labels');
      if (!labels) {
        labels = document.createElement('div');
        labels.className = 'tracks-loop-labels';
        ruler.insertBefore(labels, ruler.firstChild);
      }
      labels.innerHTML = '';
      for (let s = 0; s <= maxSec + 1e-6; s += majorSec) {
        const span = document.createElement('span');
        span.className = 'tracks-loop-label';
        span.textContent = (s % 1 === 0) ? `${s}s` : `${s.toFixed(1)}s`;
        // Labels live at cell-aligned LEFT edges (start of the second)
        // so they read as "this second begins here".
        span.style.left = (pad + _secToVisualPx(s, 'start')) + 'px';
        labels.appendChild(span);
      }
      const clampedStart = Math.max(0, Math.min(maxSec, tracksLoopStartSec));
      const explicitEnd  = (tracksLoopEndSec == null) ? maxSec : tracksLoopEndSec;
      const clampedEnd   = Math.max(clampedStart, Math.min(maxSec, explicitEnd));
      // Map each handle through the piecewise sec→cell-px helper so
      // the start handle lands at the LEFT edge of the cell starting
      // at clampedStart and the end handle lands at the RIGHT edge of
      // the cell ending at clampedEnd. Direct sec×PX_PER_SEC math
      // drifts when item spans don't divide evenly by TRACK_CELL_MS.
      const startPx = pad + _secToVisualPx(clampedStart, 'start');
      const endPx   = pad + _secToVisualPx(clampedEnd,   'end');
      if (fill) {
        fill.style.left  = startPx + 'px';
        fill.style.width = Math.max(0, endPx - startPx) + 'px';
      }
      if (startH) startH.style.left = startPx + 'px';
      if (endH)   endH.style.left   = endPx   + 'px';
      ruler.classList.toggle('disabled', !tracksMasterLoop);
      // Mark the body when the loop region is narrower than the full
      // timeline so out-of-loop items can dim. Includes the case where
      // the user has dragged the start past 0 OR the end inside maxSec.
      const fullSpan = clampedStart <= 1e-6 && clampedEnd >= maxSec - 1e-6;
      document.body.classList.toggle('loop-region-active', !fullSpan);
      // Refresh the play cursor's position — it shares the ruler's
      // pad + px-per-sec alignment, so any layout change here can
      // shift where the cursor should sit.
      if (typeof _updatePlayCursor === 'function') {
        try { _updatePlayCursor(); } catch (e) {}
      }
    }
    // Drag wiring for the two loop handles. Each handle owns one
    // boundary; drag updates the boundary in real time, soft-locking
    // to item edges across every track. Clamps so start can't pass
    // end (or vice versa) and so neither goes past the longest track.
    (function bindTracksLoopHandles() {
      const ruler  = document.getElementById('tracks-loop-ruler');
      const startH = document.getElementById('tracks-loop-handle-start');
      const endH   = document.getElementById('tracks-loop-handle-end');
      if (!ruler || !startH || !endH) return;
      // Same leading padding as renderTracksLoopRuler so click → time
      // math agrees with the handle render math. Matches .track-grid's
      // 4 px content padding so the ruler's 0 s lines up with item-0.
      const pad = 4;
      const beginDrag = (handle, which) => (e) => {
        e.preventDefault();
        const rect = ruler.getBoundingClientRect();
        const maxSec = _maxTracksDurationSec() || 0;
        handle.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
        const onMove = (ev) => {
          const x = (ev.clientX != null ? ev.clientX : 0) - rect.left - pad;
          let sec = Math.max(0, Math.min(maxSec, _visualPxToSec(x)));
          sec = _snapSecToBoundary(sec, 12);
          if (which === 'start') {
            const upper = (tracksLoopEndSec == null) ? maxSec : tracksLoopEndSec;
            tracksLoopStartSec = Math.max(0, Math.min(sec, upper));
          } else {
            tracksLoopEndSec = Math.max(tracksLoopStartSec, Math.min(sec, maxSec));
            // If the user drags the end all the way to maxSec, drop
            // it back to "null" so the ruler keeps tracking growth in
            // the longest track without needing a re-drag.
            if (tracksLoopEndSec >= maxSec - 1e-6) tracksLoopEndSec = null;
          }
          renderTracksLoopRuler();
        };
        const onUp = (ev) => {
          handle.classList.remove('dragging');
          try { handle.releasePointerCapture(ev.pointerId); } catch (err) {}
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          _persistTracksLoop();
          // Re-render tracks so in-loop / out-of-loop styling updates
          // to reflect the new boundary. Cheaper than re-rendering on
          // every pointermove during the drag.
          if (typeof renderTracks === 'function') renderTracks();
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      };
      startH.addEventListener('pointerdown', beginDrag(startH, 'start'));
      endH.addEventListener('pointerdown',   beginDrag(endH,   'end'));
      // Click anywhere ELSE on the ruler → seek the play head to that
      // time. Handles still own their drag pointerdowns above; this
      // handler short-circuits when the click lands on one of them so
      // a drag-start isn't accidentally treated as a seek.
      ruler.addEventListener('click', (e) => {
        if (e.target.classList && e.target.classList.contains('tracks-loop-handle')) return;
        const rect = ruler.getBoundingClientRect();
        const x    = (e.clientX != null ? e.clientX : 0) - rect.left - pad;
        const maxSec = _maxTracksDurationSec() || 0;
        const sec  = Math.max(0, Math.min(maxSec, _visualPxToSec(x)));
        seekTracksTo(sec);
      });
    })();

    // ---- Track-item selection + actions dropdown ----
    // _selectedTrackItems holds the full multi-selection as a Set of
    // "trackIdx:itemIdx" keys. _selectedTrackItem mirrors the most
    // recently-clicked entry so the legacy header dropdown + popover
    // anchor have a single "primary" target to bind against.
    //
    // Click without modifier replaces the selection. Click with
    // ctrl/cmd/shift toggles the clicked item in/out of the set. When
    // the set has >1 entry the edit popover applies its actions to
    // every selected item (and, via _propagateItemShape, every other
    // item across all tracks that shares a name with one of them).
    let _selectedTrackItem  = null; // { trackIdx, itemIdx } | null — primary
    const _selectedTrackItems = new Set(); // keys: "trackIdx:itemIdx"
    // Multi-select mode for the Mix tracks header — when on, clicking
    // a track item adds it to the selection instead of replacing it.
    // Gives mobile users (and anyone without ctrl/cmd/shift) the same
    // multi-select capability the modifier-keys already provide.
    let _tracksMultiSelect = false;
    const _selKey = (t, i) => `${t}:${i}`;
    function _isTrackItemSelected(trackIdx, itemIdx) {
      return _selectedTrackItems.has(_selKey(trackIdx, itemIdx));
    }
    function _trackItemSelectionList() {
      const out = [];
      _selectedTrackItems.forEach(k => {
        const [t, i] = k.split(':').map(n => parseInt(n, 10));
        if (Number.isFinite(t) && Number.isFinite(i)) out.push({ trackIdx: t, itemIdx: i });
      });
      return out;
    }
    function _clearTrackItemSelection() {
      _selectedTrackItems.clear();
      _selectedTrackItem = null;
    }
    function _setSingleTrackItemSelection(trackIdx, itemIdx) {
      _selectedTrackItems.clear();
      _selectedTrackItems.add(_selKey(trackIdx, itemIdx));
      _selectedTrackItem = { trackIdx, itemIdx };
    }
    function _toggleTrackItemInSelection(trackIdx, itemIdx) {
      const k = _selKey(trackIdx, itemIdx);
      if (_selectedTrackItems.has(k)) {
        _selectedTrackItems.delete(k);
        if (_selectedTrackItem
          && _selectedTrackItem.trackIdx === trackIdx
          && _selectedTrackItem.itemIdx === itemIdx) {
          // Promote the next remaining entry to "primary" so the
          // popover still has an anchor after toggling the primary off.
          const next = _trackItemSelectionList()[0];
          _selectedTrackItem = next || null;
        }
      } else {
        _selectedTrackItems.add(k);
        _selectedTrackItem = { trackIdx, itemIdx };
      }
    }
    // HTML5 drag-and-drop state for moving items between/within tracks.
    // Distinct from _dragIdx (which carries a savedSequences index into
    // a track grid for the "drag a saved sequence onto a track" flow).
    // Both dragover/drop handlers check both globals so neither system
    // gets clobbered.
    let _dragTrackItem = null; // { trackIdx, itemIdx } | null
    // Snapped target time set by the track-grid dragover handler so the
    // matching drop handler can hand it to _dropAtTimeInTrack. Cleared
    // on drop / dragend so a stale value can't leak into the next drag.
    let _dragSnapTimeSec = null;
    function refreshTrackItemActionsVisibility() {
      const btn = document.getElementById('tracks-item-actions-btn');
      if (!btn) return;
      btn.hidden = !_selectedTrackItem;
      // Surface the selected item's name on the button so the user
      // sees "MySeq ▾" instead of a generic "Item ▾". Falls back to
      // "Item" when the selection has no name (silent placeholders).
      if (_selectedTrackItem) {
        const item = tracks[_selectedTrackItem.trackIdx]?.items[_selectedTrackItem.itemIdx];
        const name = (item && (item.name || item.type)) || 'Item';
        btn.textContent = name + ' ▾';
      }
    }
    function selectTrackItem(trackIdx, itemIdx) {
      const wasSole = _isTrackItemSelected(trackIdx, itemIdx)
        && _selectedTrackItems.size === 1;
      if (wasSole) _clearTrackItemSelection();
      else _setSingleTrackItemSelection(trackIdx, itemIdx);
      refreshTrackItemActionsVisibility();
      renderTracks();
    }
    // Walk every track item and run `fn(item, trackIdx, itemIdx)` on
    // each one whose name matches the source item's. Used by the
    // "edit a sequence, all copies move together" semantics: a user
    // edits one iteration of a saved sequence and every other copy of
    // that same-named sequence (across every track) gets the same
    // edit. The source item is always included.
    function _forEachItemCopy(srcItem, fn) {
      if (!srcItem) return;
      const name = srcItem.name;
      tracks.forEach((t, ti) => {
        t.items.forEach((other, oi) => {
          // Untitled items (no name) are treated as singletons — only
          // the literal same object counts as a "copy" of itself.
          if (!name) { if (other === srcItem) fn(other, ti, oi); return; }
          if (other.name === name) fn(other, ti, oi);
        });
      });
    }
    // Live-update any currently-playing copy of `srcItem` so a volume
    // tweak (or any other gain-bearing edit) is heard immediately
    // instead of waiting for the next item iteration.
    function _hotPatchItemGainForCopies(srcItem) {
      const vol = Math.max(0, (Number.isFinite(srcItem?.volume) ? srcItem.volume : 100) / 100);
      _forEachItemCopy(srcItem, (it, ti, oi) => {
        const t = tracks[ti];
        if (!t || !t.playing || t.currentItemIdx !== oi || !t._itemGain) return;
        try { t._itemGain.gain.value = vol; } catch (e) {}
      });
    }
    function reverseTrackItem(trackIdx, itemIdx) {
      const item = tracks[trackIdx]?.items[itemIdx];
      if (!item) return;
      if (item.type === 'audio') return reverseAudioTrackItem(trackIdx, itemIdx);
      if (item.type === 'silent') return; // nothing to reverse
      maybeSnapshotForUndo('Reverse item');
      // Reverse step content on every copy. Each copy reverses its own
      // arrays in place (rather than cloning from a source) so that
      // copies whose shape drifted earlier still flip locally — the
      // important invariant is "all copies flip together", not "all
      // copies share the same final arrays".
      _forEachItemCopy(item, (copy) => {
        if (Array.isArray(copy.lanes)) {
          copy.lanes.forEach(l => { if (Array.isArray(l.steps)) l.steps.reverse(); });
        }
        if (Array.isArray(copy.steps)) copy.steps.reverse();
      });
      persistTracks();
      renderTracks();
    }
    function changeTrackItemSpeed(trackIdx, itemIdx, deltaPercent) {
      const item = tracks[trackIdx]?.items[itemIdx];
      if (!item) return;
      const factor = 1 + (Number(deltaPercent) / 100);
      if (!Number.isFinite(factor) || factor <= 0) return;
      maybeSnapshotForUndo('Change speed');
      // Apply the same speed factor to every copy. Audio copies share
      // the playbackRate compounding; step copies compound bpm; silent
      // copies compound durationSec. Each copy uses its own current
      // value so a copy that had been independently rebalanced still
      // tracks the new factor relative to its own state.
      _forEachItemCopy(item, (copy) => {
        if (copy.type === 'audio') {
          copy.playbackRate = (copy.playbackRate || 1) * factor;
          copy.durationSec  = (copy.durationSec  || 0) / factor;
        } else if (copy.type === 'silent') {
          copy.durationSec  = (copy.durationSec  || 0) / factor;
        } else {
          copy.bpm = Math.max(20, Math.min(999, Math.round((copy.bpm || 120) * factor)));
        }
      });
      persistTracks();
      renderTracks();
    }
    // Deep-clone an item (steps + lanes + globalFx + audio data URL).
    // Audio data URLs are strings so JSON round-trips them. The clone
    // inserts immediately after the source so the user sees the new
    // copy in the next slot.
    function duplicateTrackItem(trackIdx, itemIdx) {
      const track = tracks[trackIdx];
      if (!track || !track.items[itemIdx]) return;
      let copy;
      try { copy = JSON.parse(JSON.stringify(track.items[itemIdx])); }
      catch (e) { return; }
      maybeSnapshotForUndo('Duplicate item');
      track.items.splice(itemIdx + 1, 0, copy);
      persistTracks();
      renderTracks();
    }
    // Append-style duplicate — used by the multi-select Duplicate so a
    // batch of clones lands at the END of each item's track in the
    // user's selection order, instead of getting interleaved by the
    // "splice after source" behavior the single-item path uses.
    function _duplicateTrackItemAppend(trackIdx, itemIdx) {
      const track = tracks[trackIdx];
      if (!track || !track.items[itemIdx]) return;
      let copy;
      try { copy = JSON.parse(JSON.stringify(track.items[itemIdx])); }
      catch (e) { return; }
      maybeSnapshotForUndo('Duplicate item');
      track.items.push(copy);
      persistTracks();
      renderTracks();
    }
    // Reorder an item within the same track. `delta` is +1 (right) or
    // -1 (left); other values clamp to 0. Stops the track if the
    // currently-playing item is the one being moved — otherwise the
    // track.currentItemIdx pointer would point at a different item
    // mid-flight.
    function moveTrackItemBy(trackIdx, itemIdx, delta) {
      const track = tracks[trackIdx];
      if (!track) return;
      const newIdx = itemIdx + Math.sign(Number(delta) || 0);
      if (newIdx < 0 || newIdx >= track.items.length || newIdx === itemIdx) return;
      maybeSnapshotForUndo('Move item');
      if (track.playing) stopTrack(trackIdx);
      const [moved] = track.items.splice(itemIdx, 1);
      track.items.splice(newIdx, 0, moved);
      persistTracks();
      renderTracks();
    }
    // Move an item from one track to another. destItemIdx === null
    // appends to the end of the destination track. Stops both tracks
    // first so playback pointers don't dangle.
    // Drop a track item at an arbitrary time within the destination
    // track. If the drop sits past the destination's current end,
    // a silent placeholder fills the gap so playback time still
    // matches what the user sees. Otherwise the destination index is
    // computed from the drop time and existing items shift around it.
    // Wrapped in one undo batch so the gap-fill + the move collapse
    // into a single undoable step.
    function _dropAtTimeInTrack(srcTrackIdx, srcItemIdx, destTrackIdx, dropSec) {
      const src = tracks[srcTrackIdx];
      const dst = tracks[destTrackIdx];
      if (!src || !dst || !src.items[srcItemIdx]) return;
      const ranges = _trackItemTimeRanges(dst);
      const dstEndSec = ranges.length ? ranges[ranges.length - 1].endSec : 0;
      const sec = Math.max(0, Number(dropSec) || 0);
      beginUndoBatch('Move item');
      try {
        if (sec > dstEndSec + 1e-6) {
          const gapSec = sec - dstEndSec;
          // Skip the silent gap if it's tiny — the move alone is fine
          // and avoids ever-narrower placeholders building up after
          // repeated near-the-end drops.
          if (gapSec > 0.05) {
            dst.items.push({
              type: 'silent', name: '', durationSec: gapSec, steps: [],
            });
          }
          moveTrackItemToTrack(srcTrackIdx, srcItemIdx, destTrackIdx, null);
        } else {
          let insertAt = ranges.length;
          for (let i = 0; i < ranges.length; i++) {
            if (sec < ranges[i].startSec + 1e-6) { insertAt = i; break; }
            const mid = (ranges[i].startSec + ranges[i].endSec) / 2;
            if (sec < mid) { insertAt = i; break; }
          }
          moveTrackItemToTrack(srcTrackIdx, srcItemIdx, destTrackIdx, insertAt);
        }
      } finally { endUndoBatch(); }
    }
    function moveTrackItemToTrack(srcTrackIdx, srcItemIdx, destTrackIdx, destItemIdx) {
      const src = tracks[srcTrackIdx];
      const dst = tracks[destTrackIdx];
      if (!src || !dst || !src.items[srcItemIdx]) return;
      maybeSnapshotForUndo('Move to track');
      if (src === dst) {
        // Same-track move falls back to splice-shuffle so the user
        // can drag an item past its original index without manually
        // computing the off-by-one.
        if (src.playing) stopTrack(srcTrackIdx);
        const [moved] = src.items.splice(srcItemIdx, 1);
        const clamped = (destItemIdx == null)
          ? src.items.length
          : Math.max(0, Math.min(src.items.length, destItemIdx > srcItemIdx ? destItemIdx - 1 : destItemIdx));
        src.items.splice(clamped, 0, moved);
        persistTracks();
        renderTracks();
        return;
      }
      if (src.playing)  stopTrack(srcTrackIdx);
      if (dst.playing)  stopTrack(destTrackIdx);
      const [moved] = src.items.splice(srcItemIdx, 1);
      if (destItemIdx == null || destItemIdx >= dst.items.length) dst.items.push(moved);
      else dst.items.splice(Math.max(0, destItemIdx), 0, moved);
      persistTracks();
      renderTracks();
    }
    // Per-item volume write. Applies to every same-name copy across
    // every track ("edit a sequence, all copies move together"), and
    // hot-patches the live gain on any track currently playing one of
    // those copies so the change is heard immediately.
    function setTrackItemVolume(trackIdx, itemIdx, volume) {
      const item = tracks[trackIdx]?.items[itemIdx];
      if (!item) return;
      const v = Math.max(0, Math.min(200, Math.round(Number(volume) || 0)));
      // Volume drags are wrapped in a beginUndoBatch from the popover
      // slider pointerdown so the full drag becomes one undoable step.
      // Programmatic single calls (not in a batch) still snapshot.
      maybeSnapshotForUndo('Track volume');
      _forEachItemCopy(item, (copy) => { copy.volume = v; });
      _hotPatchItemGainForCopies(item);
      persistTracks();
    }
    function reverseAudioTrackItem(trackIdx, itemIdx) {
      const item = tracks[trackIdx]?.items[itemIdx];
      if (!item || !item.audioDataUrl) return;
      // Snapshot now (before the async decode/encode runs) so the
      // undo entry sits at the user's gesture rather than at whenever
      // the FileReader resolves.
      maybeSnapshotForUndo('Reverse audio');
      // Decode the existing data URL → reverse each channel's PCM
      // → re-encode as WAV → swap back into item.audioDataUrl. WAV
      // is the cheapest format to encode in JS (audioBufferToWav)
      // and works in every browser; the original codec (probably
      // webm/opus) doesn't survive the round trip but the audio
      // content is identical.
      (async () => {
        try {
          const resp = await fetch(item.audioDataUrl);
          const ab = await resp.arrayBuffer();
          const ctx = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext : new AudioContext();
          const decoded = await ctx.decodeAudioData(ab);
          for (let c = 0; c < decoded.numberOfChannels; c++) {
            const ch = decoded.getChannelData(c);
            // In-place reverse — Float32Array supports reverse() in
            // every modern engine.
            ch.reverse();
          }
          const wavBlob = audioBufferToWav(decoded);
          const reader = new FileReader();
          reader.onload = () => {
            // Reverse once, then share the reversed data URL across
            // every same-name copy. Doing the decode/encode work N
            // times for N copies would be wasteful and would also let
            // copies drift apart (different floating-point reverses).
            const newUrl = reader.result;
            _forEachItemCopy(item, (copy) => { copy.audioDataUrl = newUrl; });
            persistTracks();
            renderTracks();
          };
          reader.readAsDataURL(wavBlob);
        } catch (e) {
          console.warn('Audio reverse failed', e);
          alert('Could not reverse this audio: ' + (e.message || e));
        }
      })();
    }
    // ---- Per-item edit popover ----
    // Anchored under the clicked .track-item. One open at a time;
    // outside-click + Escape close it. Built fresh on every open so it
    // always reflects the current item state (including volume tweaks
    // saved from the previous open).
    let _trackItemPopover = null;
    function dismissTrackItemPopover() {
      if (!_trackItemPopover) return;
      try { _trackItemPopover.remove(); } catch (e) {}
      _trackItemPopover = null;
    }
    function _positionTrackItemPopover(pop, anchorRect) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const pw = pop.offsetWidth  || 260;
      const ph = pop.offsetHeight || 220;
      // Prefer placing below the anchor; flip above when there isn't
      // room. Horizontally clamp to viewport with 8 px padding.
      let top = anchorRect.bottom + 6;
      if (top + ph > vh - 8) top = Math.max(8, anchorRect.top - ph - 6);
      let left = anchorRect.left;
      if (left + pw > vw - 8) left = vw - pw - 8;
      if (left < 8) left = 8;
      pop.style.top  = top  + 'px';
      pop.style.left = left + 'px';
    }
    function showTrackItemEditPopover(trackIdx, itemIdx, anchorEl) {
      dismissTrackItemPopover();
      const track = tracks[trackIdx];
      const item  = track && track.items[itemIdx];
      if (!track || !item || !anchorEl) return;
      // Pull the full multi-selection (ctrl/cmd/shift-click adds items
      // to it). The popover's actions iterate over every selected item;
      // edit-actions (volume/reverse/speed) further propagate to all
      // same-name copies via the underlying mutators.
      let selection = _trackItemSelectionList()
        .map(s => ({ ...s, item: tracks[s.trackIdx]?.items[s.itemIdx] }))
        .filter(s => s.item);
      // Click handlers always include the primary (trackIdx/itemIdx)
      // even if the selection set is empty (edge case: popover opened
      // programmatically outside the click flow).
      if (selection.length === 0) selection = [{ trackIdx, itemIdx, item }];
      const multi = selection.length > 1;
      // Dedup by name for actions whose underlying mutator already
      // propagates by name (volume / reverse / speed). Calling them
      // once per unique name avoids double-applying a compound (e.g.,
      // speed factors squaring or reverses canceling).
      const uniqByName = () => {
        const seen = new Set();
        const out = [];
        selection.forEach(s => {
          const key = s.item && s.item.name ? `n:${s.item.name}` : `r:${s.trackIdx}:${s.itemIdx}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push(s);
        });
        return out;
      };
      const isAudio  = item.type === 'audio';
      const isSilent = item.type === 'silent';
      const anyNonSilent = selection.some(s => s.item.type !== 'silent');

      const pop = document.createElement('div');
      pop.className = 'track-item-popover';
      pop.addEventListener('pointerdown', (e) => e.stopPropagation());
      pop.addEventListener('click', (e) => e.stopPropagation());

      const primaryName = item.name || (isSilent ? 'Silent gap' : (isAudio ? 'Audio' : `Item ${itemIdx + 1}`));
      const headerText = multi
        ? `${selection.length} sequences selected`
        : primaryName;
      const head = document.createElement('div');
      head.className = 'tip-head';
      head.innerHTML = `<span class="tip-name" title="${headerText.replace(/"/g,'&quot;')}">${headerText}</span>`;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tip-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close';
      closeBtn.addEventListener('click', dismissTrackItemPopover);
      head.appendChild(closeBtn);
      pop.appendChild(head);

      // Subhead: tip about how multi-select works + a hint that edits
      // propagate to every same-name copy. Hidden in single-select to
      // keep the popover compact for the common case.
      if (multi) {
        const sub = document.createElement('div');
        sub.className = 'tip-sub';
        sub.textContent = 'Edits apply to all selected items (and every same-name copy across tracks).';
        pop.appendChild(sub);
      }

      // Volume slider — 0..200, where 100 is unity. Seed value is the
      // mean of every selected item's volume so the slider position
      // reflects the group state instead of one arbitrary member.
      const volRow = document.createElement('div');
      volRow.className = 'tip-row';
      const meanVol = (() => {
        const vals = selection.map(s => Number.isFinite(s.item.volume) ? s.item.volume : 100);
        return Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length));
      })();
      volRow.innerHTML = `
        <span class="tip-label">Volume</span>
        <input type="range" class="tip-vol" min="0" max="200" step="1" value="${meanVol}" />
        <span class="tip-val">${meanVol}%</span>
      `;
      const slider = volRow.querySelector('.tip-vol');
      const valEl  = volRow.querySelector('.tip-val');
      // Open one undo batch per drag — setTrackItemVolume fires many
      // times as the user drags, and we don't want one snapshot per
      // input event filling the history with noise.
      const beginVolBatch = () => beginUndoBatch(multi ? 'Track volume (multi)' : 'Track volume');
      const endVolBatch   = () => endUndoBatch();
      slider.addEventListener('pointerdown', beginVolBatch);
      slider.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
          || e.key === 'ArrowUp' || e.key === 'ArrowDown'
          || e.key === 'PageUp' || e.key === 'PageDown'
          || e.key === 'Home' || e.key === 'End') {
          beginVolBatch();
        }
      });
      slider.addEventListener('pointerup',   endVolBatch);
      slider.addEventListener('pointercancel', endVolBatch);
      slider.addEventListener('change',      endVolBatch);
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10);
        valEl.textContent = v + '%';
        uniqByName().forEach(s => setTrackItemVolume(s.trackIdx, s.itemIdx, v));
      });
      pop.appendChild(volRow);

      // Action row 1: Duplicate + Reverse
      const actRow1 = document.createElement('div');
      actRow1.className = 'tip-row';
      const dupBtn = document.createElement('button');
      dupBtn.type = 'button';
      dupBtn.className = 'tip-btn';
      dupBtn.textContent = multi ? `Duplicate ×${selection.length}` : 'Duplicate';
      dupBtn.addEventListener('click', () => {
        beginUndoBatch(multi ? `Duplicate ×${selection.length}` : 'Duplicate item');
        try {
          if (multi) {
            // Multi-select: append every clone to the end of its
            // track in the user's selection order. Set iteration
            // preserves insertion order so the click sequence drives
            // the final arrangement — "first clicked, first added"
            // at the tail of each track.
            selection.forEach(s => _duplicateTrackItemAppend(s.trackIdx, s.itemIdx));
          } else {
            // Single-select keeps the friendly "clone right next to
            // the source" behavior — less surprising for one click.
            duplicateTrackItem(trackIdx, itemIdx);
          }
        } finally { endUndoBatch(); }
        dismissTrackItemPopover();
        _clearTrackItemSelection();
        renderTracks();
      });
      actRow1.appendChild(dupBtn);
      if (anyNonSilent) {
        const revBtn = document.createElement('button');
        revBtn.type = 'button';
        revBtn.className = 'tip-btn';
        revBtn.textContent = 'Reverse';
        revBtn.addEventListener('click', () => {
          beginUndoBatch(multi ? 'Reverse (multi)' : 'Reverse item');
          try {
            uniqByName().forEach(s => {
              if (s.item.type !== 'silent') reverseTrackItem(s.trackIdx, s.itemIdx);
            });
          } finally { endUndoBatch(); }
          dismissTrackItemPopover();
        });
        actRow1.appendChild(revBtn);
      }
      pop.appendChild(actRow1);

      // Action row 2: Change speed (any non-silent)
      if (anyNonSilent) {
        const spdRow = document.createElement('div');
        spdRow.className = 'tip-row';
        const spdBtn = document.createElement('button');
        spdBtn.type = 'button';
        spdBtn.className = 'tip-btn';
        spdBtn.textContent = 'Change speed…';
        spdBtn.addEventListener('click', () => {
          const raw = prompt('Speed change %  (positive = faster, negative = slower):', '10');
          if (raw == null) return;
          const v = parseFloat(raw);
          if (!Number.isFinite(v)) { alert('Invalid number.'); return; }
          beginUndoBatch(multi ? 'Change speed (multi)' : 'Change speed');
          try {
            uniqByName().forEach(s => {
              if (s.item.type !== 'silent') changeTrackItemSpeed(s.trackIdx, s.itemIdx, v);
            });
          } finally { endUndoBatch(); }
          dismissTrackItemPopover();
        });
        spdRow.appendChild(spdBtn);
        pop.appendChild(spdRow);
      }

      // Reorder within track — single-select only. Ambiguous with a
      // multi-selection (which item moves first? to where?), so the
      // buttons hide rather than guess.
      if (!multi) {
        const moveRow = document.createElement('div');
        moveRow.className = 'tip-row';
        const leftBtn = document.createElement('button');
        leftBtn.type = 'button';
        leftBtn.className = 'tip-btn';
        leftBtn.textContent = '◀ Move left';
        leftBtn.disabled = itemIdx <= 0;
        leftBtn.addEventListener('click', () => {
          moveTrackItemBy(trackIdx, itemIdx, -1);
          dismissTrackItemPopover();
        });
        const rightBtn = document.createElement('button');
        rightBtn.type = 'button';
        rightBtn.className = 'tip-btn';
        rightBtn.textContent = 'Move right ▶';
        rightBtn.disabled = itemIdx >= track.items.length - 1;
        rightBtn.addEventListener('click', () => {
          moveTrackItemBy(trackIdx, itemIdx, +1);
          dismissTrackItemPopover();
        });
        moveRow.appendChild(leftBtn);
        moveRow.appendChild(rightBtn);
        pop.appendChild(moveRow);
      }

      // Move to other track — dropdown listing every track. In multi-
      // select, "every track that isn't the only source" is offered;
      // each selected item moves to the picked track in order, then
      // selection is cleared.
      const sourceTrackIdxs = new Set(selection.map(s => s.trackIdx));
      const candidateTracks = tracks
        .map((t, i) => ({ t, i }))
        .filter(x => {
          if (multi) return !(sourceTrackIdxs.size === 1 && sourceTrackIdxs.has(x.i));
          return x.i !== trackIdx;
        });
      if (candidateTracks.length > 0) {
        const destRow = document.createElement('div');
        destRow.className = 'tip-row';
        destRow.innerHTML = `<span class="tip-label">Move to</span>`;
        const sel = document.createElement('select');
        sel.className = 'tip-select';
        sel.innerHTML = `<option value="">— pick a track —</option>`
          + candidateTracks.map(({ t, i }) => `<option value="${i}">${t.name}</option>`).join('');
        sel.addEventListener('change', () => {
          const di = parseInt(sel.value, 10);
          if (!Number.isFinite(di)) return;
          // Walk source items in reverse-index order per source track
          // so removing earlier items doesn't shift indices of later
          // ones. Each item is appended to the destination track end.
          const grouped = new Map();
          selection.forEach(s => {
            if (!grouped.has(s.trackIdx)) grouped.set(s.trackIdx, []);
            grouped.get(s.trackIdx).push(s.itemIdx);
          });
          beginUndoBatch(multi ? 'Move to track (multi)' : 'Move to track');
          try {
            grouped.forEach((idxs, srcT) => {
              idxs.sort((a, b) => b - a).forEach(srcI => {
                moveTrackItemToTrack(srcT, srcI, di, null);
              });
            });
          } finally { endUndoBatch(); }
          _clearTrackItemSelection();
          dismissTrackItemPopover();
          renderTracks();
        });
        destRow.appendChild(sel);
        pop.appendChild(destRow);
      }

      // Danger zone: Remove
      const rmRow = document.createElement('div');
      rmRow.className = 'tip-row';
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'tip-btn danger';
      rmBtn.textContent = multi
        ? `Remove ${selection.length} items`
        : 'Remove from track';
      rmBtn.addEventListener('click', () => {
        // Same reverse-index strategy as Duplicate / Move to: per-
        // track, descending itemIdx so the splice doesn't invalidate
        // sibling indices mid-loop.
        const byTrack = new Map();
        selection.forEach(s => {
          if (!byTrack.has(s.trackIdx)) byTrack.set(s.trackIdx, []);
          byTrack.get(s.trackIdx).push(s.itemIdx);
        });
        beginUndoBatch(multi ? `Remove ×${selection.length}` : 'Remove item');
        try {
          byTrack.forEach((idxs, t) => {
            idxs.sort((a, b) => b - a).forEach(i => removeTrackItem(t, i));
          });
        } finally { endUndoBatch(); }
        _clearTrackItemSelection();
        dismissTrackItemPopover();
        renderTracks();
      });
      rmRow.appendChild(rmBtn);
      pop.appendChild(rmRow);

      document.body.appendChild(pop);
      _trackItemPopover = pop;
      _positionTrackItemPopover(pop, anchorEl.getBoundingClientRect());
    }
    // Dismiss the popover whenever the user pointerdowns outside it.
    // The popover's own pointerdown stopPropagation keeps inside clicks
    // from being treated as outside.
    document.addEventListener('pointerdown', (e) => {
      if (!_trackItemPopover) return;
      if (_trackItemPopover.contains(e.target)) return;
      if (e.target.closest('.track-item')) return; // clicking another item re-opens
      dismissTrackItemPopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _trackItemPopover) dismissTrackItemPopover();
    });
    // Reposition on resize so the popover doesn't end up off-screen
    // when a mobile rotation or window drag shifts the anchor.
    window.addEventListener('resize', () => {
      if (!_trackItemPopover || !_selectedTrackItem) return;
      // Re-anchor to the primary selection's DOM element (the most
      // recently clicked / only selected item). Other multi-selected
      // items also carry .selected, so we key on the [data-track-item-
      // idx] attribute to disambiguate.
      const { trackIdx, itemIdx } = _selectedTrackItem;
      const anchor = document.querySelector(
        `.track-grid[data-track-idx="${trackIdx}"] [data-track-item-idx="${itemIdx}"]`
      );
      if (anchor) _positionTrackItemPopover(_trackItemPopover, anchor.getBoundingClientRect());
    });

    document.getElementById('tracks-item-actions-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!_selectedTrackItem) return;
      const { trackIdx, itemIdx } = _selectedTrackItem;
      const item = tracks[trackIdx]?.items[itemIdx];
      if (!item) return;
      const actions = [
        { label: 'Reverse', fn: () => reverseTrackItem(trackIdx, itemIdx) },
        { label: 'Change speed…', fn: () => {
          const raw = prompt('Speed change %  (positive = faster, negative = slower):', '10');
          if (raw == null) return;
          const v = parseFloat(raw);
          if (!Number.isFinite(v)) { alert('Invalid number.'); return; }
          changeTrackItemSpeed(trackIdx, itemIdx, v);
        } },
      ];
      const r = e.currentTarget.getBoundingClientRect();
      showCtxMenu(r.left, r.bottom + 4, actions);
    });

    document.getElementById('add-track-btn').addEventListener('click', addTrack);
    // Zoom in / out buttons step through TRACKS_ZOOM_STEPS so each
    // click lands on a round percent (25 / 33 / 50 / 75 / 100 / 125
    // / 150 / 200 / 300 / 400). Clicking the percent label itself
    // resets to 100 %. Label updates inside setTracksZoom on every
    // change.
    (function initTracksZoomButtons() {
      const inBtn   = document.getElementById('tracks-zoom-in');
      const outBtn  = document.getElementById('tracks-zoom-out');
      const label   = document.getElementById('tracks-zoom-label');
      if (label) {
        label.textContent = Math.round(tracksZoom * 100) + '%';
        label.style.cursor = 'pointer';
        label.title = 'Click to reset zoom to 100 %';
        label.addEventListener('click', () => setTracksZoom(1));
      }
      if (inBtn)  inBtn.addEventListener('click',  () => setTracksZoom(_stepTracksZoom(+1)));
      if (outBtn) outBtn.addEventListener('click', () => setTracksZoom(_stepTracksZoom(-1)));
    })();
    document.getElementById('tracks-play-all').addEventListener('click', () => {
      if (tracks.some(t => t.playing)) stopAllTracks();
      else playAllTracks();
    });

    // Fullscreen Tracks view — hides every sibling so a phone held sideways
    // shows the whole grid edge-to-edge. Back button restores the layout.
    document.getElementById('tracks-title-btn').addEventListener('click', () => {
      document.body.classList.add('tracks-fullscreen');
      // Make sure tracks scroll into view at the top of the now-pinned section.
      document.querySelector('.tracks-section')?.scrollTo({ top: 0 });
    });
    document.getElementById('tracks-back-btn').addEventListener('click', () => {
      document.body.classList.remove('tracks-fullscreen');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('tracks-fullscreen')) {
        document.body.classList.remove('tracks-fullscreen');
      }
    });
    // Esc clears the insertion cursor — give the user a quick way to end an
    // ongoing "Insert before/after" session without clicking the cursor bar.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Don't fight a focused text/number input — let inputs handle Esc first.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (insertionPoint !== null) {
        insertionPoint = null;
        renderSequence();
      }
    });
    const tracksLoopBtn = document.getElementById('tracks-loop-all');
    tracksLoopBtn.addEventListener('click', () => {
      tracksMasterLoop = !tracksMasterLoop;
      tracksLoopBtn.classList.toggle('active', tracksMasterLoop);
      if (typeof renderTracksLoopRuler === 'function') {
        try { renderTracksLoopRuler(); } catch (e) {}
      }
      // Refresh track items so the in-loop highlight / out-of-loop
      // dim reflects the new Loop state. body.loop-region-active is
      // toggled inside renderTracksLoopRuler.
      if (typeof renderTracks === 'function') renderTracks();
    });

    // Count-in: when on, recording flows play 4 beats of metronome clicks
    // at the workspace tempo before the recorder + monitor playback start,
    // so the user has a clean reference for the downbeat.
    let countInEnabled = (() => {
      try { return JSON.parse(localStorage.getItem('sounds-countin') || 'false') === true; }
      catch (e) { return false; }
    })();
    const countInBtn = document.getElementById('tracks-countin-btn');
    if (countInBtn) {
      countInBtn.classList.toggle('active', countInEnabled);
      countInBtn.addEventListener('click', () => {
        countInEnabled = !countInEnabled;
        countInBtn.classList.toggle('active', countInEnabled);
        try { localStorage.setItem('sounds-countin', JSON.stringify(countInEnabled)); } catch (e) {}
      });
    }
    // The Multi checkbox lives on every track row's controls (see
    // renderTracks). All rows toggle the same _tracksMultiSelect flag
    // and stay visually in sync via _syncTracksMultiCheckboxes — that
    // way "Multi on" is obvious from any row the user happens to be
    // working in.
    function _syncTracksMultiCheckboxes() {
      document.querySelectorAll('.track-multi-toggle input[type="checkbox"]')
        .forEach(cb => { try { cb.checked = !!_tracksMultiSelect; } catch (e) {} });
    }
    function playCountIn() {
      const bpm = parseInt(tempoInput?.value, 10) || 120;
      const beatMs = 60000 / bpm;
      return new Promise(resolve => {
        for (let i = 0; i < 4; i++) {
          setTimeout(() => {
            const freq = (i === 0) ? 1318.5 : 880; // E6 downbeat, A5 inner beats
            try {
              playNote(freq, { type: 'triangle', attack: 4, decay: 60, sustain: 0, release: 80, volume: 70 }, 90);
            } catch (e) {}
          }, beatMs * i);
        }
        // Resolve at the end of the fourth beat so callers can start the
        // recorder + monitor tracks exactly on what would be beat 5.
        setTimeout(resolve, beatMs * 4);
      });
    }

    // ---- Export: render tracks offline to WAV and upload to Google Drive ----

    function audioBufferToWav(buffer) {
      const numCh = buffer.numberOfChannels;
      const sampleRate = buffer.sampleRate;
      const bytesPerSample = 2;
      const blockAlign = numCh * bytesPerSample;
      const samples = buffer.length;
      const dataLen = samples * blockAlign;
      const ab = new ArrayBuffer(44 + dataLen);
      const v = new DataView(ab);
      const ws = (o, s) => { for (let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
      ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
      ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
      v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * blockAlign, true);
      v.setUint16(32, blockAlign, true); v.setUint16(34, 16, true);
      ws(36, 'data'); v.setUint32(40, dataLen, true);
      let off = 44;
      const chans = [];
      for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
      for (let i = 0; i < samples; i++) {
        for (let c = 0; c < numCh; c++) {
          let s = Math.max(-1, Math.min(1, chans[c][i]));
          v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          off += 2;
        }
      }
      return new Blob([ab], { type: 'audio/wav' });
    }

    // Lazy-load lamejs (the only practical pure-JS MP3 encoder). The
    // CDN URL is pinned to a specific version so the build is
    // reproducible. Loading happens once per page; subsequent export
    // calls reuse the already-loaded global.
    async function loadLamejs() {
      if (typeof window !== 'undefined' && window.lamejs && window.lamejs.Mp3Encoder) return;
      await loadExternalScript('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
      if (typeof window === 'undefined' || !window.lamejs || !window.lamejs.Mp3Encoder) {
        throw new Error('lamejs failed to load');
      }
    }
    // Encode an AudioBuffer as a 192 kbps MP3 Blob. lamejs only does
    // 16-bit PCM input, so we Float32→Int16 first. Stereo buffers go
    // through the two-channel encoder; mono falls back to the single-
    // channel path. Uses 1152-sample frames (the canonical MP3 block
    // size) and flushes the encoder at the end so the final partial
    // frame isn't dropped.
    async function audioBufferToMp3(buffer) {
      await loadLamejs();
      const numCh = Math.max(1, Math.min(2, buffer.numberOfChannels));
      const sampleRate = buffer.sampleRate;
      const kbps = 192;
      const encoder = new window.lamejs.Mp3Encoder(numCh, sampleRate, kbps);
      const floatToInt16 = (f32) => {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const v = Math.max(-1, Math.min(1, f32[i]));
          out[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
        }
        return out;
      };
      const left  = floatToInt16(buffer.getChannelData(0));
      const right = numCh === 2 ? floatToInt16(buffer.getChannelData(1)) : null;
      const blockSize = 1152;
      const chunks = [];
      for (let i = 0; i < left.length; i += blockSize) {
        const lChunk = left.subarray(i, i + blockSize);
        const mp3buf = (numCh === 2)
          ? encoder.encodeBuffer(lChunk, right.subarray(i, i + blockSize))
          : encoder.encodeBuffer(lChunk);
        if (mp3buf.length > 0) chunks.push(new Uint8Array(mp3buf));
      }
      const tail = encoder.flush();
      if (tail.length > 0) chunks.push(new Uint8Array(tail));
      return new Blob(chunks, { type: 'audio/mpeg' });
    }

    // Estimate how long an effect tail keeps producing audible signal. Used
    // to size the offline-render buffer so reverb / delay tails don't get
    // chopped off the end of the export.
    //   • Reverb tail scales with Freeverb's roomSize. roomSize 0.7 ≈ 5s,
    //     0.99 ≈ 7s; tiny rooms decay almost immediately.
    //   • Delay tail repeats until amplitude * feedback^N drops below ~-60dB
    //     (0.001). Total tail = N × delayTime.
    function fxTailSec(reverb, reverbSize, delay, delayTime, delayFeedback) {
      let t = 0;
      if (reverb > 0) {
        const sizeFactor = Math.max(0, Math.min(1, reverbSize / 100));
        t = Math.max(t, 1 + sizeFactor * 6);
      }
      if (delay > 0 && delayFeedback > 0) {
        const f = Math.max(0.001, Math.min(0.95, delayFeedback / 100));
        const repeats = Math.ceil(Math.log(0.001) / Math.log(f));
        const delaySec = (delayTime || 0) / 1000;
        t = Math.max(t, repeats * delaySec);
      }
      return t;
    }
    function estimateExportTailSec() {
      // Start with the global FX tail.
      let tail = fxTailSec(
        globalFx.reverb, globalFx.reverbSize,
        globalFx.delay,  globalFx.delayTime, globalFx.delayFeedback
      );
      // Fold in the worst-case per-note FX tail across every step in every
      // track (chord voices, step params, and any nested subsequences).
      const visit = (step) => {
        if (!step) return;
        if (step.isSub && Array.isArray(step.subSteps)) { step.subSteps.forEach(visit); return; }
        const probe = (p) => {
          if (!p) return;
          tail = Math.max(tail, fxTailSec(
            p.reverb     || 0, p.reverbSize    ?? 70,
            p.delay      || 0, p.delayTime     ?? 250,
                                p.delayFeedback ?? 40
          ));
        };
        if (step.chord) step.chord.forEach(n => probe(n.params));
        else probe(step.params);
      };
      tracks.forEach(track => {
        (track.items || []).forEach(item => {
          if (item.type === 'audio' || item.type === 'silent') return;
          (item.steps || []).forEach(visit);
        });
      });
      // Add 2s on top for envelope release decays past the FX tail, and
      // clamp to a sane upper bound so a runaway feedback setting can't
      // produce a multi-minute buffer.
      return Math.min(60, Math.max(2, tail) + 2);
    }

    async function renderTracksToBuffer(opts = {}) {
      const durationsMs = tracks.map(track => {
        let ms = 0;
        (track.items || []).forEach(item => { ms += itemDurationMs(item); });
        return ms;
      });
      const totalMs = Math.max(...durationsMs, 1000);
      // Add an FX-aware trailing tail so reverb / delay decays render in
      // full (the previous fixed 3 s could chop long tails off the export).
      const tailSec = estimateExportTailSec();
      const totalSec = (totalMs / 1000) + tailSec;

      // Sample rate: caller can pass an explicit value (e.g., 22050 for a
      // faster smaller export). When omitted we mirror the live context
      // so playback speed/pitch match what the user hears in the browser.
      const sampleRate = (Number.isFinite(opts.sampleRate) && opts.sampleRate > 0)
        ? opts.sampleRate
        : ((Tone.getContext && Tone.getContext().sampleRate) || 44100);
      // Progress polling — Tone.Offline switches the global Tone
      // context to its OfflineContext for the duration of the render,
      // so Tone.getContext().rawContext.currentTime advances from 0
      // to totalSec as the audio buffer is filled. We sample that
      // every 120 ms and feed it back to opts.onProgress so the
      // caller's progress bar reflects forward motion. The interval
      // is paused once Tone.Offline's promise resolves.
      const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
      const onStatus   = (typeof opts.onStatus   === 'function') ? opts.onStatus   : null;
      const setStatus  = (label) => { if (onStatus) { try { onStatus(label); } catch (e) {} } };
      // Surface the duration up front so the user knows what they're
      // waiting on — long offline renders look identical to short ones
      // from outside.
      setStatus(`Preparing render (${totalSec.toFixed(1)} s total)…`);
      let progressTimer = null;
      let lastReportedSec = 0;
      const startWallMs = performance.now();
      if (onProgress) {
        // Fire an initial 0% tick so the bar paints before the heavy
        // render kicks in.
        try { onProgress(0, 0, totalSec); } catch (e) {}
        progressTimer = setInterval(() => {
          let sec = lastReportedSec;
          try {
            const ctx = (typeof Tone !== 'undefined' && Tone.getContext) ? Tone.getContext() : null;
            const raw = ctx && ctx.rawContext;
            if (raw && Number.isFinite(raw.currentTime)) sec = raw.currentTime;
          } catch (e) {}
          // Cap at totalSec - 0.01 so the bar doesn't peg at 100 %
          // before encoding starts; the caller pushes the final tick.
          if (sec > totalSec - 0.01) sec = totalSec - 0.01;
          if (sec < lastReportedSec) sec = lastReportedSec; // monotonic
          lastReportedSec = sec;
          const pct = totalSec > 0 ? sec / totalSec : 0;
          try { onProgress(pct, sec, totalSec); } catch (e) {}
        }, 120);
      }
      let offlineBuffer;
      try {
        offlineBuffer = await Tone.Offline(async () => {
        setStatus('Building FX chain…');
        const limiter = new Tone.Limiter(-1).toDestination();
        // Mirror the live global FX chain — every effect the user can
        // dial in on the FX panel needs an offline counterpart, otherwise
        // it silently drops out of the export. Previously only reverb /
        // delay / distortion rendered, leaving chorus, vibrato, tremolo,
        // phaser, autoFilter, pingPong, and autoPan absent from WAVs.
        // wetOf mirrors applyGlobalFx: *On === false forces wet to 0
        // without touching the stored mix value, so a bypassed effect
        // is transparent.
        const wetOf = (mix, on) => (on === false ? 0 : Math.max(0, Math.min(1, (mix || 0) / 100)));
        const offNodes = {};
        offNodes.reverb = new Tone.Freeverb({
          roomSize:  Math.max(0, Math.min(0.99, globalFx.reverbSize / 100)),
          dampening: 500 + Math.max(0, Math.min(100, globalFx.reverbTone)) * 95,
          wet:       wetOf(globalFx.reverb, globalFx.reverbOn),
        });
        offNodes.delay = new Tone.FeedbackDelay({
          delayTime: Math.max(0.001, (globalFx.delayTime || 0) / 1000),
          feedback:  Math.max(0, Math.min(0.95, globalFx.delayFeedback / 100)),
          wet:       wetOf(globalFx.delay, globalFx.delayOn),
        });
        offNodes.distortion = new Tone.Distortion({
          distortion: globalFx.distortionOn === false ? 0 : Math.max(0, Math.min(1, globalFx.distortion / 100)),
          wet: 1, oversample: '4x',
        });
        offNodes.chorus = new Tone.Chorus({
          frequency: Math.max(0.01, globalFx.chorusFreq),
          delayTime: 3.5,
          depth:     Math.max(0, Math.min(1, globalFx.chorusDepth / 100)),
          feedback:  0.1,
          wet:       wetOf(globalFx.chorus, globalFx.chorusOn),
        });
        offNodes.vibrato = new Tone.Vibrato({
          frequency: Math.max(0.01, globalFx.vibratoFreq),
          depth:     Math.max(0, Math.min(1, globalFx.vibratoDepth / 100)),
          wet:       wetOf(globalFx.vibrato, globalFx.vibratoOn),
        });
        offNodes.tremolo = new Tone.Tremolo({
          frequency: Math.max(0.01, globalFx.tremoloFreq),
          depth:     Math.max(0, Math.min(1, globalFx.tremoloDepth / 100)),
          wet:       wetOf(globalFx.tremolo, globalFx.tremoloOn),
        });
        offNodes.phaser = new Tone.Phaser({
          frequency:    Math.max(0.01, globalFx.phaserFreq),
          octaves:      Math.max(1, Math.min(7, globalFx.phaserOctaves)),
          baseFrequency: 350,
          wet:          wetOf(globalFx.phaser, globalFx.phaserOn),
        });
        offNodes.autoFilter = new Tone.AutoFilter({
          frequency:     Math.max(0.01, globalFx.autoFilterFreq),
          depth:         Math.max(0, Math.min(1, globalFx.autoFilterDepth / 100)),
          baseFrequency: Math.max(20, globalFx.autoFilterBaseFreq),
          octaves:       2.6,
          wet:           wetOf(globalFx.autoFilter, globalFx.autoFilterOn),
        });
        offNodes.pingPong = new Tone.PingPongDelay({
          delayTime: Math.max(0.001, (globalFx.pingPongTime || 0) / 1000),
          feedback:  Math.max(0, Math.min(0.95, globalFx.pingPongFeedback / 100)),
          wet:       wetOf(globalFx.pingPong, globalFx.pingPongOn),
        });
        offNodes.autoPan = new Tone.AutoPanner({
          frequency: Math.max(0.01, globalFx.autoPanFreq),
          depth:     Math.max(0, Math.min(1, globalFx.autoPanDepth / 100)),
          wet:       wetOf(globalFx.autoPan, globalFx.autoPanOn),
        });
        // LFO-driven effects need an explicit .start() to begin oscillating
        // — without this they stay frozen at phase 0 (audible as a static
        // notch instead of motion). Matches the live setup at master-FX
        // construction time.
        ['tremolo','chorus','autoFilter','autoPan'].forEach(k => {
          try { offNodes[k].start(); } catch (e) {}
        });
        // Wire forward in the user-configured order — same chain the live
        // path uses via rebuildMasterChain, so the export honours any FX
        // reordering the user has done in the FX panel.
        const order = (globalFx && Array.isArray(globalFx.fxOrder) && globalFx.fxOrder.length === FX_NAMES.length)
          ? globalFx.fxOrder
          : FX_NAMES;
        let head = limiter;
        for (let i = order.length - 1; i >= 0; i--) {
          const n = offNodes[order[i]];
          if (!n) continue;
          n.connect(head);
          head = n;
        }
        const bus = new Tone.Compressor({ threshold: -24, ratio: 4, attack: 0.003, release: 0.25, knee: 12 }).connect(head);

        // Per-item FX recall: live playback mutates the master FX state
        // when each item starts (playTrackItem copies item.globalFx onto
        // the live globalFx + calls applyGlobalFx). To match Mix in the
        // export, we schedule the same param writes on the offline FX
        // nodes at each item's start time. Only AudioParam-backed
        // properties (wet, frequency, depth, delayTime, feedback,
        // roomSize, dampening) honor setValueAtTime — the rest (Phaser
        // octaves, AutoFilter baseFrequency) stay at their construction
        // values and approximate the export with whatever the user had
        // dialed in at export time.
        const scheduleFxStateAt = (fx, atTime) => {
          if (!fx) return;
          const at = Math.max(0, Number(atTime) || 0);
          const writeAt = (param, value) => {
            if (!param || !Number.isFinite(value)) return;
            try {
              if (typeof param.setValueAtTime === 'function') param.setValueAtTime(value, at);
              else if ('value' in param) param.value = value;
            } catch (e) {}
          };
          const wetVal = (mix, on) => (on === false ? 0 : Math.max(0, Math.min(1, (mix || 0) / 100)));
          if (offNodes.reverb) {
            writeAt(offNodes.reverb.wet, wetVal(fx.reverb, fx.reverbOn));
            if (Number.isFinite(fx.reverbSize)) writeAt(offNodes.reverb.roomSize, Math.max(0, Math.min(0.99, fx.reverbSize / 100)));
            if (Number.isFinite(fx.reverbTone)) writeAt(offNodes.reverb.dampening, 500 + Math.max(0, Math.min(100, fx.reverbTone)) * 95);
          }
          if (offNodes.delay) {
            writeAt(offNodes.delay.wet, wetVal(fx.delay, fx.delayOn));
            if (Number.isFinite(fx.delayTime))     writeAt(offNodes.delay.delayTime, Math.max(0.001, (fx.delayTime || 0) / 1000));
            if (Number.isFinite(fx.delayFeedback)) writeAt(offNodes.delay.feedback,  Math.max(0, Math.min(0.95, fx.delayFeedback / 100)));
          }
          if (offNodes.distortion) {
            writeAt(offNodes.distortion.wet, fx.distortionOn === false ? 0 : Math.max(0, Math.min(1, (fx.distortion || 0) / 100)));
          }
          if (offNodes.chorus) {
            writeAt(offNodes.chorus.wet, wetVal(fx.chorus, fx.chorusOn));
            if (Number.isFinite(fx.chorusFreq))  writeAt(offNodes.chorus.frequency, Math.max(0.01, fx.chorusFreq));
            if (Number.isFinite(fx.chorusDepth)) writeAt(offNodes.chorus.depth,     Math.max(0, Math.min(1, fx.chorusDepth / 100)));
          }
          if (offNodes.vibrato) {
            writeAt(offNodes.vibrato.wet, wetVal(fx.vibrato, fx.vibratoOn));
            if (Number.isFinite(fx.vibratoFreq))  writeAt(offNodes.vibrato.frequency, Math.max(0.01, fx.vibratoFreq));
            if (Number.isFinite(fx.vibratoDepth)) writeAt(offNodes.vibrato.depth,     Math.max(0, Math.min(1, fx.vibratoDepth / 100)));
          }
          if (offNodes.tremolo) {
            writeAt(offNodes.tremolo.wet, wetVal(fx.tremolo, fx.tremoloOn));
            if (Number.isFinite(fx.tremoloFreq))  writeAt(offNodes.tremolo.frequency, Math.max(0.01, fx.tremoloFreq));
            if (Number.isFinite(fx.tremoloDepth)) writeAt(offNodes.tremolo.depth,     Math.max(0, Math.min(1, fx.tremoloDepth / 100)));
          }
          if (offNodes.phaser) {
            writeAt(offNodes.phaser.wet, wetVal(fx.phaser, fx.phaserOn));
            if (Number.isFinite(fx.phaserFreq)) writeAt(offNodes.phaser.frequency, Math.max(0.01, fx.phaserFreq));
          }
          if (offNodes.autoFilter) {
            writeAt(offNodes.autoFilter.wet, wetVal(fx.autoFilter, fx.autoFilterOn));
            if (Number.isFinite(fx.autoFilterFreq))  writeAt(offNodes.autoFilter.frequency, Math.max(0.01, fx.autoFilterFreq));
            if (Number.isFinite(fx.autoFilterDepth)) writeAt(offNodes.autoFilter.depth,     Math.max(0, Math.min(1, fx.autoFilterDepth / 100)));
          }
          if (offNodes.pingPong) {
            writeAt(offNodes.pingPong.wet, wetVal(fx.pingPong, fx.pingPongOn));
            if (Number.isFinite(fx.pingPongTime))     writeAt(offNodes.pingPong.delayTime, Math.max(0.001, (fx.pingPongTime || 0) / 1000));
            if (Number.isFinite(fx.pingPongFeedback)) writeAt(offNodes.pingPong.feedback,  Math.max(0, Math.min(0.95, fx.pingPongFeedback / 100)));
          }
          if (offNodes.autoPan) {
            writeAt(offNodes.autoPan.wet, wetVal(fx.autoPan, fx.autoPanOn));
            if (Number.isFinite(fx.autoPanFreq))  writeAt(offNodes.autoPan.frequency, Math.max(0.01, fx.autoPanFreq));
            if (Number.isFinite(fx.autoPanDepth)) writeAt(offNodes.autoPan.depth,     Math.max(0, Math.min(1, fx.autoPanDepth / 100)));
          }
        };

        // Rebuild every registered sampler inside the offline context — the
        // live samplers are bound to the live AudioContext, so triggering
        // them in here would render to the live destination, not the offline
        // buffer (which is why sample-based notes vanished from exports).
        // Wait for them to load before scheduling notes so .loaded checks
        // pass at trigger time.
        setStatus('Building offline samplers…');
        const offlineSamplerMap = new Map();
        let samplerCount = 0;
        sampleSamplers.forEach((info, id) => {
          if (!info.urls) return;
          try {
            const samp = new Tone.Sampler({
              urls: info.urls,
              baseUrl: info.baseUrl,
              release: 1,
            }).connect(bus);
            offlineSamplerMap.set(id, samp);
            samplerCount++;
          } catch (e) {
            console.warn('Failed to recreate sampler in offline render', id, e);
          }
        });
        // Block until the offline samplers have decoded their buffers so
        // that .loaded is true at schedule time. Audio-item Tone.Player
        // loads also drain through this same await.
        if (samplerCount > 0) {
          setStatus(`Decoding ${samplerCount} sample bank${samplerCount === 1 ? '' : 's'}…`);
        }
        await Tone.loaded();
        _offlineSamplerOverride = offlineSamplerMap;
        // Strong-ref park for synth wrappers playNote creates during
        // this render. See the offline-mode early-return in playNote.
        _offlineVoiceRefs = [];

        setStatus('Scheduling tracks…');
        const players = [];
        try {
        tracks.forEach(track => {
          // Mirror the live per-track EQ + Pan in the offline render so the
          // exported WAV matches what the user hears in the browser.
          const teq = track.eq || { low: 0, mid: 0, high: 0 };
          const tpan = Math.max(-1, Math.min(1, Number.isFinite(track.pan) ? track.pan : 0));
          const trackPanner = new Tone.Panner(tpan).connect(bus);
          const trackBus = new Tone.EQ3({
            low:  teq.low  || 0,
            mid:  teq.mid  || 0,
            high: teq.high || 0,
          }).connect(trackPanner);
          let time = 0;
          (track.items || []).forEach(item => {
            // Per-item Gain mirrors the live playback path so the user's
            // per-item volume slider renders into the WAV. Built fresh
            // per item; Tone.Offline tears every node down when the
            // render completes, so no explicit dispose needed.
            const itemGainVal = Math.max(0, (Number.isFinite(item.volume) ? item.volume : 100) / 100);
            const itemGainNode = new Tone.Gain(itemGainVal).connect(trackBus);
            // Per-item FX recall — schedule the item's saved FX state on
            // the offline FX chain at the item's start time. Live
            // playback does the equivalent by mutating globalFx +
            // applyGlobalFx at each playTrackItem call.
            if (item && item.globalFx) {
              try { scheduleFxStateAt(item.globalFx, time); } catch (e) {}
            }
            if (item.type === 'audio') {
              const rate = Number.isFinite(item.playbackRate) && item.playbackRate > 0
                ? item.playbackRate : 1;
              const player = new Tone.Player({ url: item.audioDataUrl, playbackRate: rate })
                .connect(itemGainNode);
              players.push({ player, startTime: time });
              time += (item.durationSec || 0);
              return;
            }
            if (item.type === 'silent') {
              time += (item.durationSec || 0);
              return;
            }
            const itemBpm = item.bpm || 120;
            const itemSub = item.subdivision || 1;
            // Total seconds for one pass through a lane's flat steps —
            // used both by the loop bound and to pick the item's
            // overall duration (longest lane). Pure math, no audio.
            const laneOnePassSec = (steps) => {
              let s = 0;
              flattenItemSteps(steps).forEach(step => {
                const stepSub = (step.subdivision != null) ? step.subdivision : itemSub;
                const stepMs = Math.round(60000 / itemBpm * stepSub);
                s += (stepMs * (step.duration || 1)) / 1000;
              });
              return s;
            };
            // Schedule a lane's flat-step list, looping back to the
            // start until cumulative time reaches `targetSec`. This
            // matches Bloops poly playback where every lane loops
            // independently — shorter lanes wrap to fill the same
            // window the longest lane occupies. Without this, a 4-
            // step lane finished 2 s in while an 8-step lane was
            // still going, leaving the rest of the item silent on
            // that lane.
            const scheduleLane = (steps, baseTime, targetSec, dest) => {
              const flat = flattenItemSteps(steps);
              if (flat.length === 0) return 0;
              const onePass = laneOnePassSec(steps);
              if (onePass <= 0) return 0;
              const safeTarget = Math.max(targetSec, onePass);
              let t = baseTime;
              const endTime = baseTime + safeTarget;
              // Hard cap at 1024 step fires to guard against pathological
              // float math (e.g. onePass == 0 due to weird step data).
              let safety = 0;
              while (t < endTime && safety < 1024) {
                for (let i = 0; i < flat.length; i++) {
                  if (t >= endTime) break;
                  if (++safety > 1024) break;
                  const step = flat[i];
                  const stepSub = (step.subdivision != null) ? step.subdivision : itemSub;
                  const stepMs = Math.round(60000 / itemBpm * stepSub);
                  const durMs  = stepMs * (step.duration || 1);
                  const durSec = durMs / 1000;
                  if (step.isFluid && Array.isArray(step.samples)) {
                    // Fluid XY gesture — schedule as a single voice that
                    // ramps through every sample, into the lane bus so
                    // per-lane FX / pan / volume render in the WAV.
                    _playFluidStep(step, t, dest);
                  } else if (step.chord) {
                    const size = step.chord.length;
                    step.chord.forEach(n => playNote(n.freq, paramsWithBend(chordVoiceParams(n.params || n.sound || 'sine', size, step), step.bend), durMs, t, dest));
                  } else if (step.freq !== null && step.freq !== undefined) {
                    playNote(step.freq, paramsWithBend(step.params || step.sound || 'sine', step.bend), durMs, t, dest);
                  }
                  t += durSec;
                }
              }
              return t - baseTime;
            };
            // Multi-lane items: each playable lane gets its own per-
            // lane bus (volume + panner + FX chain driven by the lane's
            // saved sends), routed into trackBus. Matches the live
            // playback fan-out so the WAV/MP3 sounds like Make/Mix —
            // per-lane FX, per-lane pan, per-lane volume all preserved.
            // The buses are scoped to the offline context and torn down
            // automatically when Tone.Offline disposes its context at
            // the end of the render.
            if (Array.isArray(item.lanes) && item.lanes.length > 0) {
              const anySolo = item.lanes.some(l => l && l.solo);
              const playableLanes = item.lanes.filter(l => l
                && Array.isArray(l.steps) && l.steps.length > 0
                && (anySolo ? !!l.solo : !l.muted));
              if (playableLanes.length > 0) {
                const longestSec = Math.max(...playableLanes.map(l => laneOnePassSec(l.steps)));
                playableLanes.forEach(lane => {
                  // Pass the item's saved globalFx into the lane-bus
                  // builder so per-lane FX shape (room size, delay
                  // time, depth, etc.) matches what the user heard
                  // when they saved the sequence — not whatever the
                  // live globalFx happens to be at export time.
                  const laneBus = (typeof _buildItemLaneBus === 'function')
                    ? _buildItemLaneBus(lane, itemGainNode, item.globalFx)
                    : null;
                  const laneDest = (laneBus && laneBus.head) || itemGainNode;
                  scheduleLane(lane.steps, time, longestSec, laneDest);
                });
                time += longestSec;
                return;
              }
            }
            // Legacy single-stream item: no lanes array, fall back to
            // a single pass through item.steps (one iteration, no
            // looping) — matches the pre-multi-lane behavior.
            const used = scheduleLane(item.steps, time, laneOnePassSec(item.steps), itemGainNode);
            time += used;
          });
        });
        // Wait for any audio-item Tone.Player buffers to decode (offline
        // samplers were already awaited above) before scheduling starts.
        if (players.length > 0) {
          setStatus(`Decoding ${players.length} audio clip${players.length === 1 ? '' : 's'}…`);
          await Tone.loaded();
        }
        players.forEach(({ player, startTime }) => {
          try { player.start(startTime); } catch (e) {}
        });
        // Last setup step — once the callback returns, Tone.Offline
        // kicks off the actual offline render. The cursor poll below
        // will start reflecting real progress on the bar.
        setStatus(`Rendering audio (${totalSec.toFixed(1)} s)…`);
        } finally {
          // Drop the override regardless of whether scheduling threw —
          // otherwise live playback after a failed export would keep
          // resolving to disposed offline samplers. Voice refs stay
          // pinned through the actual render (which Tone.Offline
          // performs after this callback returns) — they get
          // released after the render completes via the outer cleanup
          // below.
          _offlineSamplerOverride = null;
        }
      }, totalSec, 2, sampleRate);
      } finally {
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      }
      // Final progress tick so the bar visually reaches 100 % before
      // the caller switches the modal over to "Encoding…" / "Uploading…".
      if (onProgress) {
        try { onProgress(1, totalSec, totalSec); } catch (e) {}
      }
      setStatus('Render complete — finalizing buffer…');
      // Drop the strong synth refs now that the offline render has
      // produced its buffer. Holding them until after the render
      // ensures Tone.js' scheduled events stayed wired up; releasing
      // them now lets GC reclaim the wrappers.
      _offlineVoiceRefs = null;
      // Peak-check the rendered buffer so we can tell whether the
      // offline render produced audio. Logs a max-amplitude reading
      // and the first / last frames where audio is non-zero.
      try {
        const raw = (offlineBuffer && offlineBuffer.get) ? offlineBuffer.get() : offlineBuffer;
        const ch0 = raw && raw.getChannelData ? raw.getChannelData(0) : null;
        if (ch0 && ch0.length) {
          let peak = 0, firstNonZero = -1, lastNonZero = -1;
          for (let i = 0; i < ch0.length; i++) {
            const v = Math.abs(ch0[i]);
            if (v > peak) peak = v;
            if (v > 0.001) {
              if (firstNonZero < 0) firstNonZero = i;
              lastNonZero = i;
            }
          }
          const sr = raw.sampleRate || sampleRate;
          console.log('[export] buffer length=', ch0.length,
            'duration=', (ch0.length / sr).toFixed(3), 's',
            'peak=', peak.toFixed(4),
            'first audio at', firstNonZero >= 0 ? (firstNonZero / sr).toFixed(3) + 's' : 'NEVER',
            'last audio at',  lastNonZero  >= 0 ? (lastNonZero  / sr).toFixed(3) + 's' : 'NEVER');
        } else {
          console.warn('[export] could not inspect buffer channel 0');
        }
      } catch (e) {
        console.warn('[export] peak-check failed', e);
      }
      return offlineBuffer;
    }

    // Google Drive auth + upload (lazy-loads gapi/GIS via <script> on demand)
    // Hydrate from SharedAuth on boot so a token minted on player.html (or
    // a prior bloops session within the hour) is reused without re-prompt.
    let googleAccessToken = window.SharedAuth?.load?.()?.token || null;
    let googleTokenClient = null;
    // When we hydrate a token, gapi.client hasn't been initialized yet
    // (the sign-in flow normally handles that). Kick off an eager bootstrap
    // so Bloops's own Drive calls have a ready client and the cached
    // bearer attached. The function is defined below; reference is hoisted
    // via the `function` declaration so this top-level call is safe.
    if (googleAccessToken) {
      (async () => {
        try {
          await loadExternalScript('https://apis.google.com/js/api.js');
          await loadExternalScript('https://accounts.google.com/gsi/client');
          if (!gapi.client) await new Promise(res => gapi.load('client', res));
          if (!gapi.client.drive) {
            await gapi.client.init({
              apiKey: window.APP_CONFIG.apiKey,
              discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
            });
          }
          gapi.client.setToken({ access_token: googleAccessToken });
        } catch (e) {
          // gapi/GIS loading hiccup — but the cached token may still be
          // valid for use on other pages. Don't clear SharedAuth here; a
          // 401 response from a Drive call is the only authoritative
          // signal that the token is actually dead. Clearing on any load
          // error caused player → bloops → player to wipe the token and
          // re-prompt the user on the return trip.
          console.warn('Cross-page gapi bootstrap failed (keeping cached token):', e);
        }
      })();
    }

    function loadExternalScript(src) {
      return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
      });
    }

    // Combined scopes — drive.file lets Bloops create + read its own
    // project / asset files; drive.readonly + documents.readonly let
    // Serialbox read user-uploaded music folders, the bloops/playlists
    // file, and the optional "Artist name" Google Doc. One sign-in
    // covers both views.
    const BLOOPS_OAUTH_SCOPE = [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
    ].join(' ');

    async function googleSignInForDrive() {
      if (!window.APP_CONFIG || !window.APP_CONFIG.clientId || !window.APP_CONFIG.apiKey) {
        throw new Error('Missing Google API config (js/config.js).');
      }
      await loadExternalScript('https://apis.google.com/js/api.js');
      await loadExternalScript('https://accounts.google.com/gsi/client');
      if (!gapi.client) await new Promise(res => gapi.load('client', res));
      if (!gapi.client.drive) {
        await gapi.client.init({
          apiKey: window.APP_CONFIG.apiKey,
          discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
        });
      }
      // Re-validate against SharedAuth, which enforces expiry (60s buffer).
      // The in-process googleAccessToken is never cleared on its own, so after
      // ~1h it's a dead string — reusing it 401s every Drive call. Adopt the
      // still-valid cached token, or drop ours so we mint a fresh one below.
      try {
        const stored = window.SharedAuth?.load?.();
        googleAccessToken = (stored && stored.token) ? stored.token : null;
      } catch (e) { /* keep whatever we have */ }
      if (googleAccessToken) {
        gapi.client.setToken({ access_token: googleAccessToken });
        return googleAccessToken;
      }
      return new Promise((resolve, reject) => {
        googleTokenClient = google.accounts.oauth2.initTokenClient({
          client_id: window.APP_CONFIG.clientId,
          scope: BLOOPS_OAUTH_SCOPE,
          callback: async (resp) => {
            if (resp.error) return reject(new Error(resp.error));
            googleAccessToken = resp.access_token;
            window.SharedAuth?.save?.(resp.access_token, resp.expires_in);
            gapi.client.setToken({ access_token: googleAccessToken });
            // Run the structure init BEFORE dispatching authStatusChanged.
            // Otherwise the Player's listener races us — it would call
            // fetchPlaylistOptions("bloops/playlists") while the confirm
            // dialog is still showing and bail with "Folder bloops not
            // found" before we've had a chance to create anything.
            try { await ensureBloopsStructure(); }
            catch (e) { console.warn('Bloops init failed:', e); }
            try { document.dispatchEvent(new CustomEvent('authStatusChanged', { detail: { isSignedIn: true } })); } catch (e) {}
            resolve(googleAccessToken);
          },
        });
        googleTokenClient.requestAccessToken();
      });
    }

    // Single auth surface that any module on the page can use. Serialbox's
    // GoogleDriveAPI checks for window.bloopsAuth and routes through it,
    // so signing in once on either tab covers both.
    window.bloopsAuth = {
      signIn: () => googleSignInForDrive(),
      getToken: () => googleAccessToken,
      isSignedIn: () => !!googleAccessToken,
    };

