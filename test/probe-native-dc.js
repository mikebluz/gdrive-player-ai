// PROBE — the broadcast path's DC blocker.
//
// An iOS audio-session interruption freezes the graph mid-sample; the resume
// restarts it there and the step's DC content is a thump. The interactive
// monitor has always carried a 28 Hz high-pass for exactly this; the BROADCAST
// — the audible path essentially all of the time — did not, so every
// interruption went as a step straight into the encoder and out of the speaker.
// Harvested from the device: four `ctx state → interrupted` → `rescue resume OK`
// pairs in 12 minutes of ordinary use, one 1.34 s after a stop press.
//
// What this can check off-device: that the filter is IN the path every consumer
// reads, and that it does what it claims. The audible confirmation is on-device
// (harvest bloops-flight.json again and count the interruptions against pops).
//
// 00-native-audio.js is inert on the web, so the probe forces it on with the
// file's own documented escape hatch (localStorage bloopsNativeAudio = '1').
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('bloopsNativeAudio', '1'); } catch (e) {}
  });
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  // the reroute installs on a poll once Tone's context exists; a gesture
  // unlocks it the way a real press does
  await page.evaluate(() => { document.body.click(); });
  await zz(2500);

  const wired = await page.evaluate(() => {
    const n = window.__bloopsBridgeSrc;
    if (!n) return { err: 'no bridge source — the reroute did not install' };
    return {
      kind: n.constructor && n.constructor.name,
      type: n.type,
      freq: n.frequency ? n.frequency.value : null,
      q: n.Q ? n.Q.value : null,
      rig: !!(window._nativeAudio && window._nativeAudio.rig && window._nativeAudio.rig()),
    };
  });
  ok('every consumer taps the FILTERED node, not the bare stream source',
    wired.kind === 'BiquadFilterNode' && wired.type === 'highpass',
    JSON.stringify(wired));
  ok('…at the monitor’s own values, so the two paths cannot drift apart',
    wired.freq === 28 && Math.abs((wired.q || 0) - 0.7) < 1e-6, JSON.stringify(wired));

  // …AND THAT IT DOES WHAT IT CLAIMS. An offline render of the same filter:
  // a DC step must be swallowed, and the programme material must not be.
  const resp = await page.evaluate(async () => {
    const mk = async (build) => {
      const oc = new OfflineAudioContext(1, 44100, 44100);
      const hp = oc.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 28; hp.Q.value = 0.7;
      build(oc, hp);
      hp.connect(oc.destination);
      const buf = await oc.startRendering();
      const d = buf.getChannelData(0);
      // measure the SECOND half, past the filter's own settling
      let peak = 0, sum = 0;
      for (let i = d.length >> 1; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v * v; }
      return { peak, rms: Math.sqrt(sum / (d.length >> 1)) };
    };
    // a STEP — the shape an interruption's resume produces
    const dc = await mk((oc, hp) => {
      const c = oc.createConstantSource(); c.offset.value = 1; c.connect(hp); c.start();
    });
    // …and a low musical fundamental (A2) that must pass untouched
    const tone = await mk((oc, hp) => {
      const o = oc.createOscillator(); o.frequency.value = 110; o.connect(hp); o.start();
    });
    return { dc, tone };
  });
  ok('a DC step is swallowed — the thump an interrupt→resume makes',
    resp.dc.rms < 0.01, 'dc rms=' + resp.dc.rms.toFixed(5) + ' peak=' + resp.dc.peak.toFixed(5));
  ok('…and a low musical fundamental passes through it untouched',
    resp.tone.rms > 0.68, 'A2 rms=' + resp.tone.rms.toFixed(4) + ' (unfiltered sine ≈ 0.707)');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
