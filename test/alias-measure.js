// =============================================================================
// ALIASING MEASUREMENT for the core saturation stages.
//
// A waveshaper multiplies harmonics. Any harmonic above Nyquist FOLDS BACK to
// (sr - f), landing at a frequency that is NOT a multiple of the fundamental —
// an inharmonic whistle that moves the wrong way when you play a scale. That is
// the "digital harshness" oversampling exists to prevent, and the core does no
// oversampling at all.
//
// Method: feed a pure sine, render, FFT, and split the spectrum into
//   · harmonic bins  (within a few bins of k*f0)
//   · everything else (aliases + noise)
// Reported as ALIAS-TO-SIGNAL: 10*log10(alias energy / harmonic energy). More
// negative is cleaner. Run before and after a DSP change to prove it improved.
//
//   node test/alias-measure.js            → table for every mode
//   node test/alias-measure.js --json     → machine-readable, for diffing
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, '..', 'js', 'bloops', 'core', 'bloops-dsp.wasm');
const SR = 44100, BLOCK = 128;
const MODES = ['classic', 'overdrive', 'fuzz', 'fold', 'crush'];

function core() {
  return new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(WASM)), {}).exports;
}

// Real FFT via a straightforward radix-2 — no dependencies, and N is small.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

// Render `f0` through one distortion mode and return the output samples.
function render(mode, f0, amount, seconds = 0.5) {
  const w = core();
  w.init(SR);
  w.strip_enable(0, 1);                 // the strip must be ON or it passes nothing
  w.strip_mainout(0, 1.0);
  w.strip_dist(0, 1, amount, 1.0, MODES.indexOf(mode), 0, 0);
  const frames = Math.ceil((seconds * SR) / BLOCK) * BLOCK;
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f += BLOCK) {
    const t = f / SR;
    for (let ch = 0; ch < 2; ch++) {
      const iv = new Float32Array(w.memory.buffer, w.in_ptr(0, ch), BLOCK);
      for (let i = 0; i < BLOCK; i++) iv[i] = Math.sin(2 * Math.PI * f0 * (t + i / SR)) * 0.5;
    }
    w.process(t, BLOCK);
    const ov = new Float32Array(w.memory.buffer, w.out_ptr(0, 0), BLOCK);
    out.set(ov, f);
  }
  return out;
}

// alias-to-signal ratio in dB
function aliasRatio(samples, f0) {
  const N = 16384;
  const start = samples.length - N;            // skip the attack/settling
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const wnd = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));   // Hann
    re[i] = samples[start + i] * wnd;
  }
  fft(re, im);
  const binHz = SR / N;
  const isHarmonic = (bin) => {
    const f = bin * binHz;
    if (f < 20) return true;                    // DC/rumble is not aliasing
    const k = Math.round(f / f0);
    return k >= 1 && Math.abs(f - k * f0) <= binHz * 3;
  };
  let harm = 0, alias = 0;
  for (let b = 1; b < N / 2; b++) {
    const p = re[b] * re[b] + im[b] * im[b];
    if (isHarmonic(b)) harm += p; else alias += p;
  }
  return { db: 10 * Math.log10(alias / Math.max(harm, 1e-30)), harm, alias };
}

const CASES = [];
for (const mode of MODES) for (const f0 of [1000, 3000, 5000]) for (const amt of [0.5, 1.0]) CASES.push({ mode, f0, amt });

const rows = CASES.map(c => {
  const out = render(c.mode, c.f0, c.amt);
  let peak = 0; for (const x of out) peak = Math.max(peak, Math.abs(x));
  const r = aliasRatio(out, c.f0);
  return { ...c, aliasDb: +r.db.toFixed(1), peak: +peak.toFixed(3) };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  console.log('ALIAS-TO-SIGNAL (dB) — more negative is cleaner. 0.5 s sine, full wet.\n');
  console.log('mode        drive   1 kHz    3 kHz    5 kHz');
  for (const mode of MODES) {
    for (const amt of [0.5, 1.0]) {
      const pick = (f) => { const r = rows.find(x => x.mode === mode && x.f0 === f && x.amt === amt); return r ? String(r.aliasDb).padStart(7) : '      ?'; };
      console.log(`${mode.padEnd(11)} ${String(amt).padEnd(6)} ${pick(1000)}  ${pick(3000)}  ${pick(5000)}`);
    }
  }
  const worst = rows.slice().sort((a, b) => b.aliasDb - a.aliasDb)[0];
  console.log(`\nworst: ${worst.mode} @ ${worst.f0} Hz drive ${worst.amt} → ${worst.aliasDb} dB`);
}
