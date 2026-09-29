#!/usr/bin/env node
// mse-servo.js — the gate for the MSE broadcast's rate servo.
//
// WHY THIS GATE EXISTS. The servo decides how fast the broadcast element consumes
// audio. Two successive versions of it shipped to a phone and were AUDIBLE
// failures — one heard as a square-wave tremolo, one as dropouts — and NEITHER
// was caught by the on-device telemetry, because both had clocks advancing, JS
// alive, and every counter reading healthy. Both were caught in milliseconds by
// replaying recorded production traces through the arithmetic.
//
// So this asserts the two properties the ear actually cares about:
//
//   SAFETY    the reserve never reaches zero  -> no dropout
//   SMOOTHNESS the rate never JUMPS while the reserve is healthy -> no tremolo
//
// Smoothness is the one the old telemetry could not see at all. A servo that
// holds the reserve perfectly by yanking playbackRate between 1.00 and 0.90 is a
// PASS on every buffer metric and a product failure.
//
// Traces in mse-servo-traces.json are REAL, harvested from device flight logs;
// the synthetic cases cover shapes the device has not happened to produce yet.
// Run: node test/mse-servo.js        (no device, no server, no browser)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// importing the module runs its UMD tail, which publishes onto globalThis here
await import(path.join(HERE, '..', 'js', 'bloops', '00-mse-servo.js'));
const servo = globalThis._bloopsMseServo;
if (!servo) { console.error('00-mse-servo.js did not publish _bloopsMseServo'); process.exit(2); }
const traces = JSON.parse(fs.readFileSync(path.join(HERE, 'mse-servo-traces.json'), 'utf8'));

const SEG = 0.372;          // one fMP4 segment — bufEnd only ever moves in these
// Smoothness budget. The tremolo measured ~0.10 per step; a monotonic ramp at the
// servo's own slew cap is inaudible. Allow a little headroom over slewDire for
// the per-tick discretisation, and exempt the panic band (a step there is
// deliberate — see 00-mse-servo.js).
// PER SECOND, because that is the unit the servo's own limit is in. Measuring
// per TICK fails every hidden case for free: slewNormal 0.024/s x a 2 s tick is
// 0.048 of legitimate movement. Getting this wrong made the gate's first run
// report 9 failures that were all the harness.
const MAX_SLEW_HEALTHY = 0.05;   // rate units per second, reserve healthy
// DERIVED from the servo's own dire threshold, never a second hardcoded number:
// with HEALTHY_AT below direAt the two bands overlap, and the gate flags the
// servo's legitimate dire-band movement as a tremolo (it did, on 3 cases).
const HEALTHY_AT = servo.DEFAULTS.direAt;
// THIRD ASSERTION — EXCURSION RANGE, and it is the one that catches a noisy
// control signal. The slew limit alone stops a JUMP, so a derivative taken on
// the segment-quantised reserve slips past both assertions above: it cannot move
// the rate fast, but it wanders. Measured peak-to-peak on steady production:
// 0.010 clean vs 0.061 with the derivative on `lag` — a 6% wobble, a slow
// tremolo. Only applied where production is STEADY, because tracking a real
// deficit is supposed to move the rate a long way.
// Floor of 0.03, but never below the servo's own resolution: it moves in steps
// of slewNormal x dt, so at a 2 s hidden tick one step is already 0.048 and a
// 0.03 budget asserts finer than the mechanism can resolve.
const rangeBudget = (dt) => Math.max(0.03, 2 * servo.DEFAULTS.slewNormal * dt);
const SETTLE = 30;          // seconds to ignore while the reserve reaches target

function simulate(prodAt, secs, dtAt, reserve0) {
  const S = servo.create();
  let head = 100;                  // encoder head, media seconds
  let endQ = 100;                  // bufEnd: head, quantised down to whole segments
  let elT = head - reserve0;       // element playhead
  let minReserve = reserve0, starves = 0;
  let maxSlewHealthy = 0, maxSlewAny = 0, prev = 1;
  let t = 0;
  const rates = [];
  const settled = [];        // rates after SETTLE, reserve healthy — for the range
  while (t < secs) {
    const dt = dtAt(t);
    const prod = prodAt(t);
    head += prod * dt;
    while (endQ + SEG <= head) endQ += SEG;
    const lag = endQ - elT;
    const rate = servo.step(S, { nowS: t, lag: lag, prodHead: head, headroom: head - elT });
    const slew = Math.abs(rate - prev) / dt;          // per SECOND
    maxSlewAny = Math.max(maxSlewAny, slew);
    if (lag > HEALTHY_AT) maxSlewHealthy = Math.max(maxSlewHealthy, slew);
    prev = rate;
    rates.push(rate);
    if (t > SETTLE && lag > HEALTHY_AT) settled.push(rate);
    elT += rate * dt;
    minReserve = Math.min(minReserve, lag);
    if (lag <= 0) { starves++; elT = endQ; }
    t += dt;
  }
  return {
    minReserve, starves, maxSlewHealthy, maxSlewAny,
    endRate: S.rate, prodEma: S.prodEma,
    meanRate: rates.reduce((a, b) => a + b, 0) / rates.length,
    range: settled.length > 4 ? Math.max(...settled) - Math.min(...settled) : null,
  };
}

// ---- cases ----------------------------------------------------------------
const cases = [];

// Real device traces. dt follows the observed visibility: the maintenance loop
// runs at 250 ms visible and is throttled to ~2 s hidden, and that asymmetry is
// itself load-bearing (a per-tick slew cap passed visible and starved hidden).
for (const tr of traces.traces) {
  const bounds = [];
  let acc = 0;
  for (const s of tr.segments) { bounds.push({ t0: acc, t1: acc + s.dur, prod: s.prod, vis: s.vis }); acc += s.dur; }
  const at = (t) => (bounds.find((b) => t >= b.t0 && t < b.t1) || bounds[bounds.length - 1]);
  // NOT marked steady, ever. A wander metric needs a STATIONARY input, and a
  // harvested trace is not one: production varies, visibility (hence the tick
  // rate, hence the slew cap) changes mid-trace, and the reserve drifts toward
  // target from wherever it started. The 00:51 trace ranges 0.114 for exactly
  // those reasons and it is not a defect. Device traces carry SAFETY and SLEW.
  cases.push({
    name: 'device: ' + tr.name,
    secs: acc,
    reserve0: tr.reserve0,
    prodAt: (t) => at(t).prod,
    dtAt: (t) => (at(t).vis === 'visible' ? 0.25 : 2.0),
  });
}

// Synthetic shapes the device has not produced yet, or produced only once.
const syn = (name, prodAt, reserve0, secs, dt, steady) =>
  cases.push({ name: 'synthetic: ' + name, secs, reserve0, prodAt, dtAt: () => dt, steady: !!steady });

syn('steady 0.998, healthy reserve', () => 0.998, 1.20, 180, 0.25, true);
syn('steady 0.998, hidden (2s ticks)', () => 0.998, 1.20, 180, 2.0, true);
syn('segment-quantisation only (the tremolo trap)', () => 1.0, 1.20, 240, 0.25, true);
syn('sustained hidden deficit 0.873', () => 0.873, 0.97, 120, 2.0, true);
syn('sustained hidden deficit 0.80', () => 0.80, 0.97, 600, 2.0, true);
syn('sustained hidden deficit 0.75', () => 0.75, 0.97, 300, 2.0);
syn('lock stall 0.579 for 3.5s', (t) => (t > 10 && t < 13.5) ? 0.579 : 0.99, 1.20, 90, 0.25);
syn('stall then 1.395 overshoot', (t) => (t > 10 && t < 13.5) ? 0.579 : ((t >= 13.5 && t < 16) ? 1.395 : 0.99), 1.20, 90, 0.25);
syn('cold start at 0.60 reserve', () => 0.95, 0.60, 120, 0.25);
syn('production jitter +/-7%', (t) => 0.998 + (Math.floor(t / 5) % 2 ? 0.07 : -0.07), 1.20, 300, 0.25);

// ---- run ------------------------------------------------------------------
let fails = 0;
console.log('MSE rate servo — ' + cases.length + ' cases ('
  + traces.traces.length + ' real device traces, ' + (cases.length - traces.traces.length) + ' synthetic)\n');
console.log('  ' + 'case'.padEnd(46) + 'minRes  slew/s   range  verdict');

for (const c of cases) {
  const r = simulate(c.prodAt, c.secs, c.dtAt, c.reserve0);
  const bad = [];
  if (r.starves > 0) bad.push('STARVED x' + r.starves + ' (min ' + r.minReserve.toFixed(2) + ')');
  if (r.maxSlewHealthy > MAX_SLEW_HEALTHY) {
    bad.push('RATE SLEW ' + r.maxSlewHealthy.toFixed(3) + '/s with a healthy reserve (tremolo)');
  }
  if (c.steady && r.range != null) {
    const budget = rangeBudget(c.dtAt(0));
    if (r.range > budget) {
      bad.push('RATE WANDER ' + r.range.toFixed(4) + ' peak-to-peak on STEADY production'
        + ' (budget ' + budget.toFixed(3) + ') — noisy control signal');
    }
  }
  if (!(r.endRate >= servo.DEFAULTS.rateMin && r.endRate <= servo.DEFAULTS.rateMax)) {
    bad.push('rate out of range: ' + r.endRate.toFixed(3));
  }
  if (bad.length) fails++;
  console.log('  ' + c.name.slice(0, 45).padEnd(46)
    + r.minReserve.toFixed(2).padStart(6)
    + r.maxSlewHealthy.toFixed(3).padStart(9)
    + (r.range == null ? '     -' : r.range.toFixed(4).padStart(8))
    + (c.steady ? ' ' : '~')
    + ' ' + (bad.length ? 'FAIL — ' + bad.join('; ') : 'ok'));
}

console.log('\n  slew/s = fastest rate change per SECOND with the reserve above ' + HEALTHY_AT + 's.'
  + '\n  range  = peak-to-peak rate after ' + SETTLE + 's; asserted only on steady production'
  + ' (rows marked ~ are\n           not steady, so their range is reported but not checked).'
  + '\n  Together: slew catches a JUMP, range catches a WANDER. The tremolo needed both.');

if (fails) {
  console.log('\n' + fails + ' case(s) FAILED');
  process.exit(1);
}
console.log('\nall ' + cases.length + ' cases pass — no starvation, no rate jump on a healthy reserve');
