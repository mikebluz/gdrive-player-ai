// PROBE — silence the arrangement ASKED FOR is not a dropout.
//
// The bug (reported 2026-09-30 as "what is wrong with capture"): 🌒 Arc's job is
// to drop layers out and bring them back, so the bounce's per-layer dropout
// detector named EVERY layer on EVERY render of a project using it, under a
// toast heading reading "Missing:". The fix keeps material-side quiet out of
// `missing` when Arc or ⏸ Breath is in force and states it in its own clause
// (`res.thinNote`) instead.
//
// What is measured: the SAME project rendered with Arc on and with Arc at 0.
//   · Arc on  → layers do thin (else the check is vacuous), none of it lands in
//               `missing`, and `thinNote` names Arc.
//   · Arc 0   → no thinNote — which is what proves Arc was the cause and that
//               the suppression is not a blanket mute of the detector.
//   · and the detector itself still names an AUDIO-side dropout.
//
// Poison-verified 2026-09-30: disabling the suppression (`if (false && …)`)
// fails 3 named checks — no thinNote, no Arc named, and two layers listed
// under Missing as "goes silent".
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  · ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  · ' + detail : '')); }
};

const layer = (id, name) => ({ id, name, on: true, kind: 'live', level: 60,
  instrument: { voice: 'sine' },
  part: { bars: 2, rhythm: { kind: 'pulse', steps: 8, n: 8 } } });
const WS = JSON.stringify({
  version: 1,
  masterAmbient: {
    seed: 4242, bpm: 120,
    prog: { arc: { amount: 40, bars: 16, shape: 'build' } },
    layers: [layer(1, 'A'), layer(2, 'B'), layer(3, 'C'), layer(4, 'D')],
  },
});

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.evaluateOnNewDocument((w) => { try { localStorage.setItem('bloops-workspace', w); } catch (e) {} }, WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await zz(2500);

console.log('\n🌒 Arc thinning is reported as Arc, not as Missing');

const r = await page.evaluate(async () => {
  document.body.classList.add('view-mix');
  try { _ambInitMaster(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1500));
  try { await Tone.start(); } catch (e) {}
  const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
  if (!E) return { noEngine: true };
  const out = {};
  out.arc = JSON.stringify((E.getCfg().prog || {}).arc || null);
  const quiet = (m) => (m || []).filter((x) => /goes silent|CUTS IN AND OUT/.test(x));
  const render = async () => {
    const res = await _ambRenderOffline(E, 32, { onStatus: () => {}, onProgress: () => {} });
    return { missing: (res && res.missing) || [], thin: (res && res.thinNote) || '' };
  };
  const on = await render();
  out.onQuiet = quiet(on.missing); out.onThin = on.thin; out.onMissing = on.missing;
  // re-resolve: the normalizer replaces objects
  E.getCfg().prog.arc.amount = 0; E.getCfg();
  const off = await render();
  out.offQuiet = quiet(off.missing); out.offThin = off.thin;
  // the detector still names a layer that is quiet WITH notes delivered — the
  // AUDIO path — whatever thinning is in force
  try {
    const d = _bloomLayerDropouts({ 'v2:9': [0.2, 0.2, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2] });
    out.audioNamed = d.length === 1 && !d[0].silent;
  } catch (e) { out.audioNamed = 'err ' + e.message; }
  return out;
});

if (r.noEngine) ok('the Bloom master engine came up', false);
else {
  const n = (r.onThin.match(/^(\d+)/) || [])[1] | 0;
  ok('Arc survived the normalizer', /"amount":40/.test(r.arc), r.arc);
  ok('with Arc on, layers DO thin (else this is vacuous)', n > 0, r.onThin || 'no thinNote');
  ok('…and the thin note names Arc', /Arc/.test(r.onThin), r.onThin);
  ok('…and none of it is listed under Missing', r.onQuiet.length === 0,
    r.onQuiet.slice(0, 2).join(' | ') || 'missing: ' + JSON.stringify(r.onMissing));
  ok('Arc at 0: no thin note', r.offThin === '', r.offThin || '(none)');
  ok('Arc at 0: no layer goes quiet either', r.offQuiet.length === 0, r.offQuiet.slice(0, 2).join(' | ') || '(none)');
  ok('the dropout detector still names an audio-side gap', r.audioNamed === true, String(r.audioNamed));
}
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
