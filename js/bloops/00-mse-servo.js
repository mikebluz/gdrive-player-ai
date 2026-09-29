// 00-mse-servo.js — the MSE broadcast's rate servo, as PURE ARITHMETIC.
//
// WHY THIS IS ITS OWN FILE: the servo decides how fast the broadcast element
// consumes audio, and getting it wrong is AUDIBLE — its first two versions
// shipped to a phone and were heard as a square-wave tremolo and as dropouts
// respectively. Neither was caught by the on-device telemetry, because both had
// clocks advancing and JS alive. Both WERE caught in seconds by replaying
// recorded production traces through the arithmetic offline.
//
// So the arithmetic lives here, with no reference to an element, a context, a
// clock or the DOM: `step()` takes numbers and returns a rate. `test/mse-servo.js`
// replays real traces harvested from device flight logs against it. 00-mse-audio.js
// owns everything physical (reading el.currentTime, writing el.playbackRate).
//
// Loads three ways so the gate needs no bundler and no browser: a plain <script>
// (publishes window._bloopsMseServo), a CommonJS require (module.exports), and a
// Node ESM `import` — this repo is "type": "module", where `module` is undefined
// and the factory falls through to globalThis.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root._bloopsMseServo = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // ---- tunables, in one place so the gate asserts against the SAME numbers --
  const D = {
    cushion: 1.2,      // target reserve, seconds — also the ride target
    rateMin: 0.70,     // must sit BELOW the worst production rate ever measured
    rateMax: 1.10,     // enough to recover after a dip, never a runaway
    window: 2,         // seconds per production-rate estimate
    ema: 0.5,          // smoothing on that estimate
    direAt: 0.6,       // reserve below this = act hard
    panicAt: 0.25,     // reserve below this = abandon the slew limit
    slewNormal: 0.024, // rate units PER SECOND (never per tick — see below)
    slewDire: 0.12,
  };

  function create(over) {
    const c = Object.assign({}, D, over || {});
    return {
      c: c,
      rate: 1,
      prodRef: null,   // { w, m, h } baseline for the estimate
      prodEma: null,   // smoothed production rate, null until the first window
      headSlope: 0,    // headroom seconds per second — the derivative
      lastAt: 0,       // wall seconds of the last step, for the per-second slew
    };
  }

  // step(S, inp) -> rate
  //   inp.nowS     wall clock, seconds
  //   inp.lag      RESERVE the element can actually play: bufEnd - currentTime.
  //                Segment-quantised (0.372 s steps) — safe for thresholds,
  //                NEVER for a derivative.
  //   inp.prodHead encoder head in media seconds (ts/1e6), ~46 ms resolution
  //   inp.headroom prodHead - currentTime — the same reserve at TAP resolution
  function step(S, inp) {
    const c = S.c;
    const nowS = inp.nowS, lag = inp.lag;

    // FEED-FORWARD on measured production. Pure feedback on the reserve cannot
    // work: it needs the reserve to be wrong before it acts, so against a
    // sustained deficit any bounded correction only delays the starve. Tracking
    // production holds it flat at any deficit — and that is not a distortion,
    // because if production runs at 0.87 the music IS being generated at 0.87.
    if (!S.prodRef) S.prodRef = { w: nowS, m: inp.prodHead, h: inp.headroom };
    const dw = nowS - S.prodRef.w;
    if (dw >= c.window) {
      const inst = (inp.prodHead - S.prodRef.m) / dw;
      if (inst > 0.4 && inst < 1.6) {
        S.prodEma = (S.prodEma == null) ? inst : S.prodEma + c.ema * (inst - S.prodEma);
      }
      // THE DERIVATIVE IS ON `headroom`, NOT `lag`. One 0.372 s segment step
      // inside a 2 s window fakes a slope of ±0.186/s; at a 0.6 gain that yanked
      // the rate by ∓0.11 with the reserve perfectly healthy, which is the
      // tremolo. headroom moves at tap resolution and has no such step.
      S.headSlope = (inp.headroom - S.prodRef.h) / dw;
      S.prodRef = { w: nowS, m: inp.prodHead, h: inp.headroom };
    }

    const base = (S.prodEma == null) ? 1 : S.prodEma;
    const err = lag - c.cushion;
    const dire = lag < c.direAt;
    const trim = Math.max(dire ? -0.22 : -0.08,
      Math.min(0.03, err * (dire ? 0.12 : 0.03) + Math.min(0, S.headSlope) * 0.3));
    const want = Math.max(c.rateMin, Math.min(c.rateMax, base + trim));

    // SLEW LIMIT, PER SECOND. A step change in rate is itself an artifact:
    // however right the target, the stretcher must be WALKED to it. And per
    // SECOND, not per tick — the caller's loop runs at 250 ms while visible and
    // ~2 s while hidden, so a per-tick cap is 8x slower exactly where deficits
    // are worst (that asymmetry alone starved two traces in the gate).
    // One escape hatch: below panicAt a hole is worse than a step, so jump.
    const dt = Math.max(0.05, Math.min(3, nowS - (S.lastAt || (nowS - 0.25))));
    S.lastAt = nowS;
    const perSec = (lag < c.panicAt) ? Infinity : (dire ? c.slewDire : c.slewNormal);
    const cap = perSec * dt;
    const next = Math.max(S.rate - cap, Math.min(S.rate + cap, want));
    if (Math.abs(next - S.rate) > 0.0005) S.rate = next;
    return S.rate;
  }

  // A starve while the page is HIDDEN cannot be recovered by pausing (a paused
  // renderer is what iOS reclassifies, popping the session), so undershoot the
  // measured production rate instead and stay audible while the reserve rebuilds.
  function starve(S) {
    S.rate = Math.max(S.c.rateMin, ((S.prodEma == null) ? 1 : S.prodEma) - 0.04);
    return S.rate;
  }

  function reset(S) { S.rate = 1; S.lastAt = 0; return S.rate; }

  return { create: create, step: step, starve: starve, reset: reset, DEFAULTS: D };
});
