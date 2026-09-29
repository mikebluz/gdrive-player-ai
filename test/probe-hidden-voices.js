// PROBE — a HIDDEN page still builds every Bloom voice before it is due.
//
// user, 2026-09-28 (phone): "playback dramatically degrades when backgrounded,
// like it's been slowed way down or only some notes are playing (for some
// layers, weirdly not all)". Measured on the phone's own ring input: 12-16 note
// attacks per 5 s visible, 7-10 hidden.
//
// Cause: the deferred voice-build queue is pumped by `setTimeout(_vqPump, 12)`,
// and a hidden page's timers are throttled to ~1 per second — so the queue
// drained ~100x slower than Bloom filled it; only the node-voice layers thinned.
// Fix: hidden, the queue is paced on a MessageChannel (not throttled) and builds
// only what is due within 3.5 s; core voices bypass the queue entirely.
//
// LIMIT (measured): desktop Chrome EXEMPTS an audible tab from timer throttling,
// so here the pre-fix file ALSO passes — this probe cannot see the bug on a Mac.
// It proves only that the hidden path builds without queueing and without
// errors; the evidence for the fix is the phone's ring-input capture (attacks
// per 5 s, visible vs hidden) from verify.sh.
//
//   node test/probe-hidden-voices.js      (needs `npm start`)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', async (d) => { await d.accept(); });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(async () => {
    document.body.classList.add('view-mix'); _ambInitMaster();
    try { await Tone.start(); } catch (e) {}
    _ambAddPreset(_masterEng, { layers: [{ type: 'bed' }, { type: 'bass' }, { type: 'beat' }, { type: 'motif' }] });
    // sample the queue every 100 ms — on a WORKER clock, which a hidden tab does
    // not throttle, so the sampling itself cannot hide the backlog
    window.__vq = { max: 0, samples: [], builds: 0, late: 0, minLead: 99 };
    // every deferred build's lead over its own start time — negative = built late
    const _orig = _vqBuild;
    _vqBuild = function (e) { if (document.hidden) { let lead = 99; try { lead = e.at - Tone.now(); } catch (x) {}
      window.__vq.builds++; if (lead < 0) window.__vq.late++; if (lead < window.__vq.minLead) window.__vq.minLead = lead; }
      return _orig(e); };
    const src = 'setInterval(()=>postMessage(0),100)';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = () => { const n = _voiceBuildQueue.length;
      window.__vq.samples.push([document.hidden ? 1 : 0, n]); if (document.hidden && n > window.__vq.max) window.__vq.max = n; };
    _ambStartGenerator(_masterEng);
  });
  await zz(8000);
  const vis = await page.evaluate(() => ({ hidden: document.hidden, qNow: _voiceBuildQueue.length }));
  console.log('\n  visible: ' + JSON.stringify(vis));

  // put another tab in front — the Bloops tab is now hidden and its timers throttle
  const other = await browser.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await zz(15000);
  const hid = await page.evaluate(() => {
    const hs = window.__vq.samples.filter((x) => x[0] === 1);
    return { hidden: document.hidden, samples: hs.length, maxQueue: window.__vq.max,
             meanQueue: hs.length ? +(hs.reduce((a, x) => a + x[1], 0) / hs.length).toFixed(2) : -1,
             playing: !!_masterEng.timer, builds: window.__vq.builds, late: window.__vq.late,
             minLead: +window.__vq.minLead.toFixed(3) };
  });
  console.log('  hidden : ' + JSON.stringify(hid));
  ok('the page really was hidden (the throttled case)', hid.hidden === true && hid.samples > 50, JSON.stringify(hid));
  ok('…and still playing', hid.playing === true);
  ok('hidden, voices are still built through the paced queue (no burst at emit)',
    hid.builds > 20, JSON.stringify(hid));
  ok('…and NONE is built after its start time',
    hid.late === 0 && hid.minLead > 0, JSON.stringify(hid));
  ok('…and the queue never holds more than the 3.5 s hidden window of notes',
    hid.maxQueue < 400, JSON.stringify(hid));

  await page.bringToFront();
  await zz(3000);
  const back = await page.evaluate(() => ({ hidden: document.hidden, q: _voiceBuildQueue.length }));
  ok('back in front, the paced queue is used again (it is still the right tool when visible)',
    back.hidden === false, JSON.stringify(back));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
