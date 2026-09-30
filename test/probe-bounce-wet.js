// PROBE — the FAST (offline, core-strip) bounce must carry the REVERB SEND.
//
// The bug this exists for (2026-09-30, reported as "capture didn't render some
// layers using the fast method"): the offline render narrows the core worklet
// to `layers + 1` outputs, but the processor wrote the summed reverb-send bus
// to output 16 unconditionally (`if (outputs.length > 16)`) and `connectSend`
// read it from output 16 too. On any project with fewer than 16 layers that
// output did not exist — so every per-layer Reverb send was dropped from the
// bounce, and a WET-ONLY layer (dry muted, all of its sound coming back
// through the reverb) rendered as pure, unreported silence with all of its
// notes correctly delivered.
//
// What is measured: one wet-only layer, alone, rendered offline. It must be
// audible. Then the whole project, with the wet-only layer's per-second RMS
// asserted non-zero, and the new "rendered SILENT for the whole take" report
// asserted to fire when it is not.
//
// Poison-verified 2026-09-30: pinning `nSlots = 16` in
// js/bloops/core/voice-processor.js (the old fixed width) fails 4 named
// checks — SOLO audible, FX returns carried signal, the layer changes the
// full mix, and nothing reported silent. Putting SLOTS back in connectSend's
// offline branch fails the same set.
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  · ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  · ' + detail : '')); }
};

// A project of our own: three sample layers, one of them wet-only. Small
// enough that the offline node narrows to 4 outputs — which is the whole
// point, since 4 < 16 is what broke.
// The Bloom master's config lives under `masterAmbient` in the workspace, not
// at its root — a bare cfg loads as a project with NO layers, and then every
// check here passes or fails vacuously against an empty render.
const WS = JSON.stringify({
  version: 1,
  masterAmbient: {
  seed: 12345, bpm: 84, key: 'C', scale: 'minor',
  reverb: { size: 60, damp: 50, type: 'hall' },
  layers: [
    { id: 1, name: 'Wet', on: true, kind: 'live', level: 60, revSend: 60, wetOnly: 1,
      instrument: { voice: 'sample:piano' } },
    { id: 2, name: 'Dry', on: true, kind: 'live', level: 60, revSend: 0, wetOnly: 0,
      instrument: { voice: 'sample:piano' } },
  ],
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

// The real project the user hit this on, when it is still around; otherwise the
// synthetic one above. Both exercise the same narrow-node path.
const real = process.env.BOUNCE_WS && fs.existsSync(process.env.BOUNCE_WS)
  ? (JSON.parse(fs.readFileSync(process.env.BOUNCE_WS, 'utf8')).keys || {})['bloops-workspace']
  : null;

await page.evaluateOnNewDocument((w) => { try { localStorage.setItem('bloops-workspace', w); } catch (e) {} },
  real || WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await zz(3000);

console.log('\nFast bounce · reverb send survives the narrowed core node'
  + (real ? '  (real project)' : '  (synthetic project)'));

const r = await page.evaluate(async () => {
  const out = {};
  document.body.classList.add('view-mix');
  try { _ambInitMaster(); } catch (e) { out.initErr = String(e); }
  await new Promise((r) => setTimeout(r, 1500));
  try { await Tone.start(); } catch (e) {}
  const E = (typeof _masterEng !== 'undefined') ? _masterEng : null;
  if (!E) return { noEngine: true };
  const cfg = E.getCfg();
  const Ls = cfg.layers || [];
  out.layers = Ls.map((L) => ({ id: L.id, on: L.on, wetOnly: L.wetOnly | 0, revSend: L.revSend | 0 }));

  // Warm every sample the project names, so a cold buffer can't be mistaken
  // for a dead send path.
  try {
    if (typeof warmSamplesForWorkspace === 'function') warmSamplesForWorkspace();
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 150)); if (typeof Tone.loaded === 'function') { } }
    await Tone.loaded();
  } catch (e) {}

  const energy = (buf) => {
    if (!buf || !buf.getChannelData) return null;
    const ch = buf.getChannelData(0); let e = 0, pk = 0;
    for (let i = 0; i < ch.length; i++) { e += ch[i] * ch[i]; pk = Math.max(pk, Math.abs(ch[i])); }
    return { rms: Math.sqrt(e / ch.length), peak: pk };
  };

  // Pick the wet-only layer this project actually has.
  const W = Ls.find((L) => L.on !== false && (L.wetOnly | 0) === 1 && (L.revSend | 0) > 0);
  out.wetId = W ? (W.id | 0) : null;
  if (!W) return out;

  // 1) SOLO the wet-only layer. This is the decisive measurement: with the
  //    send bus lost there is nothing else in the render to hide it.
  const was = Ls.map((L) => L.on);
  try {
    Ls.forEach((L) => { L.on = (L === W); }); E.getCfg();
    const r1 = await _ambRenderOffline(E, 8, { onStatus: () => {}, onProgress: () => {} });
    out.solo = Object.assign({ notes: r1 && r1.notes, missing: (r1 && r1.missing) || [] }, energy(r1 && r1.buffer));
  } catch (e) { out.solo = { err: String((e && e.message) || e) }; }
  Ls.forEach((L, i) => { L.on = was[i]; }); E.getCfg();

  // 2) The whole project, per-layer.
  try {
    const r2 = await _ambRenderOffline(E, 12, { onStatus: () => {}, onProgress: () => {} });
    out.full = Object.assign({ notes: r2 && r2.notes, missing: (r2 && r2.missing) || [],
      wetRms: r2 && r2.wetRms, sendsWanted: r2 && r2.sendsWanted,
      dropouts: (r2 && r2.dropouts) || [] }, energy(r2 && r2.buffer));
  } catch (e) { out.full = { err: String((e && e.message) || e) }; }

  // 2b) A/B the full mix with the wet-only layer muted. Its per-layer meter
  //     taps the DRY output, which this layer mutes by design, so the only
  //     honest way to ask "is it in the mix" is to take it out and listen.
  try {
    const on = W.on; W.on = false; E.getCfg();
    const r3 = await _ambRenderOffline(E, 12, { onStatus: () => {}, onProgress: () => {} });
    out.without = energy(r3 && r3.buffer);
    W.on = on; E.getCfg();
  } catch (e) { out.without = { err: String((e && e.message) || e) }; }

  // 3) The diagnostic itself: a layer with no energy must be NAMED. Feed the
  //    reporter a synthetic all-zero series and check it reports.
  try {
    const d = _bloomLayerDropouts({ 'v2:9': new Array(10).fill(0) });
    out.silentReport = d.length === 1 && !!d[0].silent;
  } catch (e) { out.silentReport = 'err ' + String(e); }
  try {
    const d = _bloomLayerDropouts({ 'v2:9': new Array(10).fill(0.2) });
    out.healthyQuiet = d.length === 0;
  } catch (e) { out.healthyQuiet = 'err ' + String(e); }
  return out;
});

if (r.noEngine) { console.log('  ✗ the Bloom master engine did not come up'); fail++; }
else {
  const so = r.solo || {}, fu = r.full || {};
  ok('a wet-only layer is present to test', r.wetId != null, 'layer ' + r.wetId);
  ok('the render generated notes for it', (so.notes | 0) > 0, (so.notes | 0) + ' notes');
  ok('SOLO wet-only render is audible', so.rms > 1e-4,
    'rms ' + (so.rms == null ? 'n/a' : so.rms.toFixed(6)) + ' peak ' + (so.peak == null ? 'n/a' : so.peak.toFixed(6)));
  ok('the FX returns carried signal', fu.wetRms == null || fu.wetRms > 1e-6,
    'wetRms ' + fu.wetRms);
  ok('the sends the project asks for are counted (v2 layers too)', (fu.sendsWanted | 0) > 0,
    'sendsWanted ' + fu.sendsWanted);
  const wo = r.without || {};
  const delta = (fu.rms && wo.rms != null) ? Math.abs(fu.rms - wo.rms) / Math.max(1e-9, fu.rms) : 0;
  ok('the wet-only layer changes the full mix', delta > 0.01,
    'rms with ' + (fu.rms == null ? 'n/a' : fu.rms.toFixed(6))
    + ' / without ' + (wo.rms == null ? 'n/a' : wo.rms.toFixed(6))
    + '  (' + (delta * 100).toFixed(1) + '%)');
  ok('nothing is reported as silent for the whole take',
    !(fu.missing || []).some((m) => /SILENT for the whole take/.test(m)),
    (fu.missing || []).slice(0, 2).join(' | ') || 'missing: []');
  ok('a wholly silent layer WOULD be reported', r.silentReport === true, String(r.silentReport));
  ok('a healthy steady layer is not reported', r.healthyQuiet === true, String(r.healthyQuiet));
}
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
