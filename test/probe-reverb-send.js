// PROBE — the per-layer Reverb send survives losing the core send bus.
//
// user, 2026-09-22: "reverb doesn't seem to be working anymore, turning up FX
// reverb send doesn't make any difference in sound".
//
// The summed reverb-send bus (core output 16) is GLOBAL — one sum feeding ONE
// reverb — and it is handed back by being CLAIMED AGAIN, never by the holder
// letting go. Two things meant nobody ever re-claimed it:
//   · `connectSend` skipped the work whenever the destination matched its
//     cache, and an offline render leaves that cache naming a wire it has
//     already torn down;
//   · `_ambEnsureReverb` returned at the door once `_E.reverb` existed, so the
//     only code that ever claimed the bus was a FIRST build.
// Between them, one bounce cost the wash for the rest of the session, with the
// send slider, the send param and the reverb node all still reading correctly.
// That is the failure `03b-core-voices` names in its own comment as "no reverb
// on normal playback".
//
// MEASURED IN dB AT THE MASTER OUTPUT, not by inspecting the graph: "makes no
// difference in sound" is a claim about sound.
//
//   node test/probe-reverb-send.js      (needs `npm start`; BLOOPS_URL to retarget)
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
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 600000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', async (d) => { await d.accept(); });
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1500);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c && c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);
  // ♦ BEAT — a dense, constant source, so the wash is measurable in a couple
  // of seconds rather than needing a long average.
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'beat';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(1700);
  await page.evaluate(() => { const d = document.querySelector('.v2-layer .v2-gendone'); if (d) d.click(); });
  await zz(1200);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-play-btn'); if (b) b.click(); });
  await zz(4000);

  const ready = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.level = 85; L.on = true; L.present = true; delete L.wetOnly; E.getCfg();
    const ctx = Tone.getContext().rawContext;
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const dst = Tone.getDestination();
    (dst.input || dst).connect(an);
    window.__an = an; window.__buf = new Float32Array(an.fftSize);
    return { core: !!((E.mod || {})['v2:' + (L.id | 0)] || {}).core, reverb: !!E.reverb };
  });
  console.log('\n  strip: ' + (ready.core ? 'core' : 'node') + ', reverb built: ' + ready.reverb);
  ok('the layer runs on a core strip with a reverb built', ready.core && ready.reverb,
    JSON.stringify(ready));

  // THE MEASUREMENT: RMS at the master output with the send down, then up.
  const delta = async () => page.evaluate(async () => {
    const E = _masterEng;
    const L0 = () => (E.getCfg().layers || [])[0];
    const key = 'v2:' + (L0().id | 0);
    const an = window.__an, buf = window.__buf;
    const rms = async (ms) => {
      const t0 = performance.now(); let s = 0, n = 0;
      while (performance.now() - t0 < ms) {
        an.getFloatTimeDomainData(buf);
        let a = 0; for (let i = 0; i < buf.length; i++) a += buf[i] * buf[i];
        s += Math.sqrt(a / buf.length); n++;
        await new Promise((r) => setTimeout(r, 25));
      }
      return n ? s / n : 0;
    };
    const setSend = (v) => { const L = L0(); L.revSend = v; E.getCfg();
      try { _ambApplyLayerFx(key, L0()); } catch (x) {} };
    setSend(0); await new Promise((r) => setTimeout(r, 800));
    const dry = await rms(2200);
    setSend(100); await new Promise((r) => setTimeout(r, 800));
    const wet = await rms(2200);
    setSend(0);
    return { dry, wet, dB: (dry > 0 && wet > 0) ? 20 * Math.log10(wet / dry) : NaN };
  });

  const before = await delta();
  console.log('  send 0 → 100: ' + before.dry.toFixed(5) + ' → ' + before.wet.toFixed(5) +
    '  (' + (before.dB >= 0 ? '+' : '') + before.dB.toFixed(2) + ' dB)');
  ok('turning the Reverb send up is audible', before.dB > 2,
    (before.dB >= 0 ? '+' : '') + before.dB.toFixed(2) + ' dB — wanted more than +2');

  // ── NOW TAKE THE BUS AWAY, the way a bounce does ────────────────────────
  // Claimed for somewhere else entirely (a bare gain going nowhere), which is
  // what an offline render's own reverb looks like to the live graph once that
  // render is gone.
  const stolen = await page.evaluate(() => {
    const ctx = Tone.getContext().rawContext;
    const nowhere = ctx.createGain(); nowhere.gain.value = 1;
    window.__nowhere = nowhere;
    try { _coreVoices.connectSend(nowhere); return 'claimed'; } catch (x) { return 'threw ' + x.message; }
  });
  await zz(600);
  const during = await delta();
  console.log('  bus taken:    ' + during.dry.toFixed(5) + ' → ' + during.wet.toFixed(5) +
    '  (' + (during.dB >= 0 ? '+' : '') + during.dB.toFixed(2) + ' dB)   [' + stolen + ']');
  ok('…and with the bus claimed elsewhere the wash is gone, as it must be',
    !(during.dB > 2), (during.dB >= 0 ? '+' : '') + during.dB.toFixed(2) + ' dB');

  // ── THE HEAL: the next claim must actually re-wire ──────────────────────
  // Asked for the SAME reverb the cache already names — which is exactly the
  // case that used to short-circuit and leave the send dead for good.
  await page.evaluate(() => { try { _ambEnsureReverb(); } catch (x) {} });
  await zz(800);
  const after = await delta();
  console.log('  re-claimed:   ' + after.dry.toFixed(5) + ' → ' + after.wet.toFixed(5) +
    '  (' + (after.dB >= 0 ? '+' : '') + after.dB.toFixed(2) + ' dB)\n');
  ok('claiming the same reverb again brings the wash back',
    after.dB > 2, (after.dB >= 0 ? '+' : '') + after.dB.toFixed(2) + ' dB — wanted more than +2');
  ok('…as loud as it was before the bus was taken',
    Math.abs(after.dB - before.dB) < 2.5,
    'before ' + before.dB.toFixed(2) + ' dB, after ' + after.dB.toFixed(2) + ' dB');

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
