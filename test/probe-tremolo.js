// PROBE — periodic amplitude modulation ("tremolo") and dropouts, MEASURED.
//
// user, 2026-09-28: "almost sounds like a square wave tremolo is being applied",
// then "still glitchy (tremolo)" across seven builds.
//
// Every one of those builds was aimed by ear, because nothing measured the
// thing being complained about. The output-path counters (reserve, playbackRate,
// starvation events) all read CLEAN on builds that sounded bad, so they were the
// wrong instrument: they describe the plumbing, not the sound.
//
// A tremolo is objectively measurable. Take the amplitude ENVELOPE of the master
// output and look at its spectrum: a steady tone has a flat envelope, and
// periodic gating puts a peak in it at the gate rate. So this reports the
// dominant envelope frequency and its depth, plus a dropout count, for a REAL
// harvested project — and it runs on the desktop engine, with no phone in the
// loop at all.
//
// THAT SPLIT IS THE POINT. The mobile output path (AAC encode -> fMP4 -> MSE ->
// media element) does not exist here. So:
//   modulation present here  -> it is in the ENGINE/mix, reproducible in seconds
//   modulation absent here   -> it is the mobile output path, and the engine is fine
// One run decides which half of the system to work on, which is the question
// that seven builds failed to settle.
//
//   node test/probe-tremolo.js [dump.json] [seconds]
//
// Needs `npm start`. With no dump it plays whatever the default boot gives you.
// MEASURED IN dB AT THE MASTER OUTPUT (Tone.getDestination().input), per the
// standing rule — never by reading the graph.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const file = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
const SECS = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 25;
const ENV_HZ = 100;                 // envelope sample rate: resolves modulation to 50 Hz
const zz = (ms) => new Promise((r) => setTimeout(r, ms));

// --- envelope spectrum -----------------------------------------------------
// A plain DFT over the band we care about. The envelope is only ENV_HZ samples
// per second and the band is 0.3-25 Hz, so this is a few hundred thousand ops:
// an FFT would be faster and less clear.
function envelopeSpectrum(env, hz, lo, hi, step) {
  const n = env.length;
  const mean = env.reduce((a, b) => a + b, 0) / n;
  const ac = env.map((v) => v - mean);          // drop DC: we want MODULATION
  const out = [];
  for (let f = lo; f <= hi; f += step) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const p = 2 * Math.PI * f * i / hz;
      re += ac[i] * Math.cos(p); im += ac[i] * Math.sin(p);
    }
    // amplitude of the modulation at f, as a fraction of the mean level
    out.push({ f, depth: mean > 1e-9 ? (2 * Math.sqrt(re * re + im * im) / n) / mean : 0 });
  }
  return { spectrum: out, mean };
}

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e.message)));
pg.on('dialog', async (d) => { await d.accept(); });
await pg.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await pg.evaluate(() => document.body.classList.add('view-mix'));
await zz(2000);

const dump = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

const started = await pg.evaluate(async (d, envHz) => {
  const E = _masterEng;
  if (d) {
    // verbatim, exactly as test/replay.js does it — the point is that nothing
    // here is a reconstruction of the user's project
    try { savedSequences.length = 0; (d.seqs || []).forEach((x) => savedSequences.push(x)); } catch (e) {}
    const cur = E.getCfg();
    Object.keys(cur).forEach((k) => { delete cur[k]; });
    Object.assign(cur, JSON.parse(JSON.stringify(d.cfg)));
    E.inited = false; _ambientInit(E); _E = E;
  }
  try { await Tone.start(); } catch (e) {}
  try { await Tone.getContext().rawContext.resume(); } catch (e) {}

  // THE TAP: the master output, which is what the ear gets.
  const ctx = Tone.getContext().rawContext;
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  Tone.getDestination().input.connect(an);
  const buf = new Float32Array(an.fftSize);
  const env = [];
  window.__T = { env, an, buf, timer: 0 };
  window.__T.timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    env.push(Math.sqrt(s / buf.length));           // RMS of this frame
  }, 1000 / envHz);

  await _ambStartGenerator(E);
  return true;
}, dump, ENV_HZ);

if (!started) { console.error('engine did not start'); await b.close(); process.exit(2); }
console.log('playing ' + (file ? file : '(default boot)') + ' for ' + SECS + 's, sampling the envelope at ' + ENV_HZ + ' Hz…');
await zz(SECS * 1000);

const env = await pg.evaluate(() => {
  clearInterval(window.__T.timer);
  try { _ambStopGenerator(_masterEng); } catch (e) {}
  return window.__T.env;
});
await b.close();

// --- report ----------------------------------------------------------------
// drop the first second: the fade-in is a legitimate envelope ramp
const cut = env.slice(ENV_HZ);
if (cut.length < ENV_HZ * 5) {
  console.error('too few envelope samples (' + cut.length + ') — did audio render at all?');
  process.exit(2);
}
const { spectrum, mean } = envelopeSpectrum(cut, ENV_HZ, 0.3, 25, 0.05);
spectrum.sort((a, b2) => b2.depth - a.depth);
const top = spectrum.slice(0, 5);

const silent = cut.filter((v) => v < mean * 0.05).length;
const silentPct = 100 * silent / cut.length;

console.log('\n  mean level      ' + mean.toFixed(5) + '  (' + (20 * Math.log10(Math.max(mean, 1e-9))).toFixed(1) + ' dBFS)');
console.log('  envelope peaks  ' + top.map((p) => p.f.toFixed(2) + ' Hz @ ' + (100 * p.depth).toFixed(1) + '%').join('   '));
console.log('  near-silent     ' + silentPct.toFixed(1) + '% of frames below -26 dB of mean');

const worst = top[0];
// A musical mix has SOME envelope structure (notes start and stop), so the bar
// is not zero. A gate deep enough to be described as a tremolo is tens of
// percent at one sharp frequency; note rhythm spreads across the band.
const TREMOLO_DEPTH = 0.18;
console.log('');
if (worst.depth >= TREMOLO_DEPTH) {
  console.log('  PERIODIC MODULATION DETECTED — ' + worst.f.toFixed(2) + ' Hz at '
    + (100 * worst.depth).toFixed(1) + '% depth.');
  console.log('  This is present in the ENGINE OUTPUT, with none of the mobile');
  console.log('  broadcast path involved. Reproducible here, on desktop, in ' + SECS + 's.');
} else {
  console.log('  No strong periodic modulation in the engine output (worst '
    + worst.f.toFixed(2) + ' Hz at ' + (100 * worst.depth).toFixed(1) + '%, bar '
    + (100 * TREMOLO_DEPTH) + '%).');
  console.log('  If the phone still tremolos on this project, the cause is BELOW the');
  console.log('  engine: the AAC encode, the MSE element, or the iOS output stage.');
}
if (errs.length) console.log('\n  page errors: ' + errs.slice(0, 3).join(' | '));
