    // ---- Playback ----

    // Universal cell-flash. Finds the grid cell whose pitch matches
    // `freq` (within 50 cents — covers detune offsets without bleeding
    // into the next semitone) and flashes its highlight at the audio
    // time the note actually starts, for roughly the note's duration.
    // Used by every interactive note path (sequence playback, run /
    // chord previews, lock-mode audition, sustained taps) so the grid
    // stays a live indicator of what's sounding.
    // Closest grid cell to a freq, within 50 cents. Returns -1 when no
    // grid cell is within range (e.g., the note is transposed past the
    // grid's octave window). Shared by playback's freq-fallback and
    // flashCellByFreq below.
    function _findCellIdxForFreq(freq) {
      if (!Number.isFinite(freq) || !cells || cells.length === 0) return -1;
      let bestIdx = -1, bestDiff = Infinity;
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (!n || !Number.isFinite(n.freq)) continue;
        const cents = Math.abs(1200 * Math.log2(freq / n.freq));
        if (cents < bestDiff) { bestDiff = cents; bestIdx = i; }
      }
      return (bestIdx >= 0 && bestDiff <= 50) ? bestIdx : -1;
    }
    function flashCellByFreq(freq, audioTime, durationMs) {
      if (!Number.isFinite(freq) || !cells || cells.length === 0) return;
      const bestIdx = _findCellIdxForFreq(freq);
      if (bestIdx < 0) return;
      const cell = cells[bestIdx];
      if (!cell) return;
      const dur = Math.max(80, durationMs || 250);
      const at = (typeof audioTime === 'number' && Number.isFinite(audioTime)) ? audioTime : null;
      scheduleVisual(() => {
        cell.classList.add('active-loop');
        setTimeout(() => cell.classList.remove('active-loop'), dur);
      }, at);
    }

    function clearHighlights() {
      cells.forEach(c => c.classList.remove('active-loop'));
      document.querySelectorAll('.rest-bar').forEach(b => b.classList.remove('active-loop'));
    }

    // Tone.js schedules audio in the future by `Tone.context.lookAhead`
    // seconds (default ~0.1s) so the audio thread has lead-time to render
    // without underruns. Visuals run instantly on the JS thread, which
    // makes them appear ~lookAhead ahead of the audio. We delay every
    // highlight update by that same lookAhead so the chip + cell flash
    // line up with the moment the user actually hears the note.
    // Pending visual-timer tracker. Was an Array with O(n) filter on
    // every fire — under heavy load (loop playback at 1/16 notes,
    // multi-lane Poly), the array could hit hundreds of entries and
    // each fire ate ~1ms in just the filter, snowballing into the
    // tens-of-ms tick stalls the debug log was showing. Set gives
    // O(1) add/delete.
    const _visualTimers = new Set();
    function visualLookAheadMs() {
      if (typeof Tone === 'undefined' || !Tone.context) return 0;
      const ctx = Tone.context;
      const raw = ctx.rawContext || ctx;
      // Three sources of delay from "playNote called" to "user hears it":
      //   - lookAhead:     Tone.js scheduling lead-time (~100ms default).
      //   - baseLatency:   AudioContext process buffer (a few ms).
      //   - outputLatency: device output buffer / Bluetooth path. Mobile +
      //                    wireless audio can be 100ms+, which is what made
      //                    the old "lookAhead-only" delay still look 1 step
      //                    off — the visual was racing the audio path.
      const lookAhead     = Number.isFinite(ctx.lookAhead)      ? ctx.lookAhead      : 0;
      const baseLatency   = Number.isFinite(raw.baseLatency)    ? raw.baseLatency    : 0;
      const outputLatency = Number.isFinite(raw.outputLatency)  ? raw.outputLatency  : 0;
      return Math.max(0, (lookAhead + baseLatency + outputLatency) * 1000);
    }
    // Optional `audioTime` anchors the visual to a specific audio-context
    // time (used by the absolute-time sequencer below). Without it, falls
    // back to a fixed lookahead delay good enough for one-shot previews.
    function scheduleVisual(fn, audioTime) {
      let ms;
      if (audioTime != null && typeof Tone !== 'undefined' && Tone.context) {
        const ctx = Tone.context;
        const raw = ctx.rawContext || ctx;
        // Use the raw audio-context currentTime as the baseline. ctx.now()
        // already includes Tone.js's lookAhead, so subtracting it from a
        // Tone.now()-anchored audioTime double-counted the lookAhead and
        // fired the visual ~100ms before the audio was heard.
        const currentAudio  = Number.isFinite(raw.currentTime)  ? raw.currentTime  : 0;
        const baseLatency   = Number.isFinite(raw.baseLatency)  ? raw.baseLatency  : 0;
        const outputLatency = Number.isFinite(raw.outputLatency) ? raw.outputLatency : 0;
        ms = Math.max(0, (audioTime - currentAudio + baseLatency + outputLatency) * 1000);
      } else {
        ms = visualLookAheadMs();
      }
      if (ms <= 0) { fn(); return; }
      const t = setTimeout(() => {
        _visualTimers.delete(t);
        fn();
      }, ms);
      _visualTimers.add(t);
    }
    function clearVisualTimers() {
      _visualTimers.forEach(t => clearTimeout(t));
      _visualTimers.clear();
    }

    function stopSequence() {
      clearTimeout(sequenceTimer);
      sequenceTimer = null;
      _schedStreams = [];
      _schedStopping = false;
      // MIDI output: Stop + clock halt + all-notes-off on the output.
      try { if (typeof midiTransportStop === 'function') midiTransportStop(); } catch (e) {}
      // Wipe any not-yet-fired dispatches before clearing streams —
      // otherwise the worklet might still fire a 'fire' message for a
      // step from the just-ended playback session, and the dispatchFn
      // would call scheduleStepAt against a stale stream object.
      if (typeof _clearAllScheduledDispatches === 'function') {
        _clearAllScheduledDispatches();
      }
      clearVisualTimers();
      clearHighlights();
      // Freeze the persistent cursor exactly where playback stopped: capture
      // the global transport tick BEFORE _removeLaneCursors / renderSequence
      // tear the playback cursors down and reset scroll.
      if (typeof _transportTick === 'function') _cursorTick = _transportTick();
      // Drop the per-lane playback cursors (renderSequence below also rebuilds
      // the strips, but remove explicitly so they vanish the instant we stop).
      if (typeof _removeLaneCursors === 'function') _removeLaneCursors();
      // Immediate silence: a user "stop" should cut sounding playback voices
      // (synths + samples) at once rather than letting their release tails
      // ring on. Click-free (short ramps), and held LIVE cell presses are
      // untracked so they survive.
      try { if (typeof silenceActiveVoices === 'function') silenceActiveVoices(); } catch (e) {}
      renderSequence();
      // "Stop where they are": scroll each lane to center the frozen cursor at
      // the stop position, leaving the cursor visible for side-scroll editing.
      if (typeof _positionCursorsAtTick === 'function') _positionCursorsAtTick(_cursorTick, true);
      document.getElementById('play-btn').textContent = '▶';
      // Stop driving the Keep button off the playback step — fall back
      // to the wrap state (or "KEEP" if no wrap is active).
      _playbackStep = null;
      _playbackStepsByLane.clear();
      _fluidPlaybackByLane.clear();
      if (_fluidPlaybackRaf) { cancelAnimationFrame(_fluidPlaybackRaf); _fluidPlaybackRaf = 0; }
      updateKeepLabel();
    }

    // ---- Lookahead scheduler -------------------------------------------
    // A 25ms tick fills the next ~500ms of audio events on the audio
    // thread. Notes are scheduled with absolute audio times so the audio
    // clock plays them precisely; the lookahead just needs to exceed the
    // worst-case JS-thread tick interval. Chrome's setTimeout under load
    // (DevTools open, background tab heuristics, GC, layout) can balloon
    // to 200–500ms, so 100ms wasn't enough — notes whose audio time fell
    // between ticks but past the horizon got scheduled after the audio
    // clock had already passed them, manifesting as skips/hangs.
    //
    // Mobile Safari throttles foreground tabs more aggressively over
    // long sessions (low-power, energy heuristics) — multi-lane looped
    // playback "after a while" goes choppy because the 100 ms cushion
    // wasn't surviving the longer intervals. Lift the horizon to 500 ms
    // to absorb those stalls; the audio clock still fires every event
    // sample-accurately and live-edit lag (~500 ms vs ~100 ms) is
    // imperceptible at musical BPMs.
    const SCHED_LOOKAHEAD_SEC = 0.5;
    const SCHED_TICK_MS       = 25;

    // Multi-stream scheduler. Each stream is one playable sequence —
    // a single entry in Mono mode (the global `sequence`), or one entry
    // per non-muted/solo'd lane in Poly mode. They share `_playBaseTime`
    // so all streams start in lock-step; each stream advances its own
    // `idx` / `subStack` / `offsetSec` independently.
    // Drift fields (Poly only): `iter` counts wraps, `driftAccumSec`
    // tracks how much extra delay has been injected by the lane's
    // `driftMs`, and `pendingClearDrift` flags a request to re-sync
    // with the un-drifted timeline at the next wrap.
    let _schedStreams     = []; // [{ source, idx, subStack, offsetSec, laneIdx, iter, driftAccumSec, pendingClearDrift }]
    let _schedStopping    = false;
    let _schedTailEndTime = 0;

    // ---- AudioWorklet-driven dispatch (step 2 of timing refactor) ------
    // The setTimeout-based schedulerTick still walks streams to figure
    // out which events are due in the next ~500 ms, but instead of
    // calling scheduleStepAt synchronously it stashes a dispatch
    // closure keyed by a numeric id and tells the worklet "fire id N
    // at audioTime T". The worklet runs on the audio thread, so the
    // fire-back message arrives reliably even if the main thread is
    // bogged down by a GC pause, large UI re-render, blob fetch, or
    // background-tab setTimeout throttling.
    //
    // The worklet doesn't know about steps, chords, lanes, or Tone —
    // it's a pure event clock holding {id, audioTime} pairs. When it
    // posts a 'fire' message we look up the id in _pendingDispatches,
    // run the closure (which re-reads mute / solo state and then calls
    // scheduleStepAt → playNote), and drop the entry.
    //
    // Falls back gracefully: if the worklet fails to load (Safari /
    // iOS quirks, mid-load page reload, missing module URL, etc.) the
    // walk dispatches directly — same code path, same audible result,
    // just without the audio-thread queue.
    let _bloopsSchedulerNode      = null;
    let _bloopsSchedulerReadyP    = null; // promise while load is in flight
    let _bloopsSchedulerLoadFailed = false;
    const _pendingDispatches = new Map(); // id → { audioTime, fn }
    let _nextDispatchId = 1;

    // Construct + cache the worklet node. First call kicks off the
    // async addModule + node construction; subsequent calls return the
    // existing promise so we don't double-register. On failure the
    // node stays null and the walk falls back to direct dispatch.
    function _ensureBloopsSchedulerNode() {
      if (_bloopsSchedulerNode) return Promise.resolve(_bloopsSchedulerNode);
      if (_bloopsSchedulerLoadFailed) return Promise.resolve(null);
      if (_bloopsSchedulerReadyP) return _bloopsSchedulerReadyP;
      _bloopsSchedulerReadyP = (async () => {
        try {
          const ctx = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
            ? Tone.context.rawContext
            : null;
          if (!ctx || !ctx.audioWorklet) {
            throw new Error('AudioWorklet not available on this audio context');
          }
          await ctx.audioWorklet.addModule('js/scheduler-worklet.js');
          const node = new AudioWorkletNode(ctx, 'bloops-scheduler', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });
          // The processor must be in the graph for process() to run,
          // but it emits nothing audible. Connecting to ctx.destination
          // pulls it; the channel is silent so it's inaudible.
          try { node.connect(ctx.destination); } catch (e) {}
          node.port.onmessage = (e) => _handleBloopsSchedulerMessage(e.data);
          _bloopsSchedulerNode = node;
          return node;
        } catch (e) {
          console.warn('[bloops-scheduler] worklet load failed; falling back to direct dispatch:', e);
          _bloopsSchedulerLoadFailed = true;
          _bloopsSchedulerNode = null;
          return null;
        } finally {
          _bloopsSchedulerReadyP = null;
        }
      })();
      return _bloopsSchedulerReadyP;
    }

    function _handleBloopsSchedulerMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'fire' && Array.isArray(msg.events)) {
        for (let i = 0; i < msg.events.length; i++) {
          const ev = msg.events[i];
          if (!ev) continue;
          const entry = _pendingDispatches.get(ev.id);
          if (!entry) continue;
          _pendingDispatches.delete(ev.id);
          try { entry.fn(ev.audioTime != null ? ev.audioTime : entry.audioTime); }
          catch (err) { console.error('[bloops-scheduler] dispatch threw:', err); }
        }
        return;
      }
      if (msg.type === 'topUp') {
        // Background-tab resilience: the walk's self-rearm
        // (setTimeout(schedulerTick, 25 ms)) throttles to ~1 Hz when
        // the tab loses focus, so without help the queue runs dry and
        // audio dies a few seconds after Make-mode playback is
        // backgrounded. The worklet's process() keeps running at audio
        // rate regardless, so its periodic topUp pulse drives a walk
        // beat directly. Only pulse when playback is actually active —
        // an idle tab shouldn't trigger spurious walks.
        if (sequenceTimer !== null && !_schedStopping
            && Array.isArray(_schedStreams) && _schedStreams.length > 0) {
          try { schedulerTick(); }
          catch (err) { console.error('[bloops-scheduler] topUp walk threw:', err); }
        }
        return;
      }
    }

    // Schedule a dispatch via the worklet when one is available, fall
    // back to direct call otherwise. The walk doesn't care which path
    // is used — both result in fn(audioTime) running before audioTime,
    // letting it call playNote(...) with the correct schedule time.
    //
    // `stream` and `walkSnapshot` are optional and only consumed by
    // _invalidateScheduledFrom — when set, a future cancel can rewind
    // the stream to the snapshot's pre-walk state so the walk re-walks
    // the cancelled span from scratch on its next tick.
    function _scheduleDispatch(audioTime, fn, stream, walkSnapshot) {
      if (_bloopsSchedulerNode) {
        const id = _nextDispatchId++;
        _pendingDispatches.set(id, { audioTime, fn, stream, walkSnapshot });
        try {
          _bloopsSchedulerNode.port.postMessage({
            type: 'schedule',
            events: [{ id, audioTime }],
          });
          return;
        } catch (e) {
          // postMessage shouldn't really throw — but if it does, drop
          // the pending entry and fall through to direct dispatch so
          // the note isn't silently lost.
          _pendingDispatches.delete(id);
          console.warn('[bloops-scheduler] postMessage failed; dispatching directly:', e);
        }
      }
      // Fallback: call now. Tone schedules at audioTime via Web Audio
      // native sample-accurate timing, so this still fires precisely.
      try { fn(audioTime); }
      catch (err) { console.error('[bloops-scheduler] direct dispatch threw:', err); }
    }

    // Wipe every queued dispatch — both the worklet's queue and the
    // main-thread closure map. Called from stopSequence and whenever
    // playback is rebuilt from scratch.
    function _clearAllScheduledDispatches() {
      _pendingDispatches.clear();
      if (_bloopsSchedulerNode) {
        try { _bloopsSchedulerNode.port.postMessage({ type: 'clear' }); }
        catch (e) {}
      }
    }

    // Restore a stream object's mutable state from a snapshot captured
    // at walk time. Called by _invalidateScheduledFrom when cancelling
    // future dispatches — winding back the stream so the walk re-walks
    // from the earliest cancelled step's pre-state.
    // Note: source / laneIdx are not part of the snapshot (they don't
    // change during playback). subStack is deep-copied so restoring
    // doesn't tie the live stream to the snapshot's array (subsequent
    // pushes / pops should not mutate the snapshot's record).
    function _restoreStreamFromSnapshot(stream, snap) {
      if (!stream || !snap) return;
      stream.idx           = snap.idx;
      stream.offsetSec     = snap.offsetSec;
      stream.iter          = snap.iter;
      stream.driftAccumSec = snap.driftAccumSec;
      stream.ended         = false;
      stream.subStack.length = 0;
      for (let i = 0; i < snap.subStack.length; i++) {
        const s = snap.subStack[i];
        stream.subStack.push({ subSteps: s.subSteps, idx: s.idx });
      }
    }

    // Cancel every pending dispatch whose audioTime falls on or after
    // `cutoffAudioTime`, then rewind each affected stream to the
    // EARLIEST cancelled dispatch's snapshot. The walk's next tick
    // re-walks the cancelled span from that snapshot, picking up
    // whatever the user just edited (added / removed / replaced steps,
    // changed BPM, toggled loop, etc.).
    //
    // Notes already inside the 50 ms Tone lookahead are intentionally
    // preserved by callers (which pass cutoff = Tone.now() + 0.05)
    // since Tone has likely already committed them to the audio graph;
    // cancelling them via the worklet wouldn't actually un-fire them
    // and just risks audible glitching.
    function _invalidateScheduledFrom(cutoffAudioTime) {
      if (!Number.isFinite(cutoffAudioTime)) return;
      if (_pendingDispatches.size === 0) {
        // Still send the worklet cancel so a stale queued event past
        // cutoff (e.g. one whose closure-side entry was already
        // consumed) doesn't fire after the edit.
        if (_bloopsSchedulerNode) {
          try { _bloopsSchedulerNode.port.postMessage({ type: 'cancelAfter', audioTime: cutoffAudioTime }); }
          catch (e) {}
        }
        return;
      }
      // First pass: find the earliest cancelled entry per stream
      // (lowest audioTime). That's the snapshot we'll rewind to —
      // the rest of the cancelled entries for the same stream
      // describe later states that the walk will re-derive anyway.
      const earliestByStream = new Map();
      const toDelete = [];
      for (const [id, entry] of _pendingDispatches) {
        if (!entry || entry.audioTime < cutoffAudioTime) continue;
        toDelete.push(id);
        if (!entry.stream || !entry.walkSnapshot) continue;
        const cur = earliestByStream.get(entry.stream);
        if (!cur || entry.audioTime < cur.audioTime) {
          earliestByStream.set(entry.stream, entry);
        }
      }
      if (toDelete.length === 0) return;
      // Rewind affected streams. Doing this BEFORE removing from the
      // pending map keeps the snapshot reachable if something throws.
      for (const [stream, entry] of earliestByStream) {
        _restoreStreamFromSnapshot(stream, entry.walkSnapshot);
      }
      // Drop the cancelled entries from the main-thread map.
      for (let i = 0; i < toDelete.length; i++) {
        _pendingDispatches.delete(toDelete[i]);
      }
      // Tell the worklet to drop its queued copies. Using cancelAfter
      // is cheaper than cancel-by-id-list and naturally handles any
      // events the worklet has accepted but main hasn't seen yet.
      if (_bloopsSchedulerNode) {
        try { _bloopsSchedulerNode.port.postMessage({ type: 'cancelAfter', audioTime: cutoffAudioTime }); }
        catch (e) {}
      }
    }

    // Thin convenience wrapper — invalidate everything scheduled past
    // a small safety window. Callers use this after a structural edit
    // to in-flight lane.steps (add / remove / replace). In-place
    // mutations (e.g. step.freq = newFreq on an existing step object)
    // don't need this — the dispatched closures already hold a live
    // reference to the step object and pick up mutations automatically.
    function _invalidatePlayback() {
      if (sequenceTimer === null) return; // not playing
      const now = (typeof Tone !== 'undefined' && typeof Tone.now === 'function')
        ? Tone.now() : 0;
      _invalidateScheduledFrom(now + 0.05);
    }

    // ---- Audio slippage tracking ---------------------------------------
    // Worst-case "how late we scheduled a note" measurement in ms, with
    // exponential decay so a brief stall doesn't permanently glow the
    // Reset-Audio button. Read by refreshAudioResetUI() to drive the
    // warning state. Decay applies per-tick; spikes overwrite a higher
    // value immediately.
    let _slipMs = 0;
    const SLIP_DECAY = 0.9;
    const SLIP_WARN_MS  = 25;
    const SLIP_ALARM_MS = 80;

    // Sum the natural runtime of a step list at the current BPM so the
    // Drift "Clear" path can snap a drifted stream forward to the next
    // un-drifted iteration boundary.
    function _intrinsicLoopSec(steps) {
      if (!Array.isArray(steps) || steps.length === 0) return 0;
      const bpm = parseInt(tempoInput?.value, 10) || 120;
      const beatSec = 60 / bpm;
      const sumLen = (arr) => {
        let total = 0;
        for (const s of arr) {
          if (!s) continue;
          const stepDur = s.duration || 1;
          if (s.isSub && Array.isArray(s.subSteps)) {
            total += sumLen(s.subSteps);
          } else {
            const stepSub = (s.subdivision != null) ? s.subdivision : stepSubdivision;
            total += beatSec * stepSub * stepDur;
          }
        }
        return total;
      };
      return sumLen(steps);
    }

    // Set during scheduleStepAt so playNote skips its flashCellByFreq —
    // we schedule the cell highlight ourselves via scheduleVisual keyed
    // off audio time, so doubling it adds extra setTimeouts per note
    // that piled up over long looped playback.
    let _suppressCellFlash = false;

    function rawAudioNow() {
      const raw = (typeof Tone !== 'undefined' && Tone.context && Tone.context.rawContext)
        ? Tone.context.rawContext : null;
      if (raw && Number.isFinite(raw.currentTime)) return raw.currentTime;
      return (typeof Tone !== 'undefined' && Tone.context) ? Tone.context.now() : 0;
    }

    function currentSchedStep(stream) {
      if (stream.subStack.length > 0) {
        const top = stream.subStack[stream.subStack.length - 1];
        return top.subSteps[top.idx];
      }
      return stream.source[stream.idx];
    }

    function advanceSchedLevel(stream) {
      if (stream.subStack.length > 0) {
        stream.subStack[stream.subStack.length - 1].idx++;
      } else {
        stream.idx++;
      }
    }

    // Returns true when a lane should produce audio at the current
    // moment — non-muted, or solo'd if any other lane is solo'd.
    // Read live by the scheduler so toggling mute/solo during playback
    // takes effect immediately without restarting.
    function _laneIsAudible(lane) {
      if (!lane) return true;
      const anySolo = lanes.some(l => l && l.solo);
      if (anySolo) return !!lane.solo;
      return !lane.muted;
    }

    // Probability + per-loop-pass conditional for a step. Returns true when
    // the step should fire on this pass. step.prob (0..100) is a dice roll;
    // step.cond gates on the loop iteration (stream.iter): '1st' (first pass
    // only), or Elektron-style 'A:B' (play on pass A of every B). 'always' /
    // unset = always.
    function _stepShouldFire(step, stream, off) {
      if (!step) return true;
      if (!(off && off.chance) && Number.isFinite(step.prob) && step.prob < 100) {
        if ((Math.random() * 100) >= step.prob) return false;
      }
      const cond = (off && off.when) ? null : step.cond;
      if (cond && cond !== 'always') {
        const iter = (stream && Number.isFinite(stream.iter)) ? stream.iter : 0;
        if (cond === '1st') return iter === 0;
        const m = /^(\d+):(\d+)$/.exec(cond);
        if (m) {
          const a = parseInt(m[1], 10), bb = parseInt(m[2], 10);
          if (bb > 0) return (iter % bb) === (((a - 1) % bb + bb) % bb);
        }
      }
      return true;
    }

    function scheduleStepAt(step, audioTime, stream, silent = false, laneIdx) {
      // Variance: swap the step's pitch / sound / params for one of
      // its alternates per iteration. Linear cycles via stream.iter,
      // random samples uniformly. Duration / subdivision / bend / etc.
      // are inherited from the parent step so the rhythmic shape stays
      // the same across iterations.
      const origStep = step;
      const playStep = _resolveVariantStep(step, stream && stream.iter);
      step = playStep;
      // Per-step bypass switches (the step editor's active/bypass toggles).
      // _off is authored on the original step; a bypassed setting keeps its
      // value but the scheduler ignores it here. Keys: pan / vol / slip /
      // strum / roll / chance / when.
      const _off = (origStep && origStep._off) || null;
      // Slip shifts the audio fire time forwards or backwards by a
      // percent of this step's duration. Per-step slip lives on
      // step.params.slip; lane-level slip lives on the lane and
      // applies to every step in it. The two stack additively.
      // stream.offsetSec is NOT shifted, so the next step still fires
      // at its grid position — only this step's attack moves.
      const lane = (Number.isFinite(laneIdx) && lanes[laneIdx]) ? lanes[laneIdx] : null;
      const stepSlip = (_off && _off.slip) ? 0
        : (step.params && Number.isFinite(step.params.slip))
        ? step.params.slip
        : (Number.isFinite(step.slip) ? step.slip : 0);
      const laneSlip = (lane && Number.isFinite(lane.slip)) ? lane.slip : 0;
      const slipFrac = Math.max(-1, Math.min(1, (stepSlip + laneSlip) / 100));
      // Live chip-label update: when a top-level step has variance
      // applied, replace the chip's first text segment (the note
      // label) with the variant being played, scheduled at audioTime
      // so the visual lines up with the audio.
      const varianceApplied = (playStep !== origStep)
        && origStep && origStep.variance
        && Array.isArray(origStep.variance.notes)
        && origStep.variance.notes.length > 1;
      if (!silent && varianceApplied
          && stream && stream.subStack && stream.subStack.length === 0) {
        const _stepIdxForChip = stream.idx;
        const _laneIdxForChip = laneIdx;
        const _variantLabel = playStep && playStep.label != null ? String(playStep.label) : '';
        scheduleVisual(() => {
          _updateChipLabelText(_stepIdxForChip, _laneIdxForChip, _variantLabel);
        }, audioTime);
      }
      const stepDur = step.duration || 1;
      const stepSub = (step.subdivision != null) ? step.subdivision : stepSubdivision;
      const bpm = parseInt(tempoInput.value) || 120;
      // Storing the exact value in stream.offsetSec keeps the cadence
      // drift-free over many loops — rounding here would accumulate
      // ~0.5ms per step, audible after long runtimes.
      const waitSecExact = (60 / bpm) * stepSub * stepDur;
      const waitMsExact = waitSecExact * 1000;
      // Slip moves THIS step's attack within its slot but doesn't
      // shift the cadence — stream.offsetSec still advances by the
      // full waitSecExact so the next step lands on its grid time.
      // When slip is 0 the values collapse back to the original
      // audioTime / waitMsExact so the non-slip path is byte-for-byte
      // identical to the pre-slip behavior (no surprise timing changes
      // for projects without slip).
      // ---- Groove resolver: compose slip + swing + humanize into ONE fire
      // offset. None of these touch stream.offsetSec, so the cadence stays
      // grid-locked — only this attack moves within its slot (exactly how
      // slip already behaved). With every groove value 0 the offset is just
      // the slip term, so projects without groove are unchanged.
      let offsetSec = slipFrac * waitSecExact;
      // Swing: delay the off-grid positions (odd multiples of the swing
      // grid). Position parity is read from the un-slipped slot time
      // relative to the playback base, so it's stable across the deferred
      // dispatch (stream.offsetSec may have advanced by the time we fire).
      if (grooveSwing > 0) {
        const beatSec = 60 / bpm;
        const divSec  = grooveSwingDiv * beatSec;
        if (divSec > 0) {
          const gridIdx = Math.round((audioTime - _playBaseTime) / divSec);
          if ((((gridIdx % 2) + 2) % 2) === 1) {
            offsetSec += (grooveSwing / 100) * 0.5 * divSec;
          }
        }
      }
      // Humanize timing: small ± random nudge. Stays well inside the
      // scheduler's lookahead window so a negative nudge never lands in the
      // past.
      if (grooveHumanizeMs > 0) {
        offsetSec += (Math.random() * 2 - 1) * (grooveHumanizeMs / 1000);
      }
      let fireTime, durMs;
      if (offsetSec === 0) {
        fireTime = audioTime;
        durMs    = waitMsExact;
      } else {
        fireTime = audioTime + offsetSec;
        durMs    = Math.max(20, waitMsExact - offsetSec * 1000);
      }
      // Humanize velocity: scale each voice's volume by a small ± factor.
      // _withVel applies it to a params value (string or object); identity
      // when no velocity humanize is active, so the warm path is untouched.
      let _velScale = 1;
      if (grooveHumanizeVel > 0) {
        _velScale = Math.max(0.05, 1 + (Math.random() * 2 - 1) * (grooveHumanizeVel / 100));
      }
      // Accent (metric ducking): when an accent pulse is active, notes that
      // DON'T land on an accent beat (and aren't manually flagged) duck by
      // grooveAccentAmt, leaving the accented hits proud. Beat parity is read
      // from the un-slipped slot time like swing, so it's dispatch-stable.
      if (grooveAccentAmt > 0 && grooveAccentEvery > 0) {
        let _accented = !!step.accent;
        if (!_accented) {
          const beatSec = 60 / bpm;
          if (beatSec > 0) {
            // Metric accent: emphasize the note that lands ON each Nth-beat
            // downbeat. `phase` is this step's distance (in quarter-beats)
            // into the current accent group; ~0 means it sits on the
            // downbeat. Using the CONTINUOUS beat position (not a rounded
            // beat index) keeps the accent on the true downbeat for sub-beat
            // sequences — the old Math.round() aliased 1/8 / 1/16 steps onto
            // neighbouring beats, producing a ragged double-accented pattern.
            const beatPos = (audioTime - _playBaseTime) / beatSec;
            const phase = ((beatPos % grooveAccentEvery) + grooveAccentEvery) % grooveAccentEvery;
            _accented = (phase < 1e-3) || ((grooveAccentEvery - phase) < 1e-3);
          }
        }
        if (!_accented) _velScale *= (1 - grooveAccentAmt / 100);
      }
      const _withVel = (p) => {
        if (_velScale === 1) return p;
        if (typeof p === 'string') return { type: p, volume: Math.max(0, Math.min(100, 100 * _velScale)) };
        const q = { ...p };
        q.volume = Math.max(0, Math.min(100, (q.volume == null ? 100 : q.volume) * _velScale));
        return q;
      };
      // Bypass switches for pan / volume: neutralize the params at fire time
      // (pan → center, volume → full) while leaving the stored value intact
      // so the toggle can restore it.
      const _withBypass = (p) => {
        if (!_off || (!_off.pan && !_off.vol)) return p;
        const q = (typeof p === 'string') ? { type: p } : { ...p };
        if (_off.pan) q.pan = 0;
        if (_off.vol) q.volume = 100;
        return q;
      };
      // Sample slicing: a sliceable-sample grid voice carries params.sliceMode.
      // Each step plays a step-div-sized slice; the offset depends on the mode
      // and the per-lane scan playhead (stream._sampleScanSec / _sampleStepIdx,
      // reset on any non-firing slot below). Computed once per step; identity
      // for non-slice voices so synth/whole-sample playback is untouched.
      const _slicePrimary = step.chord ? (step.chord[0] && step.chord[0].params) : step.params;
      const _sliceMode = (_slicePrimary && typeof _slicePrimary === 'object'
        && typeof _slicePrimary.sliceMode === 'string' && _slicePrimary.sliceMode !== 'none'
        && isSampleType(_slicePrimary.type)) ? _slicePrimary.sliceMode : null;
      let _sliceOpts = null;
      if (_sliceMode) {
        const _sliceSec = waitSecExact;
        const _ofs = (_sliceMode === 'stutter') ? 0
          : (_sliceMode === 'index') ? ((stream._sampleStepIdx || 0) * _sliceSec)
          : (stream._sampleScanSec || 0); // 'scan'
        _sliceOpts = { sampleOffsetSec: _ofs, sliceDurSec: _sliceSec };
      }
      const _withSlice = (p) => {
        if (!_sliceOpts) return p;
        const q = (typeof p === 'string') ? { type: p } : { ...p };
        q.sampleOffsetSec = _sliceOpts.sampleOffsetSec;
        q.sliceDurSec = _sliceOpts.sliceDurSec;
        return q;
      };
      // Silent path: muted lane keeps its scheduler pointer advancing
      // so unmuting mid-loop snaps back into the cadence cleanly.
      // Drop the lane's stale entry from the per-lane Keep label so
      // muting a lane mid-playback removes its name from the readout
      // (otherwise the last note before mute would stick visible).
      // (Offset advancement is owned by the walk now — see the
      // schedulerTick path below — so a deferred worklet dispatch
      // doesn't double-advance when it eventually fires.)
      if (silent) {
        if (polyMode && Number.isFinite(laneIdx) && _playbackStepsByLane.has(laneIdx)) {
          const _li = laneIdx;
          scheduleVisual(() => {
            _playbackStepsByLane.delete(_li);
            updateKeepLabel();
          }, audioTime);
        }
        return waitSecExact;
      }

      // Conditional / probability gate — decide whether this step fires on
      // THIS pass. A gated-out step plays nothing but the walk still
      // advances the cadence, so it leaves a clean rest in the groove and
      // the loop keeps evolving. iter (the lane's loop pass) comes from the
      // same stream.iter that variance already keys off.
      if (!_stepShouldFire(step, stream, _off)) {
        stream._sampleScanSec = 0; stream._sampleStepIdx = 0; // gated rest resets slice scan
        return waitSecExact;
      }

      _suppressCellFlash = true;
      try {
        if (step.isFluid && Array.isArray(step.samples)) {
          // Fluid XY recording — replay the captured gesture as a
          // single sustained voice that ramps through every sample.
          _playFluidStep(step, fireTime);
          // Register the fluid playback so the Keep label can glide
          // through the gesture's frequencies in lockstep with the
          // audio (drives _ensureFluidPlaybackRaf below). Indexed by
          // laneIdx — mono playback (laneIdx undefined) uses -1.
          //
          // No paired scheduled-delete: the rAF loop expires stale
          // entries by elapsed time. A scheduled delete would race
          // against the next loop iteration's add (looped sequences
          // re-fire the same step before the prior iteration's natural
          // end) and wipe the fresh entry just after it lands.
          const _flKey = Number.isFinite(laneIdx) ? laneIdx : -1;
          scheduleVisual(() => {
            _fluidPlaybackByLane.set(_flKey, { step, audioStartedAt: fireTime });
            _ensureFluidPlaybackRaf();
            try { updateKeepLabel(); } catch (e) {}
          }, fireTime);
        } else if (step.chord || step.freq != null) {
          // Fire all of this step's voices at audio time `at`, ringing for
          // `dms`. Factored out so ratchet can re-fire it N times.
          const _strumMs = (_off && _off.strum) ? 0
            : (Number.isFinite(step.strum) ? Math.max(-80, Math.min(80, step.strum)) : 0);
          const _strumSec = _strumMs / 1000;
          const _fireStepVoices = (at, dms) => {
            if (step.chord) {
              const size = step.chord.length;
              for (let ci = 0; ci < step.chord.length; ci++) {
                const n = step.chord[ci];
                if (!n) continue;
                // Strum: stagger voices low→high (+) or high→low (−).
                const _voiceAt = (_strumSec === 0)
                  ? at
                  : at + (_strumSec >= 0 ? ci : (size - 1 - ci)) * Math.abs(_strumSec);
                const _cp = paramsWithBend(_withVel(_withBypass(_withSlice(chordVoiceParams(n.params || n.sound || 'sine', size, step)))), step.bend);
                playNote(n.freq, _cp, dms, _voiceAt, undefined, undefined, laneIdx);
                try { if (typeof midiEmitNote === 'function') midiEmitNote(n.freq, _cp, dms, _voiceAt, laneIdx); } catch (e) {}
              }
            } else {
              const _sp = paramsWithBend(_withVel(_withBypass(_withSlice(step.params || step.sound || 'sine'))), step.bend);
              playNote(step.freq, _sp, dms, at, undefined, undefined, laneIdx);
              try { if (typeof midiEmitNote === 'function') midiEmitNote(step.freq, _sp, dms, at, laneIdx); } catch (e) {}
            }
          };
          // Ratchet: split the step into N evenly-spaced sub-hits across its
          // duration (rolls / stutters). 1 (or unset) = the normal single
          // hit. Capped at 8 so a tiny step can't spawn a runaway burst.
          const _rat = (_off && _off.roll) ? 1
            : (Number.isFinite(step.ratchet) ? Math.max(1, Math.min(8, Math.floor(step.ratchet))) : 1);
          if (_rat <= 1) {
            _fireStepVoices(fireTime, durMs);
          } else {
            const _subMs = durMs / _rat;
            for (let j = 0; j < _rat; j++) {
              _fireStepVoices(fireTime + (j * _subMs) / 1000, Math.max(20, _subMs));
            }
          }
          // Advance the sample-slice scan playhead once per fired step.
          if (_sliceOpts) {
            stream._sampleScanSec = (stream._sampleScanSec || 0) + _sliceOpts.sliceDurSec;
            stream._sampleStepIdx = (stream._sampleStepIdx || 0) + 1;
          }
        } else {
          // Rest (no chord/freq): reset the slice scan playhead so the next
          // note retriggers from the sample's start.
          stream._sampleScanSec = 0; stream._sampleStepIdx = 0;
        }
      } finally {
        _suppressCellFlash = false;
      }

      scheduleVisual(() => {
        // The note grid is the active lane's editor — lighting up its
        // cells for every lane's playback would strobe the active grid
        // with notes that belong elsewhere. So only the active lane
        // (or mono playback, where laneIdx is undefined) drives the
        // cell highlight. Non-active lanes still update the Keep
        // label below so their chord/note name surfaces.
        const isActiveLane = !Number.isFinite(laneIdx) || laneIdx === activeLaneIdx;
        if (isActiveLane) {
          clearHighlights();
          // Resolve cell index for a voice with a stored cellIndex
          // falling back to a freq-based lookup. Out-of-scale cells
          // stay in the cells array (only get pointer-events:none) so
          // the outline still shows; transposed wrap voices that
          // store cellIndex=null still light up the closest cell.
          const lightCellByVoice = (n) => {
            if (!n) return;
            let idx = (n.cellIndex != null) ? n.cellIndex : -1;
            if (idx < 0 || idx >= cells.length || !cells[idx]) {
              idx = _findCellIdxForFreq(n.freq);
            }
            if (idx >= 0) cells[idx]?.classList.add('active-loop');
          };
          if (step.chord) {
            step.chord.forEach(lightCellByVoice);
          } else if (step.freq != null) {
            lightCellByVoice(step);
          } else {
            document.querySelectorAll('.rest-bar').forEach(b => b.classList.add('active-loop'));
          }
        }
        // Surface the currently-playing step in the Keep button so the
        // user can read the chord/note name as playback advances. Rests
        // don't carry pitch info, so leave the previous step's label up
        // rather than flashing to "KEEP". Cleared in stopSequence.
        // In Poly the map records each lane's current step so the
        // label can render "C D" when lanes play different chords; in
        // Mono we keep using the single _playbackStep slot.
        if (step.chord || step.freq != null) {
          if (polyMode && Number.isFinite(laneIdx)) {
            _playbackStepsByLane.set(laneIdx, step);
          } else {
            _playbackStep = step;
          }
          updateKeepLabel();
        }
      }, fireTime);

      // Offset advancement happens in the walk (schedulerTick) — see
      // the silent-path comment above. We still return waitSecExact
      // so callers can read the step's natural duration if they need it.
      return waitSecExact;
    }

    // Optional scheduler instrumentation — toggle via the browser
    // console with `localStorage.setItem('bloops_sched_debug','1')`
    // (and `removeItem` to disable). Logs one line per tick: wall
    // delta since last tick, audio context time, each stream's
    // offsetSec, and how many events were scheduled. A healthy run
    // shows steady ~25ms tick deltas with 0–1 events per tick;
    // hangs/skips manifest as long deltas or burst event counts.
    let _schedDebugLastWall = 0;
    function _schedDebugEnabled() {
      try { return localStorage.getItem('bloops_sched_debug') === '1'; }
      catch (e) { return false; }
    }

    function schedulerTick() {
      const debug = _schedDebugEnabled();
      const tickWall = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      const tickDelta = _schedDebugLastWall ? Math.round(tickWall - _schedDebugLastWall) : 0;
      _schedDebugLastWall = tickWall;
      let _debugScheduled = 0;
      // Decay slip each tick so a one-off stall doesn't keep the warning
      // glowing forever. Spikes below overwrite the decayed value, so
      // sustained drift still surfaces.
      _slipMs *= SLIP_DECAY;
      let _slipThisTickMs = 0;
      const _rawNowForSlip = rawAudioNow();
      if (!_schedStopping) {
        const horizon = _rawNowForSlip + SCHED_LOOKAHEAD_SEC;

        for (const stream of _schedStreams) {
          if (stream.ended) continue; // already finished its non-looped run
          let safety = 0;
          while (_playBaseTime + stream.offsetSec <= horizon) {
            if (++safety > 1024) break; // pathological-input guard
            const step = currentSchedStep(stream);
            if (step === undefined) {
              // End of current level — pop sub or end this stream.
              if (stream.subStack.length > 0) {
                stream.subStack.pop();
                advanceSchedLevel(stream);
                continue;
              }
              if (loopMode && stream.source.length > 0) {
                // Wrap this stream. Each step in the just-completed
                // iteration accumulated waitSecExact onto offsetSec, so
                // offsetSec already equals the exact end of iter N (==
                // start of iter N+1) — preserving phase across wraps.
                //
                // Earlier this branch contained a "snap-forward" that
                // reset offsetSec to (rawNow - _playBaseTime) whenever
                // continuation was behind realtime. That fired per-lane
                // on every browser jitter event (the snap threshold was
                // any past-due continuation, not a long stall), and each
                // lane snapped to its own arbitrary rawNow — so two
                // lanes whose wraps happened to be processed on
                // different ticks ended up at different phases. Removing
                // the snap means a stall causes a brief catch-up burst
                // (Tone fires past-due notes ASAP), but every lane stays
                // on the original metric grid and they stay in sync.
                stream.iter = (stream.iter || 0) + 1;
                const lane = (stream.laneIdx != null) ? lanes[stream.laneIdx] : null;
                if (stream.pendingClearDrift) {
                  // Re-sync with the un-drifted timeline: snap forward
                  // to the next iteration boundary that lines up with
                  // the lane's natural loop length. Ceil so the lane
                  // "waits" for the next un-drifted iteration if its
                  // accumulated drift overshot the current boundary.
                  const loopSec = _intrinsicLoopSec(stream.source);
                  if (loopSec > 0) {
                    const undrifted = stream.offsetSec - (stream.driftAccumSec || 0);
                    const target = Math.ceil(undrifted / loopSec) * loopSec;
                    stream.offsetSec = target;
                  }
                  stream.driftAccumSec = 0;
                  stream.iter = 0;
                  stream.pendingClearDrift = false;
                } else if (lane && Number.isFinite(lane.driftMs) && lane.driftMs > 0) {
                  // Each wrap adds `driftMs` to the lane's offset, so
                  // after N wraps it sits driftMs × N behind the
                  // un-drifted timeline (matches the user spec:
                  // "factor multiplied by iteration count").
                  const inc = lane.driftMs / 1000;
                  stream.offsetSec += inc;
                  stream.driftAccumSec = (stream.driftAccumSec || 0) + inc;
                }
                stream.idx = 0;
                continue;
              }
              // Non-loop end for this stream — mark ended so future
              // ticks skip it cleanly. Other streams keep going.
              stream.ended = true;
              break;
            }
            // Top-level chip highlight fires at the start of every
            // top-level step (regular OR sub); sub children inherit it.
            // Every lane in Poly highlights its own currently-playing
            // chip independently, so the user can see all playheads
            // moving in parallel. Highlight even when muted so the
            // user can see where the lane's playhead is.
            // (Chip highlight is *visual* timing only — fires at the
            // step's audio time regardless of mute, so the playhead
            // stays visible while the lane is silenced.)
            if (stream.subStack.length === 0) {
              const myIdx = stream.idx;
              const chipAudioTime = _playBaseTime + stream.offsetSec;
              // Step's musical length in ms — drives the smooth real-time
              // scroll sweep. (240/bpm)·factor == (60/bpm)·sub·dur for any
              // step (incl. subsequences, whose factor sums their children).
              const _bpmVis = parseInt(tempoInput.value) || 120;
              const _durMs = (240 / _bpmVis) * stepLengthFactor(step) * 1000;
              if (polyMode && stream.laneIdx != null) {
                const li = stream.laneIdx;
                scheduleVisual(() => setActiveChipForLane(li, myIdx, _durMs), chipAudioTime);
              } else {
                scheduleVisual(() => setActiveSequenceChip(myIdx, _durMs), chipAudioTime);
              }
            }
            if (step.isSub && Array.isArray(step.subSteps) && step.subSteps.length > 0) {
              stream.subStack.push({ subSteps: step.subSteps, idx: 0 });
              continue;
            }
            const audioTime = _playBaseTime + stream.offsetSec;
            // Compute waitSecExact here in the walk (mirrors the
            // arithmetic inside scheduleStepAt) so we can advance
            // stream.offsetSec BEFORE the dispatch fires. The walk
            // needs the next step's offsetSec to compute the next
            // step's audioTime; if we waited until scheduleStepAt
            // ran via the worklet (~60 ms ahead of audioTime), the
            // next iteration of this while-loop would still see the
            // old offsetSec and re-schedule the same note. Owning
            // the advance here keeps the walk synchronous regardless
            // of when dispatch fires.
            const _stepDur = step.duration || 1;
            const _stepSub = (step.subdivision != null) ? step.subdivision : stepSubdivision;
            const _bpmTick = parseInt(tempoInput.value) || 120;
            const waitSec  = (60 / _bpmTick) * _stepSub * _stepDur;
            // Slip = how far this note's intended audio time is behind
            // the raw audio clock. Positive means we couldn't schedule
            // in time and Tone has to fire ASAP / catch up. Persistent
            // positive slip is what causes the "sound lags behind chip
            // highlight" symptom — chips fire on wall-clock setTimeout
            // while audio fires at audioTime that already passed.
            if (audioTime < _rawNowForSlip) {
              const ms = (_rawNowForSlip - audioTime) * 1000;
              if (ms > _slipThisTickMs) _slipThisTickMs = ms;
            }
            if ((audioTime + waitSec) > _schedTailEndTime) {
              _schedTailEndTime = audioTime + waitSec;
            }
            // Capture per-step context for deferred dispatch. The
            // closure re-reads mute / solo state at fire time (~60 ms
            // before audioTime, instead of at walk time up to 500 ms
            // before), so live toggles take effect much sooner. The
            // worklet path adds <1 ms of overhead; the direct path
            // (no worklet) is byte-equivalent to the pre-worklet
            // schedulerTick behavior modulo the offset advance moving
            // up here.
            //
            // The walk continues to mutate `stream` (idx, iter,
            // subStack, offsetSec) while a dispatch sits queued in
            // the worklet, so we snapshot the fields scheduleStepAt
            // reads into a frozen view. Without this, _resolveVariant
            // Step would read an iter from the FUTURE (e.g. iter 2)
            // when fire-time arrives for an iter-1 dispatch, and the
            // wrong variant note would play.
            const _dispatchStep    = step;
            const _dispatchLaneIdx = stream.laneIdx;
            const _streamView = {
              iter:     stream.iter,
              idx:      stream.idx,
              // Synthesize an array with matching length so the
              // `subStack.length === 0` check inside scheduleStepAt
              // returns the value it would have at walk time, even
              // though we never look at its elements.
              subStack: new Array(stream.subStack.length),
              source:   stream.source,
              laneIdx:  stream.laneIdx,
            };
            // Walk-state snapshot for live-edit cancellation. If the
            // user mutates lane.steps before this dispatch fires, the
            // invalidate path rewinds the live stream to this exact
            // pre-walk state and the next tick re-walks the cancelled
            // span against the new step list. Deep-copy subStack so a
            // later push / pop on the live array doesn't corrupt the
            // snapshot.
            const _walkSnapshot = {
              idx:           stream.idx,
              offsetSec:     stream.offsetSec,
              iter:          stream.iter || 0,
              driftAccumSec: stream.driftAccumSec || 0,
              subStack:      stream.subStack.map(s => ({ subSteps: s.subSteps, idx: s.idx })),
            };
            _scheduleDispatch(audioTime, (fireAudioTime) => {
              const _laneAtFire = (_dispatchLaneIdx != null) ? lanes[_dispatchLaneIdx] : null;
              const _audibleNow = _laneIsAudible(_laneAtFire);
              scheduleStepAt(
                _dispatchStep,
                fireAudioTime,
                _streamView,
                !_audibleNow,
                _dispatchLaneIdx
              );
            }, stream, _walkSnapshot);
            stream.offsetSec += waitSec;
            advanceSchedLevel(stream);
            _debugScheduled++;
          }
        }

        // Stop only when EVERY stream has hit end-of-source without
        // looping. Don't infer "stop" from "this tick scheduled
        // nothing" — between scheduled events the next note's audio
        // time often hasn't entered the lookahead horizon yet, and
        // the tick correctly sits idle until it does.
        const allEnded = _schedStreams.length > 0 && _schedStreams.every(s => s.ended);
        if (allEnded) _schedStopping = true;
      }
      if (debug) {
        const rawNow = rawAudioNow();
        const offsetsStr = _schedStreams
          .map(s => (s.laneIdx == null ? 'M' : ('L' + s.laneIdx)) + ':' + (s.offsetSec || 0).toFixed(3) + (s.ended ? '!' : ''))
          .join(' ');
        console.log(
          '[sched] dt=' + tickDelta + 'ms',
          'rawNow=' + rawNow.toFixed(3),
          'base=' + (_playBaseTime || 0).toFixed(3),
          'sched=' + _debugScheduled,
          'streams=[' + offsetsStr + ']',
          (_schedStopping ? '(stopping)' : '')
        );
      }
      // Surface this tick's slip — overwrite the decayed value if larger
      // so sustained drift latches the warning state until the user resets
      // or the scheduler catches back up.
      if (_slipThisTickMs > _slipMs) _slipMs = _slipThisTickMs;
      if (typeof refreshAudioResetUI === 'function') refreshAudioResetUI();
      if (_schedStopping && rawAudioNow() >= _schedTailEndTime) {
        sequenceTimer = null;
        stopSequence();
        return;
      }
      sequenceTimer = setTimeout(schedulerTick, SCHED_TICK_MS);
    }

    // One-shot preview that doesn't touch sequenceTimer / playback state, so
    // clicking a chip during normal playback (or while idle) just auditions
    // the chip's audio without disrupting the running sequence.
    function previewStep(step) {
      if (!step) return;
      try { Tone.start(); } catch (e) {}
      const bpm = parseInt(tempoInput.value) || 120;
      const stepWaitMs = (s) => {
        const dur = s.duration || 1;
        const sub = (s.subdivision != null) ? s.subdivision : stepSubdivision;
        return Math.round(60000 / bpm * sub) * dur;
      };
      const playOne = (s) => {
        const waitMs = stepWaitMs(s);
        if (s.chord) {
          const size = s.chord.length;
          s.chord.forEach(n => {
            if (n.freq != null) playNote(n.freq, paramsWithBend(chordVoiceParams(n.params || n.sound || 'sine', size, s), s.bend), waitMs);
          });
        } else if (s.freq != null) {
          playNote(s.freq, paramsWithBend(s.params || s.sound || 'sine', s.bend), waitMs);
        }
        return waitMs;
      };
      const walkSubSteps = (subSteps, idx) => {
        if (idx >= subSteps.length) return;
        const sub = subSteps[idx];
        let waitMs = 0;
        if (sub && sub.isSub && Array.isArray(sub.subSteps) && sub.subSteps.length > 0) {
          // Nested sub: walk its children, summing the elapsed time before
          // moving on to the sibling at idx+1.
          waitMs = sub.subSteps.reduce((acc, c) => acc + stepWaitMs(c), 0);
          walkSubSteps(sub.subSteps, 0);
        } else if (sub) {
          waitMs = stepWaitMs(sub);
          playOne(sub);
        }
        setTimeout(() => walkSubSteps(subSteps, idx + 1), waitMs);
      };
      if (step.isSub && Array.isArray(step.subSteps) && step.subSteps.length > 0) {
        walkSubSteps(step.subSteps, 0);
      } else {
        playOne(step);
      }
    }

