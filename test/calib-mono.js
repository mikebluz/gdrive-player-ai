// CALIBRATION — the core's `mono` (kind 15) against the Tone.MonoSynth it replaces.
//
// 2026-09-29 audit: `mono` was the only node-only voice in a measured project
// (~50 WebAudio nodes and ~2 ms of main thread per note). The core renders it as
// kind 2's topology with a saw; this harness renders BOTH and compares them, so
// the swap is a measured match rather than a guess — the same bar every core
// kind cleared (bass: nominal Q 4 was +11 dB hot; the calibrated 1.6 is ≤1 dB).
//
// Tone side: the app's exact MonoSynth options, rendered with Tone.Offline in
// Chrome. Core side: bloops-dsp.wasm driven directly in Node (as golden-render
// does). Compared per 85 ms frame: overall level, and every harmonic's level.
// Sweeps the core's per-section Q (set_mono_q) and reports the best.
//
//   node test/calib-mono.js            (needs `npm start` for Tone)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, '..', 'js', 'bloops', 'core', 'bloops-dsp.wasm');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const SR = 48000;
// lead synth's own envelope (a 400 / d 200 / s 80% / r 1200) and a fast one
const CASES = [
  { name: 'A2 110 Hz, lead-synth env', f: 110, a: 0.4, d: 0.2, s: 0.8, r: 1.2, dur: 1.0, vel: 0.8 },
  { name: 'A3 220 Hz, lead-synth env', f: 220, a: 0.4, d: 0.2, s: 0.8, r: 1.2, dur: 1.0, vel: 0.8 },
  { name: 'A4 440 Hz, lead-synth env', f: 440, a: 0.4, d: 0.2, s: 0.8, r: 1.2, dur: 1.0, vel: 0.8 },
  { name: 'A3 220 Hz, fast attack',    f: 220, a: 0.005, d: 0.1, s: 0.5, r: 0.4, dur: 0.6, vel: 0.8 },
];
const SECS = 3.0, START = 0.05;

async function renderTone() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 300000 });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2000));
  const out = await page.evaluate(async (CASES, SECS, START, SR) => {
    const res = [];
    for (const c of CASES) {
      const buf = await Tone.Offline(() => {
        // EXACTLY the app's `mono` (04-instruments-samples `_playNoteNow`)
        const s = new Tone.MonoSynth({
          oscillator: { type: 'sawtooth' },
          envelope: { attack: c.a, decay: c.d, sustain: c.s, release: c.r },
          filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.3, release: 2, baseFrequency: 200, octaves: 3 },
          filter: { Q: 6, type: 'lowpass', rolloff: -24 },
        }).toDestination();
        s.triggerAttackRelease(c.f, c.dur, START, c.vel);
      }, SECS, 1, SR);
      res.push(Array.from(buf.getChannelData(0)));
    }
    return res;
  }, CASES, SECS, START, SR);
  await browser.close();
  return out.map((a) => Float32Array.from(a));
}

function renderCore(c, q) {
  const w = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(WASM)), {}).exports;
  w.init(SR);
  if (q != null) w.set_mono_q(q);
  const B = 128, n = Math.ceil(SECS * SR / B) * B, out = new Float32Array(n);
  let fired = false;
  for (let f = 0; f < n; f += B) {
    if (!fired) { w.note(0, 15, c.f, c.vel, 0, START, c.dur, c.a, c.d, c.s, c.r, 0, 0, 0); fired = true; }
    w.process(f / SR, B);
    out.set(new Float32Array(w.memory.buffer, w.out_ptr(0, 0), B), f);
  }
  return out;
}

// level + harmonic magnitudes per frame (Hann, Goertzel at k·f0)
function frames(x, f0) {
  const N = 4096, H = 2048, res = [];
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  for (let s = 0; s + N <= x.length; s += H) {
    let e = 0; for (let i = 0; i < N; i++) e += x[s + i] * x[s + i];
    const rms = 10 * Math.log10(e / N + 1e-20);
    const harm = [];
    for (let k = 1; k * f0 < 10000 && k <= 30; k++) {
      const w = 2 * Math.PI * k * f0 / SR, cw = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const s0 = x[s + i] * win[i] + cw * s1 - s2; s2 = s1; s1 = s0; }
      const mag = Math.sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2) / (N / 4);
      harm.push(20 * Math.log10(mag + 1e-12));
    }
    res.push({ rms, harm });
  }
  return res;
}
function compare(tone, core, f0) {
  const A = frames(tone, f0), B = frames(core, f0);
  // A CONSTANT level offset is a GAIN (one number, calibrated separately);
  // what is left after removing it is the TONE — so the two are reported apart.
  // (Verified on kind 2, whose documented calibration matches: its raw error was
  // a steady ~3.5 dB on every frame and harmonic alike — an offset, not a shape.)
  const lvS = [], hdS = [];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i].rms < -60 && B[i].rms < -60) continue;
    lvS.push(A[i].rms - B[i].rms);
    A[i].harm.forEach((h, k) => { const g = B[i].harm[k]; if (h > -70 || g > -70) hdS.push(h - g); });
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const p90 = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.9)] : 0; };
  const off = med(lvS);
  const lv = lvS.map((d) => Math.abs(d - off)), hd = hdS.map((d) => Math.abs(d - off));
  return { offset: off, levelMax: Math.max(...lv), levelMed: med(lv), harmMed: med(hd), harmP90: p90(hd) };
}

(async () => {
  const tone = await renderTone();
  if (process.env.ABWAV) {
    // A/B for the EAR: every case back to back, Tone then core, as two WAVs
    const wav = (x, file) => { const b = Buffer.alloc(44 + x.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4);
      b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24);
      b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
      for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
      fs.writeFileSync(file, b); };
    const cat = (arr) => { const n = arr.reduce((a, x) => a + x.length, 0), o = new Float32Array(n); let k = 0; arr.forEach((x) => { o.set(x, k); k += x.length; }); return o; };
    wav(cat(tone), process.env.ABWAV + '/lead-synth-TONE.wav');
    wav(cat(CASES.map((c) => renderCore(c, null))), process.env.ABWAV + '/lead-synth-CORE.wav');
    console.log('wrote ' + process.env.ABWAV + '/lead-synth-TONE.wav and -CORE.wav');
    return;
  }
  if (process.env.DUMPF) {
    const c = CASES[1], core = renderCore(c, 2.0), A = frames(tone[1], c.f), B = frames(core, c.f);
    for (const fi of [3, 8, 15, 25]) console.log('frame ' + fi + ' (' + (fi * 2048 / SR).toFixed(2) + ' s)  TONE rms ' + A[fi].rms.toFixed(1) + ' h1-10 ' + A[fi].harm.slice(0, 10).map((x) => x.toFixed(0)).join(' ') +
      '\n                   CORE rms ' + B[fi].rms.toFixed(1) + ' h1-10 ' + B[fi].harm.slice(0, 10).map((x) => x.toFixed(0)).join(' '));
    return;
  }
  const sweep = (process.env.QS || '1.2,1.6,2.0,2.4,2.8,3.2,4,6').split(',').map(Number);
  console.log('\n  per-section Q sweep (lower is closer; dB):');
  let best = null;
  for (const q of sweep) {
    const rs = CASES.map((c, i) => compare(tone[i], renderCore(c, q), c.f));
    const score = rs.reduce((a, r) => a + r.harmMed + r.levelMed, 0) / rs.length;
    console.log('   Q ' + String(q).padEnd(4) + ' score ' + score.toFixed(2) + '   ' +
      rs.map((r) => 'lvl ' + r.levelMed.toFixed(1) + '/' + r.levelMax.toFixed(1) + ' harm ' + r.harmMed.toFixed(1) + '/' + r.harmP90.toFixed(1)).join('  |  '));
    if (!best || score < best.score) best = { q, score, rs };
  }
  console.log('\n  BEST Q ' + best.q + ' — per case (level median/max, harmonic median/p90):');
  CASES.forEach((c, i) => { const r = best.rs[i]; console.log('   ' + c.name.padEnd(28) + ' gain offset ' + r.offset.toFixed(2) + ' dB   level ' + r.levelMed.toFixed(2) + ' / ' + r.levelMax.toFixed(2) + ' dB   harmonics ' + r.harmMed.toFixed(2) + ' / ' + r.harmP90.toFixed(2) + ' dB'); });
})();
