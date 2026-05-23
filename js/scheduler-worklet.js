// Bloops scheduler — AudioWorkletProcessor that owns the playback event
// clock. Lives on the audio thread (preempted by nothing), so it keeps
// firing at audio rate even when the main thread is bogged down by GC,
// big React-y re-renders, blob fetches, or a background tab throttle.
//
// Hybrid model: the worklet is a TIMING source, not a DSP source. The
// main thread pre-computes events (audioTime + opaque numeric id) and
// posts them here via {type:'schedule'}. Each process() call shifts off
// events whose audioTime is within the lookahead window and posts them
// back to the main thread as {type:'fire'}. The main thread looks the
// id up in its pending-dispatch map and runs the dispatch closure —
// which is what actually calls into Tone to play the note.
//
// Why bother with the round-trip when Tone already schedules via
// Web Audio's native sample-accurate timing? Two reasons:
//   1. Live mute / solo / step edits can re-read state at fire time
//      (a few ms before the note plays) instead of at walk time
//      (hundreds of ms ahead), so toggles feel instant.
//   2. Background-tab setTimeout throttling (1 s) can't drop notes the
//      worklet has already queued.
//
// The worklet itself doesn't decode music structure — it just stores
// {audioTime, id} pairs sorted by audioTime. All step / chord / wrap
// logic stays on the main thread.

const DEFAULT_LOOKAHEAD_SEC = 0.06;        // fire when due within this window
const DEFAULT_TOPUP_PERIOD  = 0.05;        // ask main for more events every 50 ms
const DEFAULT_TOPUP_QUEUE_LO = 64;         // …or whenever queue is shallower than this
const MAX_EVENTS = 65536;                  // sanity cap so a runaway schedule can't OOM

class BloopsSchedulerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.events = []; // sorted by audioTime ascending: [{audioTime, id}]
    this.lookaheadSec  = Number.isFinite(opts.lookaheadSec)  ? opts.lookaheadSec  : DEFAULT_LOOKAHEAD_SEC;
    this.topUpPeriodSec = Number.isFinite(opts.topUpPeriodSec) ? opts.topUpPeriodSec : DEFAULT_TOPUP_PERIOD;
    this.topUpQueueLo  = Number.isFinite(opts.topUpQueueLo)  ? opts.topUpQueueLo  : DEFAULT_TOPUP_QUEUE_LO;
    this.lastTopUpAt = 0;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'schedule': {
        // Insert each event in audioTime-sorted order. Most additions
        // arrive in order so the inserted index is usually at the end —
        // a binary search keeps the worst case O(log n) for out-of-
        // order inserts (e.g. cancel-and-reschedule overlaying events).
        const incoming = Array.isArray(msg.events) ? msg.events : [];
        for (let i = 0; i < incoming.length; i++) {
          const ev = incoming[i];
          if (!ev || !Number.isFinite(ev.audioTime) || !Number.isFinite(ev.id)) continue;
          if (this.events.length >= MAX_EVENTS) break; // hard cap
          this._insertSorted({ audioTime: ev.audioTime, id: ev.id });
        }
        break;
      }
      case 'cancel': {
        // Drop events by id. Build a Set once for O(n) filter rather
        // than O(n * cancels) per-id splice.
        const ids = Array.isArray(msg.ids) ? msg.ids : [];
        if (ids.length === 0) break;
        const drop = new Set(ids);
        this.events = this.events.filter(e => !drop.has(e.id));
        break;
      }
      case 'cancelAfter': {
        // Drop every event with audioTime >= msg.audioTime. Used to
        // wipe the upcoming window during a live edit so the main
        // thread can repopulate with fresh state.
        const cutoff = Number(msg.audioTime);
        if (!Number.isFinite(cutoff)) break;
        // Binary search for the first index whose audioTime >= cutoff,
        // then truncate.
        let lo = 0, hi = this.events.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (this.events[mid].audioTime < cutoff) lo = mid + 1;
          else hi = mid;
        }
        if (lo < this.events.length) this.events.length = lo;
        break;
      }
      case 'clear': {
        this.events.length = 0;
        break;
      }
      case 'configure': {
        if (Number.isFinite(msg.lookaheadSec))  this.lookaheadSec  = msg.lookaheadSec;
        if (Number.isFinite(msg.topUpPeriodSec)) this.topUpPeriodSec = msg.topUpPeriodSec;
        if (Number.isFinite(msg.topUpQueueLo))  this.topUpQueueLo  = msg.topUpQueueLo;
        break;
      }
      default:
        // Unknown message — ignore so future-extensible messages don't
        // throw when an older worklet build is paired with newer main.
        break;
    }
  }

  _insertSorted(ev) {
    // Binary-search insertion to keep this.events sorted by audioTime
    // ascending. Fast for the common case where events arrive roughly
    // in order (insertion index lands near the end).
    const arr = this.events;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].audioTime <= ev.audioTime) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, ev);
  }

  process() {
    const now = currentTime;
    const horizon = now + this.lookaheadSec;

    // Pull every due event off the front (sorted ascending) until we
    // hit one beyond the horizon.
    let fireCount = 0;
    while (this.events.length > 0 && this.events[0].audioTime <= horizon) {
      fireCount++;
      if (fireCount > 256) break; // pathological-burst guard per block
      // Will splice below for clarity.
    }
    if (fireCount > 0) {
      const fired = this.events.splice(0, fireCount);
      this.port.postMessage({ type: 'fire', currentTime: now, events: fired });
    }

    // Top-up signal — sent on a periodic schedule OR whenever the queue
    // dips below the low-water mark. The main thread responds by
    // walking its streams another window's worth and posting more
    // schedule entries. Bursting both signals from the same tick is
    // fine; the main thread debounces inside its handler.
    const dueByTime = (now - this.lastTopUpAt) >= this.topUpPeriodSec;
    const dueByDepth = this.events.length < this.topUpQueueLo;
    if (dueByTime || dueByDepth) {
      this.lastTopUpAt = now;
      this.port.postMessage({
        type: 'topUp',
        currentTime: now,
        queueDepth: this.events.length,
        horizonSec: this.lookaheadSec,
      });
    }

    return true; // keep the processor alive
  }
}

registerProcessor('bloops-scheduler', BloopsSchedulerProcessor);
