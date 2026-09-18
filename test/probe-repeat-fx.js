// PROBE — FX on the delay's repeats only, measured in the DSP itself.
//
// Asked for as: "for time-based FX like delay, I want to be able to apply FX to
// just the repeats, independently of the main FX chain." Chain order cannot
// express that — this runs INSIDE the feedback loop, so the dry note is
// untouched and every pass applies it again.
//
// Driven against the wasm directly (the same instantiation golden-render uses),
// because an OFFLINE render falls back to the node engine and would never
// exercise the core path at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, '..', 'js', 'bloops', 'core', 'bloops-dsp.wasm');
const SR = 48000, BLOCK = 128, SLOT = 0;
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};

const core = () => new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(WASM)), {}).exports;

// One impulse in, a half-second delay with heavy feedback, then listen.
// `dlyfx` is the only thing that differs between the two renders.
function render(dfx) {
  const w = core();
  w.init(SR);
  w.strip_enable(SLOT, 1);
  w.strip_mainout(SLOT, 1);
  // delay: on, no ping, FULL wet so the dry and the repeats are separable in
  // time; 0.1 s spacing, strong feedback so there are several repeats to hear.
  w.strip_delay(SLOT, 1, 0, 1.0, 0.1, 0.8, 0);
  if (dfx) w.strip_dlyfx(SLOT, 1, dfx.drive | 0, dfx.damp | 0);
  const secs = 0.6, frames = Math.ceil((secs * SR) / BLOCK) * BLOCK;
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f += BLOCK) {
    const t = f / SR;
    const iv = new Float32Array(w.memory.buffer, w.in_ptr(SLOT, 0), BLOCK);
    const iv1 = new Float32Array(w.memory.buffer, w.in_ptr(SLOT, 1), BLOCK);
    iv.fill(0); iv1.fill(0);
    // a single short burst at the very start = the "dry note"
    if (f === 0) for (let i = 0; i < 64; i++) {
      // A BRIGHT burst (2 kHz). At 220 Hz a one-pole lowpass barely bites, so
      // "each repeat is damped again" measured as a 3% drop and read as noise;
      // the claim is about the loop, and the source has to be able to show it.
      const v = Math.sin(2 * Math.PI * 2000 * (i / SR)) * 0.9;
      iv[i] = v; iv1[i] = v;
    }
    w.process(t, BLOCK);
    const ov = new Float32Array(w.memory.buffer, w.out_ptr(SLOT, 0), BLOCK);
    out.set(ov.subarray(0, Math.min(BLOCK, frames - f)), f);
  }
  return out;
}

const rms = (a, from, to) => {
  let s = 0, n = 0;
  for (let i = from; i < to && i < a.length; i++) { s += a[i] * a[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
};
const diff = (a, b, from, to) => {
  let d = 0;
  for (let i = from; i < to && i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};

const clean = render(null);
const driven = render({ drive: 85, damp: 0 });
const damped = render({ drive: 0, damp: 85 });

// the dry burst is the first 64 samples; the first repeat lands ~0.1 s later
const DRY_END = 64;
const R1 = Math.round(0.1 * SR), R2 = Math.round(0.2 * SR), R3 = Math.round(0.3 * SR);

ok('the stage is present in the core', typeof core().strip_dlyfx === 'function');
ok('a render with no repeat FX still produces repeats',
  rms(clean, R1, R1 + 2000) > 1e-4 && rms(clean, R3, R3 + 2000) > 1e-5,
  'r1=' + rms(clean, R1, R1 + 2000).toFixed(6) + ' r3=' + rms(clean, R3, R3 + 2000).toFixed(6));

// THE WHOLE POINT: the dry note must be bit-identical, the repeats must not be.
ok('the DRY note is untouched — sample-for-sample',
  diff(clean, driven, 0, DRY_END) === 0 && diff(clean, damped, 0, DRY_END) === 0,
  'drive Δ=' + diff(clean, driven, 0, DRY_END) + ' damp Δ=' + diff(clean, damped, 0, DRY_END));
ok('…and the REPEATS are shaped by Repeat drive',
  diff(clean, driven, R1, R1 + 2000) > 1e-3,
  'Δ=' + diff(clean, driven, R1, R1 + 2000).toExponential(3));
ok('…and by Repeat damp',
  diff(clean, damped, R1, R1 + 2000) > 1e-3,
  'Δ=' + diff(clean, damped, R1, R1 + 2000).toExponential(3));

// PROGRESSIVE: it runs inside the loop, so repeat 3 has been through it three
// times and must differ from clean by MORE than repeat 1 does, relative to the
// signal that is there. Damp is the clean measure of this (it only removes).
const rel = (a, from) => {
  const c = rms(clean, from, from + 2000);
  return c > 0 ? rms(a, from, from + 2000) / c : 0;
};
const d1 = rel(damped, R1), d3 = rel(damped, R3);
ok('it is INSIDE the loop — each repeat is shaped again, so the tail dissolves',
  d3 < d1 * 0.75 && d1 < 1, 'repeat1 ratio=' + d1.toFixed(4) + '  repeat3 ratio=' + d3.toFixed(4) +
  ' (a stage AFTER the delay would damp every repeat equally — the two ratios would match)');

// 0 is neutral — the whole reason golden stays green
const zeroed = render({ drive: 0, damp: 0 });
ok('drive 0 + damp 0 is EXACTLY the untouched render',
  diff(clean, zeroed, 0, clean.length) === 0,
  'Δ=' + diff(clean, zeroed, 0, clean.length));

let nan = 0;
for (const a of [driven, damped]) for (const x of a) if (x !== x || Math.abs(x) > 8) nan++;
ok('no NaN and no runaway in the feedback path', nan === 0, 'bad samples=' + nan);

console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
