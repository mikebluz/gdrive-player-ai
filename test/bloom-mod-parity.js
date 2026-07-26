#!/usr/bin/env node
// bloom-mod-parity.js — B2 parity harness for Bloom's per-layer mod system.
//
//   node test/bloom-mod-parity.js            # compare against the committed baseline
//   node test/bloom-mod-parity.js --update   # re-record the baseline (deliberate only)
//
// WHY: B2 plans to unify Bloom's NODE-path mod sources (_ambMakeSrc /
// _ambScheduleStochastic in 17-ambient.js — Tone.LFO for periodic shapes,
// stepped/ramped Tone.Signal for smooth/sharp/custom/seq) onto the Design
// engine's mod rig (_sdBuildModRig, 20-sound-design.js). This harness
// fingerprints what the CURRENT system actually outputs, per config, so the
// swapped implementation can be proven behaviorally identical before it
// ships. It is tolerance-based (real-time sampling has jitter), NOT
// byte-exact like the note harness.
//
// WHAT IT MEASURES (per battery config, node path — core strips forced OFF):
//   • range   — observed [min, max] of the modulation source's output.
//     This is the CONTRACT range: for vca the LFO value IS the whole gain
//     (Tone's connectSignal zeroes the param — the [-depth, 0] inverted-
//     tremolo quirk the core strips replicate); for vcf it's absolute Hz
//     (floor..20000); for vco it's ± cents (square-law tapered).
//   • period  — dominant cycle length via autocorrelation, vs the expected
//     1/_ambModRateHz(rate).
//   • fold    — a 16-bin phase-folded waveform fingerprint at the expected
//     period (compared rotation-invariantly, so LFO start phase is free).
//   • stochastic shapes (smooth/sharp) record range + step cadence only.
//
// Requires: npm start running on :3001 (same as the note-invariant harness).
// The engine is built IDLE (no playback): chains via _ambSyncMods(), stepped
// sources pumped manually with _ambScheduleStochastic(now).

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPDATE = process.argv.includes('--update');
const BASE_PATH = path.join(__dirname, 'bloom-mod-parity-baseline.json');
const URL = 'http://localhost:3001/bloops.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ---- battery ---------------------------------------------------------------
// rate 70 → ~1.33 Hz free (≈0.75 s period): several cycles inside the window.
const SAMPLE_SEC = 3.2;
const BATTERY = [
  { id: 'vca-sine',     target: 'vca', mod: { shape: 'sine',     rate: 70, depth: 60 } },
  { id: 'vca-square',   target: 'vca', mod: { shape: 'square',   rate: 70, depth: 100 } },
  { id: 'vca-rampdown', target: 'vca', mod: { shape: 'rampdown', rate: 70, depth: 50 } },
  { id: 'vca-tri-slow', target: 'vca', mod: { shape: 'triangle', rate: 60, depth: 80 } },
  { id: 'vcf-sine',     target: 'vcf', mod: { shape: 'sine',     rate: 70, depth: 60 } },
  { id: 'vcf-saw-full', target: 'vcf', mod: { shape: 'sawtooth', rate: 70, depth: 100 } },
  { id: 'vco-sine',     target: 'vco', mod: { shape: 'sine',     rate: 70, depth: 50 } },
  { id: 'vca-custom',   target: 'vca', mod: { shape: 'custom',   rate: 70, depth: 60, partials: [100, 60, 0, 30] } },
  { id: 'vca-sharp',    target: 'vca', mod: { shape: 'sharp',    rate: 80, depth: 60 }, stochastic: true },
];

// ---- tolerances (fraction of the config's own span unless noted) -----------
const TOL = {
  range: 0.05,     // each endpoint within 5% of span
  period: 0.06,    // ±6% of expected period
  fold: 0.10,      // best-rotation mean-abs-error of the 16-bin fold
  stepIv: 0.30,    // stochastic step cadence within ±30%
};

async function main() {
  let puppeteer;
  try { puppeteer = (await import('puppeteer-core')).default; } catch (e) {
    console.error('puppeteer-core not installed (npm i)'); process.exit(1);
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const pageErrs = [];
  page.on('pageerror', e => pageErrs.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof Tone !== "undefined" && typeof _ambSyncMods === "function"', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  const results = {};
  for (const cfg of BATTERY) {
    results[cfg.id] = await page.evaluate(measureOne, cfg, SAMPLE_SEC);
    // teardown between configs so each starts from a clean chain
    await page.evaluate(() => { try { _ambTeardownMods(); } catch (e) {} });
  }
  await browser.close();

  if (pageErrs.length) {
    console.error('PAGE ERRORS:', pageErrs.join(' | '));
    process.exit(1);
  }
  for (const [id, r] of Object.entries(results)) {
    if (r && r.error) { console.error(`✗ ${id}: measurement failed — ${r.error}`); process.exit(1); }
  }

  if (UPDATE) {
    fs.writeFileSync(BASE_PATH, JSON.stringify({ recorded: new Date().toISOString(), sampleSec: SAMPLE_SEC, results }, null, 1));
    console.log(`MOD PARITY: baseline recorded → ${path.basename(BASE_PATH)} (${Object.keys(results).length} configs)`);
    return;
  }

  if (!fs.existsSync(BASE_PATH)) {
    console.error('No baseline. Run with --update first (and commit the JSON).');
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8')).results;
  let fails = 0;
  for (const cfg of BATTERY) {
    const b = base[cfg.id], r = results[cfg.id];
    if (!b) { console.error(`✗ ${cfg.id}: missing from baseline`); fails++; continue; }
    const issues = [];
    if (cfg.stochastic) {
      // Random draws: observed extremes are order statistics — check the
      // engine-declared range CONTAINS the observations and they COVER most
      // of it, plus the step cadence.
      const cs = Math.max(1e-9, b.rangeHi - b.rangeLo);
      if (r.min < b.rangeLo - 0.02 * cs || r.max > b.rangeHi + 0.02 * cs) issues.push(`escaped range [${r.min.toFixed(3)}, ${r.max.toFixed(3)}] vs [${b.rangeLo.toFixed(3)}, ${b.rangeHi.toFixed(3)}]`);
      if ((r.max - r.min) < 0.5 * cs) issues.push(`coverage ${(r.max - r.min).toFixed(3)} < half of ${cs.toFixed(3)}`);
      if (b.stepIv && Math.abs(r.stepIv - b.stepIv) > TOL.stepIv * b.stepIv) issues.push(`stepIv ${r.stepIv.toFixed(3)} vs ${b.stepIv.toFixed(3)}`);
    } else {
      const span = Math.max(1e-9, b.max - b.min);
      if (Math.abs(r.min - b.min) > TOL.range * span) issues.push(`min ${r.min.toFixed(4)} vs ${b.min.toFixed(4)}`);
      if (Math.abs(r.max - b.max) > TOL.range * span) issues.push(`max ${r.max.toFixed(4)} vs ${b.max.toFixed(4)}`);
      // Period anchors on the ANALYTIC expectation (1/_ambModRateHz), not the
      // baseline's own noisy estimate — both implementations must hit it.
      if (r.expPeriod && Math.abs(r.period - r.expPeriod) > TOL.period * r.expPeriod) issues.push(`period ${r.period.toFixed(3)} vs expected ${r.expPeriod.toFixed(3)}`);
      if (b.fold && r.fold) {
        const mae = bestRotMae(r.fold, b.fold);
        if (mae > TOL.fold) issues.push(`fold MAE ${mae.toFixed(3)}`);
      }
    }
    if (issues.length) { console.error(`✗ ${cfg.id}: ${issues.join('; ')}`); fails++; }
    else console.log(`✓ ${cfg.id}`);
  }
  if (fails) { console.error(`MOD PARITY: ${fails}/${BATTERY.length} configs drifted`); process.exit(1); }
  console.log(`MOD PARITY: ✓ all ${BATTERY.length} configs within tolerance`);
}

// Rotation-invariant fold compare (LFO start phase is arbitrary).
function bestRotMae(a, b) {
  const n = Math.min(a.length, b.length);
  let best = Infinity;
  for (let rot = 0; rot < n; rot++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(a[(i + rot) % n] - b[i]);
    best = Math.min(best, s / n);
  }
  return best;
}

// ---- in-page measurement (serialized into page.evaluate) --------------------
async function measureOne(cfg, sampleSec) {
  try {
    await Tone.start();
    if (typeof bloopsCoreStrips === 'function') bloopsCoreStrips(false);  // NODE path is what B2 replaces
    _E = _masterEng;
    const c = _masterEng.getCfg();
    c.bed.on = true; c.bed.present = true;              // wanted-set gate (defaults are off/absent)
    c.bed.mod = c.bed.mod || {};
    c.bed.mod.vca = null; c.bed.mod.vcf = null; c.bed.mod.vco = null;
    c.bed.mod[cfg.target] = JSON.parse(JSON.stringify(cfg.mod));
    _ambSyncMods();
    const e = _masterEng.mod && _masterEng.mod.bed;
    const src = e && e.src && e.src[cfg.target];
    if (!src || !src.node) return { error: 'source not built (kind gate?)' };

    const stepped = src.stochastic || src.custom || src.seq;
    const rangeLo = src.min, rangeHi = src.max;         // the engine's own declared contract range
    const samples = [];
    const t0 = Tone.now();
    let tap = null;
    if (!stepped) {
      tap = new Tone.Waveform(256);
      try { src.node.connect(tap); } catch (e2) { return { error: 'tap connect failed' }; }
    }
    const dt = 25;                                       // ms poll
    const warmup = 0.25;                                 // analyser window starts as zeros — discard
    while (Tone.now() - t0 < sampleSec + warmup) {
      if (Tone.now() - t0 < warmup) { await new Promise(r => setTimeout(r, dt)); continue; }
      if (stepped) {
        try { _ambScheduleStochastic(Tone.now()); } catch (e2) {}
        samples.push({ t: Tone.now(), v: src.node.value });
      } else {
        const w = tap.getValue();
        samples.push({ t: Tone.now(), v: w[w.length - 1] });
      }
      await new Promise(r => setTimeout(r, dt));
    }
    try { tap && tap.dispose(); } catch (e2) {}

    const vs = samples.map(s => s.v).filter(Number.isFinite);
    if (!vs.length) return { error: 'no samples' };
    const min = Math.min(...vs), max = Math.max(...vs);
    const out = { min, max, rangeLo, rangeHi, n: vs.length };

    if (src.stochastic) {
      // step cadence: mean interval between value changes
      let changes = 0, lastV = samples[0].v, lastT = samples[0].t, ivs = [];
      for (const s of samples) {
        if (Math.abs(s.v - lastV) > 1e-6 * Math.max(1, Math.abs(max - min))) {
          ivs.push(s.t - lastT); lastT = s.t; lastV = s.v; changes++;
        }
      }
      out.stepIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0;
      return out;
    }

    // expected period from the SAME formula the engine uses
    const expPeriod = 1 / _ambModRateHz(cfg.mod.rate, c, c.bed.mod.sync);
    out.expPeriod = expPeriod;
    // RESAMPLE onto a uniform grid first — setTimeout jank makes raw sample
    // spacing non-uniform, which biases index-based autocorrelation.
    const rawTs = samples.map(s => s.t - samples[0].t);
    const dtSec = 0.02;
    const dur = rawTs[rawTs.length - 1];
    const ts = [], uv = [];
    for (let t = 0, j = 0; t <= dur; t += dtSec) {
      while (j < rawTs.length - 2 && rawTs[j + 1] < t) j++;
      const t0 = rawTs[j], t1 = rawTs[j + 1], f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      ts.push(t); uv.push(vs[j] + (vs[Math.min(j + 1, vs.length - 1)] - vs[j]) * Math.max(0, Math.min(1, f)));
    }
    const mean = uv.reduce((a, b) => a + b, 0) / uv.length;
    const dv = uv.map(v => v - mean);
    let bestLag = 0, bestR = -Infinity;
    const lagLo = Math.max(2, Math.round(0.3 * expPeriod / dtSec));
    const lagHi = Math.min(dv.length - 2, Math.round(2 * expPeriod / dtSec));
    const rs = [];
    for (let lag = lagLo; lag <= lagHi; lag++) {
      let r = 0, nn = 0;
      for (let i = 0; i + lag < dv.length; i++) { r += dv[i] * dv[i + lag]; nn++; }
      r /= Math.max(1, nn);
      rs.push({ lag, r });
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
    // Subharmonic guard: a harmonically-rich wave correlates almost as well
    // at 2T — take the FIRST LOCAL MAXIMUM within 5% of the peak (a plain
    // smallest-lag rule biases early on smooth sine correlation curves).
    let refined = bestLag;
    for (let i = 1; i < rs.length - 1; i++) {
      if (rs[i].r >= 0.95 * bestR && rs[i].r >= rs[i - 1].r && rs[i].r >= rs[i + 1].r) {
        bestLag = rs[i].lag;
        // parabolic interpolation around the peak (sub-lag precision)
        const y0 = rs[i - 1].r, y1 = rs[i].r, y2 = rs[i + 1].r;
        const den = y0 - 2 * y1 + y2;
        refined = bestLag + (Math.abs(den) > 1e-12 ? 0.5 * (y0 - y2) / den : 0);
        break;
      }
    }
    out.period = refined * dtSec;
    // 16-bin phase fold at the EXPECTED period (stable), normalized 0..1
    const bins = new Array(16).fill(0), cnt = new Array(16).fill(0);
    for (let i = 0; i < uv.length; i++) {
      const ph = (ts[i] / expPeriod) % 1;
      const bi = Math.min(15, Math.floor(ph * 16));
      bins[bi] += uv[i]; cnt[bi]++;
    }
    const span = Math.max(1e-9, max - min);
    out.fold = bins.map((b, i) => cnt[i] ? Math.round(((b / cnt[i]) - min) / span * 1000) / 1000 : 0.5);
    return out;
  } catch (err) { return { error: err.message }; }
}

main().catch(e => { console.error(e); process.exit(1); });
