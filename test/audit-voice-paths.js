// AUDIT — where does each Bloom note go, and what does it cost?
//
// user, 2026-09-29: "do an audit and see what performance improvements we can make".
// Loads a real project (WORKSPACE=<backup.json from the phone>), plays it, and
// reports per layer: notes taken by the WASM core vs built as per-note WebAudio
// node chains (with the exact reason each one was ineligible), WebAudio nodes
// created per second, and main-thread time per Bloom tick and per voice build.
//
//   WORKSPACE=path/to/bloops-backup.json node test/audit-voice-paths.js   (needs `npm start`)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const SECS = +(process.env.SECS || 30);
const zz = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
if (process.env.WORKSPACE) {
  const j = JSON.parse(fs.readFileSync(process.env.WORKSPACE, 'utf8'));
  ws = (j.keys && j.keys['bloops-workspace']) || null;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', async (d) => { await d.accept(); });
  if (ws) await page.evaluateOnNewDocument((w) => { try { localStorage.setItem('bloops-workspace', w); } catch (e) {} }, ws);
  // count every native WebAudio node creation (Tone's wrapper calls these underneath)
  await page.evaluateOnNewDocument(() => {
    window.__nodes = {};
    const P = (window.BaseAudioContext || window.AudioContext).prototype;
    Object.getOwnPropertyNames(P).filter((k) => /^create/.test(k) && typeof P[k] === 'function').forEach((k) => {
      const f = P[k];
      P[k] = function () { window.__nodes[k] = (window.__nodes[k] || 0) + 1; return f.apply(this, arguments); };
    });
    const W = window.AudioWorkletNode;
    if (W) window.AudioWorkletNode = new Proxy(W, { construct(t, a) { window.__nodes.AudioWorkletNode = (window.__nodes.AudioWorkletNode || 0) + 1; return Reflect.construct(t, a); } });
  });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(3000);

  const info = await page.evaluate(async (SECS) => {
    document.body.classList.add('view-mix'); _ambInitMaster();
    try { await Tone.start(); } catch (e) {}
    const E = _masterEng, cfg = E.getCfg();
    const layers = _ambMixerLayers(cfg).map(({ key, name, layer }) => ({ key, name,
      type: layer && layer.instrument && layer.instrument.type, on: !!(layer && layer.on) }));
    // ── per-note routing, attributed to the emitting layer ─────────────────
    const per = {};
    const bump = (k, f, reason) => { const o = per[k] || (per[k] = { total: 0, core: 0, coreSample: 0, node: 0, reasons: {}, types: {} });
      o[f]++; if (reason) o.reasons[reason] = (o.reasons[reason] || 0) + 1; };
    const why = (type, p) => {
      if (!p) return 'no params';
      if (p.sampleId || p._drumKit || (typeof type === 'string' && /^sample/.test(type))) return 'sample';
      const WAVES = ['square', 'triangle', 'sawtooth', 'pulse', 'fat'];
      const KINDS = ['sine', 'fm', 'bass', 'bell', 'xylo', 'am', 'pad', 'duo', 'kick', 'metal', 'pluck', 'wavetable', 'sync'];
      if (!(typeof type === 'string' && (type.indexOf('noise') === 0 || WAVES.indexOf(type) >= 0 || KINDS.indexOf(type) >= 0))) return 'type:' + type;
      if (p.glideMs > 0) return 'glide';
      if (p._detuneMod) return 'detuneMod';
      const fx = ['reverb', 'delay', 'distortion', 'chorus', 'vibrato', 'tremolo', 'phaser', 'autoFilter', 'pingPong', 'autoPan', 'fxOverrideGlobal', 'bend'].filter((k) => p[k]);
      if (fx.length) return 'perNoteFx:' + fx.join('+');
      if (type === 'wavetable' && (p.wtPosition != null || p.wavetableMix)) return 'designWavetable';
      if (!_coreVoices.eligible(type, p)) return 'designNotCoreKind';
      return 'eligible-but-not-taken (cold/slot)';
    };
    const cv = _coreVoices;
    const oNote = cv.noteOn, oSamp = cv.sampleNoteOn;
    let lastTaken = null;
    cv.noteOn = function (key) { const r = oNote.apply(this, arguments); if (r) lastTaken = 'core'; return r; };
    cv.sampleNoteOn = function (key) { const r = oSamp.apply(this, arguments); if (r) lastTaken = 'coreSample'; return r; };
    const oNow = _playNoteNow;
    const buildMs = [];
    _playNoteNow = function (freq, params, dur, st) {
      const k = window._ambEmitKey || 'other';
      lastTaken = null;
      const t0 = performance.now();
      const r = oNow.apply(this, arguments);
      const dt = performance.now() - t0;
      if (lastTaken) bump(k, lastTaken);
      else { bump(k, 'node', why(params && params.type, params)); buildMs.push(dt); }
      const o = per[k]; o.total++; const ty = (params && params.type) || '?'; o.types[ty] = (o.types[ty] || 0) + 1;
      return r;
    };
    // main-thread time per Bloom tick
    const tickMs = [];
    const oTick = _ambTick;
    _ambTick = function (e) { const t0 = performance.now(); try { return oTick.apply(this, arguments); } finally { tickMs.push(performance.now() - t0); } };
    const nodes0 = Object.assign({}, window.__nodes);
    _ambStartGenerator(E);
    await new Promise((r) => setTimeout(r, SECS * 1000));
    const nodes1 = Object.assign({}, window.__nodes);
    _ambStopGenerator(E);
    const created = {};
    Object.keys(nodes1).forEach((k) => { const d = (nodes1[k] | 0) - (nodes0[k] | 0); if (d) created[k] = d; });
    const q = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
    return {
      layers, per, created,
      nodesPerSec: +(Object.values(created).reduce((a, b) => a + b, 0) / SECS).toFixed(1),
      tick: { n: tickMs.length, p50: q(tickMs, 0.5), p95: q(tickMs, 0.95), max: q(tickMs, 1), totalPct: +(100 * tickMs.reduce((a, b) => a + b, 0) / (SECS * 1000)).toFixed(1) },
      nodeBuild: { n: buildMs.length, p50: q(buildMs, 0.5), p95: q(buildMs, 0.95), max: q(buildMs, 1), totalMs: +buildMs.reduce((a, b) => a + b, 0).toFixed(0) },
      coreOn: cv.enabled(), stripsOn: cv.stripsEnabled(),
    };
  }, SECS);

  console.log('\nlayers: ' + info.layers.map((l) => l.key + '=' + (l.name || '') + '(' + l.type + (l.on ? '' : ',off') + ')').join('  '));
  console.log('core voices ' + (info.coreOn ? 'ON' : 'OFF') + ', core strips ' + (info.stripsOn ? 'ON' : 'OFF'));
  console.log('\nper layer (' + SECS + ' s):');
  Object.keys(info.per).forEach((k) => {
    const o = info.per[k];
    console.log('  ' + k.padEnd(18) + ' notes ' + String(o.total).padStart(4) + '  core ' + String(o.core + o.coreSample).padStart(4) +
      '  NODE ' + String(o.node).padStart(4) + '  types ' + JSON.stringify(o.types) + (o.node ? '  why: ' + JSON.stringify(o.reasons) : ''));
  });
  console.log('\nWebAudio nodes created: ' + info.nodesPerSec + '/s  ' + JSON.stringify(info.created));
  console.log('Bloom tick main-thread: ' + JSON.stringify(info.tick));
  console.log('node-voice build main-thread (ms): ' + JSON.stringify(info.nodeBuild));
  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 5).join('\n  '));
  await browser.close();
})();
