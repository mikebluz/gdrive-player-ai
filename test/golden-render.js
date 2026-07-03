#!/usr/bin/env node
// =============================================================================
// golden-render.js — the core engine's audio regression gate.
// =============================================================================
// Renders a fixed note-event script through bloops-dsp.wasm DIRECTLY IN NODE
// (the core is pure — no browser needed) and SHA-256-hashes each section's
// samples. Any change to the rendered audio — voice math, envelopes,
// calibration constants, mod matrix — changes a hash and fails the gate.
//
//   node test/golden-render.js            → compare against the baseline
//   node test/golden-render.js --update   → rewrite the baseline (a DELIBERATE
//                                           audio change, reviewed + committed
//                                           together with the DSP change)
//
// Each section also sanity-checks: no NaN anywhere, and every section must
// produce audible energy — so a failure names the section, and silent/NaN
// regressions are caught even without a baseline. A second full pass verifies
// bit-determinism (init() must reset ALL engine globals — CORE_REV ≥ 4).
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, '..', 'js', 'bloops', 'core', 'bloops-dsp.wasm');
const BASELINE = path.join(HERE, 'golden-baseline.json');
const SR = 44100;
const BLOCK = 128;
const HASH_SLOTS = 4; // sections place notes in slots 0-3

function makeCore() {
  const bytes = fs.readFileSync(WASM);
  const mod = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(mod, {}).exports;
}

// Render one section: events = [{at, do: (wasm)=>...}], each fired before the
// block containing `at`. Returns hash + sanity stats over slots 0-3.
// sec.feed = {slot, freq, amp} writes a sine into the strip INPUT bus each
// block (the worklet-input path); sec.send additionally hashes the reverb
// send bus (send_ptr) so send-tap regressions are caught.
function renderSection(wasm, sec) {
  const { s: seconds, ev: events, feed, send } = sec;
  wasm.init(SR);
  const evs = [...events].sort((a, b) => a.at - b.at);
  const hash = crypto.createHash('sha256');
  const frames = Math.ceil((seconds * SR) / BLOCK) * BLOCK;
  let nan = 0, sumsq = 0, n = 0, ei = 0;
  for (let f = 0; f < frames; f += BLOCK) {
    const t = f / SR;
    while (ei < evs.length && evs[ei].at <= t) { evs[ei].do(wasm); ei++; }
    if (feed) {
      for (let ch = 0; ch < 2; ch++) {
        const iv = new Float32Array(wasm.memory.buffer, wasm.in_ptr(feed.slot, ch), BLOCK);
        for (let i = 0; i < BLOCK; i++) iv[i] = Math.sin(2 * Math.PI * feed.freq * (t + i / SR)) * feed.amp;
      }
    }
    wasm.process(t, BLOCK);
    for (let slot = 0; slot < HASH_SLOTS; slot++) {
      for (let ch = 0; ch < 2; ch++) {
        const v = new Float32Array(wasm.memory.buffer, wasm.out_ptr(slot, ch), BLOCK);
        hash.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        for (let i = 0; i < BLOCK; i++) {
          const x = v[i];
          if (x !== x) nan++; else { sumsq += x * x; n++; }
        }
      }
    }
    if (send) {
      for (let ch = 0; ch < 2; ch++) {
        const v = new Float32Array(wasm.memory.buffer, wasm.send_ptr(ch), BLOCK);
        hash.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        for (let i = 0; i < BLOCK; i++) {
          const x = v[i];
          if (x !== x) nan++; else { sumsq += x * x; n++; }
        }
      }
    }
  }
  return { hash: hash.digest('hex').slice(0, 16), rms: Math.sqrt(sumsq / n), nan };
}

// ---- event helpers ---------------------------------------------------------
// Notes start 50 ms after their event fires (a real scheduled lead, so the
// envelope isn't born mid-block). opts.slot routes to a layer slot (0-3).
const N = (at, kind, opts = {}) => ({
  at,
  do: (w) => w.note(opts.slot ?? 0, kind, opts.f ?? 220, opts.vel ?? 0.7,
    opts.pan ?? 0, opts.start ?? (at + 0.05),
    opts.dur ?? 0.4, opts.a ?? 0.01, opts.d ?? 0.12, opts.s ?? 0.7, opts.r ?? 0.25,
    opts.detune ?? 0, opts.p0 ?? 0, opts.tag ?? 0),
});
// Design note: dp = sparse {paramIndex: value} staged into PARAMS, then
// note_ex. Off-sentinels (-1) are pre-set for harm/idx/lfo1/lfo2/env2.
const D = (at, kind, dp, opts = {}) => ({
  at,
  do: (w) => {
    const view = new Float32Array(w.memory.buffer, w.params_ptr(), 64);
    view.fill(0);
    view[16] = -1; view[17] = -1; view[18] = -1; view[20] = -1; view[22] = -1;
    for (const [k, v] of Object.entries(dp)) view[+k] = v;
    w.note_ex(opts.slot ?? 0, kind, opts.f ?? 220, opts.vel ?? 0.7,
      opts.pan ?? 0, opts.start ?? (at + 0.05),
      opts.dur ?? 0.6, opts.a ?? 0.01, opts.d ?? 0.12, opts.s ?? 0.7, opts.r ?? 0.25,
      opts.detune ?? 0, opts.p0 ?? 0, opts.tag ?? 0);
  },
});

// dp fragment: mod-matrix flag + lfo1 {shape,rate} + one route lfo1→dest.
const lfo1Route = (shape, rate, dest, amount) =>
  ({ 0: 32, 18: shape, 19: rate, 30: 1, 31: 0, 32: dest, 33: amount });

// Strip command event: fires wasm[fn](...args) at `at`.
const S = (at, fn, ...args) => ({ at, do: (w) => w[fn](...args) });
// Enable strip 0 (and optionally others) at t=0.
const EN = (...slots) => slots.map((sl) => S(0, 'strip_enable', sl, 1));

// ---- the script ------------------------------------------------------------
// Section values are fixed forever — edit ONLY when deliberately changing
// coverage, and re-baseline in the same commit.
const SECTIONS = {
  // every voice kind, notes spread across slots/pans/registers
  'kind-sine':   { s: 1.2, ev: [N(0, 0), N(0.4, 0, { f: 440, pan: 0.5, slot: 1 })] },
  'kind-fm':     { s: 1.2, ev: [N(0, 1), N(0.4, 1, { f: 110, pan: -0.5, slot: 2 })] },
  'kind-bass':   { s: 1.2, ev: [N(0, 2, { f: 65 }), N(0.4, 2, { f: 98, slot: 1 })] },
  'kind-bell':   { s: 1.6, ev: [N(0, 3, { f: 523 }), N(0.4, 3, { f: 660, pan: 0.3, slot: 3 })] },
  'kind-xylo':   { s: 1.2, ev: [N(0, 4, { f: 523 }), N(0.3, 4, { f: 784, slot: 1 })] },
  'kind-am':     { s: 1.2, ev: [N(0, 5), N(0.4, 5, { f: 330, slot: 2 })] },
  'kind-pad':    { s: 2.2, ev: [N(0, 6, { dur: 1.5 }), N(0, 6, { f: 277, dur: 1.5, pan: -0.4, slot: 1 })] },
  'kind-duo':    { s: 1.4, ev: [N(0, 7), N(0.4, 7, { f: 294, slot: 1 })] },
  'kind-noise':  { s: 1.4, ev: [N(0, 8, { p0: 0 }), N(0.4, 8, { p0: 1, slot: 1 }), N(0.8, 8, { p0: 2, slot: 2 })] },
  'kind-kick':   { s: 1.2, ev: [N(0, 9, { f: 55 }), N(0.5, 9, { f: 41, slot: 1 })] },
  'kind-metal':  { s: 1.4, ev: [N(0, 10, { f: 200 })] },
  'kind-pluck':  { s: 1.8, ev: [N(0, 11, { f: 262 }), N(0.4, 11, { f: 131, slot: 1 })] },
  'kind-wt':     { s: 1.2, ev: [N(0, 12)] },
  'kind-waves':  { s: 1.8, ev: [N(0, 13, { p0: 0 }), N(0.3, 13, { p0: 1, slot: 1 }), N(0.6, 13, { p0: 2, slot: 2 }), N(0.9, 13, { p0: 3, slot: 3 }), N(1.2, 13, { p0: 4 })] },
  // detune (cents offset applied at note build)
  'note-detune': { s: 1.2, ev: [N(0, 0, { detune: 0 }), N(0, 0, { detune: 12, slot: 1 })] },
  // design features (kind 13 sawtooth = richest filter fodder, unless noted)
  'design-filter-lp-env': { s: 1.4, ev: [D(0, 13, { 0: 3, 1: 0, 2: 800, 3: 4, 4: 60, 6: 0.005, 7: 0.3, 8: 0.3, 9: 0.3 }, { p0: 2 })] },
  'design-filter-hp':     { s: 1.2, ev: [D(0, 13, { 0: 1, 1: 1, 2: 1200, 3: 2 }, { p0: 2 })] },
  'design-filter-bp':     { s: 1.2, ev: [D(0, 13, { 0: 1, 1: 2, 2: 900, 3: 3 }, { p0: 2 })] },
  'design-lfo-sine-cutoff': { s: 1.6, ev: [D(0, 13, Object.assign(lfo1Route(0, 2.5, 1, 0.5), { 0: 33, 1: 0, 2: 900, 3: 3 }), { p0: 2, dur: 1.2 })] },
  'design-lfo-tri-cutoff':  { s: 1.6, ev: [D(0, 13, Object.assign(lfo1Route(1, 3, 1, 0.4), { 0: 33, 1: 0, 2: 1000, 3: 2 }), { p0: 2, dur: 1.2 })] },
  'design-lfo-saw-cutoff':  { s: 1.6, ev: [D(0, 13, Object.assign(lfo1Route(2, 2, 1, 0.4), { 0: 33, 1: 0, 2: 1000, 3: 2 }), { p0: 2, dur: 1.2 })] },
  'design-lfo-sq-amp':      { s: 1.4, ev: [D(0, 13, lfo1Route(3, 4, 3, 0.6), { p0: 1, dur: 1.0 })] },
  'design-lfo-smooth-cutoff': { s: 1.6, ev: [D(0, 13, Object.assign(lfo1Route(4, 1.5, 1, 0.45), { 0: 33, 1: 0, 2: 1200, 3: 2 }), { p0: 2, dur: 1.2 })] },
  'design-lfo-sharp-cutoff':  { s: 1.6, ev: [D(0, 13, Object.assign(lfo1Route(5, 3, 1, 0.45), { 0: 33, 1: 0, 2: 1200, 3: 2 }), { p0: 2, dur: 1.2 })] },
  'design-lfo-pitch': { s: 1.4, ev: [D(0, 0, lfo1Route(0, 5.5, 0, 0.15), { dur: 1.0 })] },
  'design-lfo-pan':   { s: 1.4, ev: [D(0, 0, lfo1Route(1, 1.5, 4, 0.8), { dur: 1.0 })] },
  'design-lfo2':      { s: 1.6, ev: [D(0, 13, { 0: 33, 1: 0, 2: 1000, 3: 2, 20: 0, 21: 6, 30: 1, 31: 1, 32: 1, 33: 0.4 }, { p0: 2, dur: 1.2 })] },
  'design-env2-cutoff': { s: 1.8, ev: [D(0, 13, { 0: 33, 1: 0, 2: 400, 3: 2, 22: 0.8, 23: 0.4, 24: 0.6, 25: 0.6, 30: 1, 31: 2, 32: 1, 33: 0.7 }, { p0: 2, dur: 1.4 })] },
  'design-vel-route':   { s: 1.2, ev: [D(0, 13, { 0: 33, 1: 0, 2: 500, 3: 2, 30: 1, 31: 3, 32: 1, 33: 0.8 }, { p0: 2, vel: 0.9 })] },
  'design-macro-cutoff': { s: 1.2, ev: [D(0, 13, { 0: 33, 1: 0, 2: 500, 3: 2, 26: 0.8, 30: 1, 31: 4, 32: 1, 33: 0.9 }, { p0: 2 })] },
  'design-multi-route': { s: 1.6, ev: [D(0, 13, { 0: 33, 1: 0, 2: 900, 3: 3, 18: 0, 19: 3, 30: 3, 31: 0, 32: 1, 33: 0.4, 34: 0, 35: 0, 36: 0.08, 37: 0, 38: 3, 39: 0.3 }, { p0: 2, dur: 1.2 })] },
  'design-unison':  { s: 1.4, ev: [D(0, 13, { 0: 16, 10: 6, 11: 40 }, { p0: 2 })] },
  'design-sub':     { s: 1.4, ev: [D(0, 13, { 0: 4, 12: 0.7, 13: 0 }, { p0: 0 }), D(0.5, 13, { 0: 4, 12: 0.7, 13: 1 }, { p0: 0, slot: 1 })] },
  'design-ring':    { s: 1.4, ev: [D(0, 0, { 0: 8, 14: 0.5, 15: 2.5 })] },
  'design-fm-override': { s: 1.4, ev: [D(0, 1, { 16: 5, 17: 14 })] },
  'design-kitchen-sink': { s: 2.0, ev: [D(0, 13, Object.assign(lfo1Route(0, 2, 1, 0.4), {
    0: 63, 1: 0, 2: 1000, 3: 3, 4: 40, 6: 0.01, 7: 0.4, 8: 0.4, 9: 0.4,
    10: 4, 11: 30, 12: 0.4, 13: 1, 14: 0.3, 15: 2,
  }), { p0: 2, dur: 1.4 })] },
  // lifecycle
  'life-hold-bend-release': { s: 1.8, ev: [
    N(0, 0, { dur: -1, tag: 7 }),
    { at: 0.5, do: (w) => w.bend_tag(7, 200) },
    { at: 1.1, do: (w) => w.release_tag(7, 0.2) },
  ] },
  // one future note per slot; cancel_from(1, 0.5) must silence ONLY slot 1
  'life-cancel-from': { s: 1.4, ev: [
    N(0, 0, { start: 0.6, dur: 0.4 }),
    N(0, 0, { start: 0.6, dur: 0.4, f: 330, slot: 1 }),
    { at: 0.2, do: (w) => w.cancel_from(1, 0.5) },
  ] },
  // two playing notes; stop_before(0, 0.6) fast-releases ONLY slot 0
  'life-stop-before': { s: 1.4, ev: [
    N(0, 0, { dur: 2 }),
    N(0, 0, { f: 330, dur: 2, slot: 1 }),
    { at: 0.7, do: (w) => w.stop_before(0, 0.6) },
  ] },
  'life-stop-all': { s: 1.0, ev: [
    N(0, 1, { dur: 2 }), N(0, 2, { f: 65, dur: 2, slot: 1 }),
    { at: 0.6, do: (w) => w.stop_all() },
  ] },
  // 300 overlapping notes force voice stealing (MAX_VOICES=256)
  'life-steal': { s: 1.6, ev: Array.from({ length: 300 }, (_, i) =>
    N(i * 0.004, 0, { f: 100 + (i % 40) * 10, dur: 0.8, vel: 0.3, slot: i % 4 })) },
  // ==== Phase 2: per-slot strips + FX ====
  // worklet-input mixing: no notes, a fed sine through the enabled strip's vcf
  'strip-input-passthrough': { s: 0.8, feed: { slot: 0, freq: 220, amp: 0.5 }, ev: EN(0) },
  // level + scheduled gate ramps (down at 0.4 over 0.1 s, back up at 0.8)
  'strip-level-gate': { s: 1.4, ev: [...EN(0), N(0, 13, { p0: 2, dur: 1.2 }),
    S(0, 'strip_setv', 0, 1, 0.5),
    S(0.35, 'strip_rampv', 0, 0, 0.4, -1e6, 0.0, 0.1),
    S(0.75, 'strip_rampv', 0, 0, 0.8, -1e6, 1.0, 0.1)] },
  // strip panner stereo law (hard-ish left)
  'strip-pan': { s: 1.0, ev: [...EN(0), N(0, 0), S(0, 'strip_setv', 0, 3, -0.7)] },
  // pan LFO (the arp-spread rig) SUMS with base pan
  'strip-pan-mod': { s: 1.4, ev: [...EN(0), N(0, 0, { dur: 1.2 }), S(0, 'strip_mod', 0, 2, 0, 1.5, -0.8, 0.8, 0)] },
  // vca mod: sine dip (range [-0.6, 0] on base 1) and sharp (S&H) determinism
  'strip-vca-lfo':   { s: 1.4, ev: [...EN(0), N(0, 13, { p0: 1, dur: 1.2 }), S(0, 'strip_mod', 0, 0, 0, 4, -0.6, 0, 0)] },
  'strip-vca-sharp': { s: 1.4, ev: [...EN(0), N(0, 13, { p0: 1, dur: 1.2 }), S(0, 'strip_mod', 0, 0, 5, 6, -0.8, 0, 0)] },
  // vcf mod: LFO carries the absolute cutoff (floor..20000)
  'strip-vcf-lfo': { s: 1.6, ev: [...EN(0), N(0, 13, { p0: 2, dur: 1.4 }), S(0, 'strip_mod', 0, 1, 0, 2, 300, 20000, 0)] },
  // vcf mod from a 64-point staged curve (the 'seq'/'custom' shapes)
  'strip-vcf-curve': { s: 1.6, ev: [...EN(0), N(0, 13, { p0: 2, dur: 1.4 }), {
    at: 0, do: (w) => {
      const pv = new Float32Array(w.memory.buffer, w.params_ptr(), 64);
      for (let i = 0; i < 64; i++) pv[i] = (i % 16) / 15; // rising 16-step staircase ×4
      w.strip_mod(0, 1, 6, 1.25, 400, 8000, 1);
    },
  }] },
  // EQ3 bands −12/+6/−6 dB on noise (broadband makes crossovers visible)
  'strip-eq': { s: 1.2, ev: [...EN(0), N(0, 8, { p0: 0, dur: 1.0 }), S(0, 'strip_eq', 0, -12, 6, -6)] },
  // trance gate: 8 steps/bar, pattern 10110101, full depth, 6 ms edges
  'strip-tg': { s: 1.6, ev: [...EN(0), N(0, 13, { p0: 2, dur: 1.4 }),
    S(0, 'strip_tg', 0, 1, 8, 0b10110101, 0, 1.0, 0.006, 0.0, 1.0)] },
  // reverb send tap (post-level, pre-gate) — hashes the SEND bus too
  'strip-revsend': { s: 1.2, send: true, ev: [...EN(0), N(0, 0, { dur: 0.8 }),
    S(0, 'strip_setv', 0, 2, 0.6), S(0, 'strip_setv', 0, 1, 0.8)] },
  // FX, one at a time on a saw
  'strip-fx-dist':     { s: 1.2, ev: [...EN(0), N(0, 13, { p0: 2, dur: 1.0 }), S(0, 'strip_dist', 0, 1, 0.6, 0.8)] },
  'strip-fx-chorus':   { s: 1.4, ev: [...EN(0), N(0, 13, { p0: 2, dur: 1.2 }), S(0, 'strip_chorus', 0, 1, 0.7, 0.7, 1.5)] },
  'strip-fx-phaser':   { s: 1.4, ev: [...EN(0), N(0, 13, { p0: 2, dur: 1.2 }), S(0, 'strip_phaser', 0, 1, 0.8, 3, 0.9)] },
  'strip-fx-delay':    { s: 1.6, ev: [...EN(0), N(0, 0, { dur: 0.15 }), S(0, 'strip_delay', 0, 1, 0, 0.5, 0.25, 0.4)] },
  'strip-fx-pingpong': { s: 1.6, ev: [...EN(0), N(0, 0, { dur: 0.15 }), S(0, 'strip_delay', 0, 1, 1, 0.5, 0.25, 0.4)] },
  'strip-fx-autopan':  { s: 1.4, ev: [...EN(0), N(0, 13, { p0: 1, dur: 1.2 }), S(0, 'strip_autopan', 0, 1, 1.0, 1.0, 2)] },
  // live stereo width: two hard-panned voices (real side content), width
  // ramped 1 → 0.15 mid-note (the spread fader's real-time morph)
  'strip-width': { s: 1.4, ev: [...EN(0),
    N(0, 0, { pan: -0.8, dur: 1.2 }), N(0, 0, { f: 330, pan: 0.8, dur: 1.2 }),
    S(0.5, 'strip_rampv', 0, 4, 0.55, -1e6, 0.15, 0.2)] },
  // everything at once across two slots, input feed + send hashed
  'strip-kitchen-sink': { s: 2.0, send: true, feed: { slot: 1, freq: 330, amp: 0.3 }, ev: [
    ...EN(0, 1),
    N(0, 13, { p0: 2, dur: 1.6 }), N(0.2, 2, { f: 65, dur: 1.2, slot: 1 }),
    S(0, 'strip_setv', 0, 1, 0.7), S(0, 'strip_setv', 0, 2, 0.4),
    S(0, 'strip_mod', 0, 1, 0, 1.5, 500, 12000, 0),
    S(0, 'strip_eq', 0, 4, -3, 2),
    S(0, 'strip_tg', 0, 1, 16, 0b1011010110110101, 0, 0.8, 0.004, 0.0, 2.0),
    S(0, 'strip_dist', 0, 1, 0.3, 0.5), S(0, 'strip_delay', 0, 1, 1, 0.35, 0.3, 0.45),
    S(0, 'strip_setv', 1, 3, 0.5), S(0, 'strip_mod', 1, 0, 1, 3, -0.5, 0, 0),
    S(0, 'strip_chorus', 1, 1, 0.6, 0.6, 2), S(0, 'strip_autopan', 1, 1, 0.7, 0.8, 1.2),
    S(1.2, 'strip_rampv', 0, 0, 1.25, -1e6, 0.0, 0.3),
  ] },
};

// ---- run --------------------------------------------------------------------
function renderAll(wasm) {
  const out = {};
  for (const [name, sec] of Object.entries(SECTIONS)) out[name] = renderSection(wasm, sec);
  return out;
}

const update = process.argv.includes('--update');
const wasm = makeCore();

const pass1 = renderAll(wasm);
let sane = true;
for (const [name, r] of Object.entries(pass1)) {
  const problems = [];
  if (r.nan > 0) problems.push(`${r.nan} NaN samples`);
  if (r.rms < 1e-4) problems.push(`silent (rms ${r.rms.toExponential(2)})`);
  if (problems.length) { sane = false; console.error(`✗ ${name}: ${problems.join(', ')}`); }
}

// determinism self-check — same wasm instance, full second pass
const pass2 = renderAll(wasm);
for (const name of Object.keys(SECTIONS)) {
  if (pass1[name].hash !== pass2[name].hash) {
    sane = false;
    console.error(`✗ ${name}: NON-DETERMINISTIC (${pass1[name].hash} vs ${pass2[name].hash}) — init() left state behind`);
  }
}

const hashes = Object.fromEntries(Object.entries(pass1).map(([k, r]) => [k, r.hash]));

if (update) {
  if (!sane) { console.error('\nrefusing to baseline a failing render'); process.exit(1); }
  fs.writeFileSync(BASELINE, JSON.stringify(hashes, null, 1) + '\n');
  console.log(`baseline written: ${Object.keys(hashes).length} sections → ${path.relative(process.cwd(), BASELINE)}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error('no baseline — run with --update to create one');
  process.exit(1);
}
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
let drift = 0;
for (const [name, hash] of Object.entries(hashes)) {
  if (!(name in base)) { console.error(`± ${name}: NEW section (not in baseline)`); drift++; }
  else if (base[name] !== hash) { console.error(`✗ ${name}: audio changed (${base[name]} → ${hash})`); drift++; }
}
for (const name of Object.keys(base)) {
  if (!(name in hashes)) { console.error(`± ${name}: section REMOVED from script`); drift++; }
}
if (drift || !sane) {
  console.error(`\nGOLDEN RENDER FAILED: ${drift} drifted, sanity ${sane ? 'ok' : 'FAILED'}. If the audio change is intentional, re-baseline with --update and commit the new baseline WITH the DSP change.`);
  process.exit(1);
}
console.log(`GOLDEN RENDER: ✓ all ${Object.keys(hashes).length} sections bit-identical to baseline`);
