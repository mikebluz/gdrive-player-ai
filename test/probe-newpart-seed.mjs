// PROBE — what a layer plays in a part you have just ADDED.
//
// user (2026-10-01): generated layers "re-roll a new take using the same
// settings from the previous part"; hand-written ones "should be
// re-harmonized to fit the new part, and truncated/extended as needed to fit
// the new part". Seeded by the per-part reconciler in 18-layer-v2
// (`normalizeAll`), keyed on `L.partN` so only a part that did not exist at the
// last reconcile is seeded — never the parts present when per-part engaged.
//
// Setup: a 2-bar Verse (C, G) with two per-part layers — a generated bass and a
// hand-written 4-note phrase — then ＋ Part in E (I–IV–V, 3 bars) through the
// real dialog and menu. Asserted:
//   · the generated layer's new part is a NEW TAKE (Verse's take untouched),
//   · the hand-written one is FITTED BY LENGTH (2 → 3 bars: the phrase carries
//     on, it is not stretched), follows the chords, keeps its written key,
//   · the Verse's own notes are untouched,
//   · and what SOUNDS in the new part is in each sounding chord.
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';

const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else fail++; console.log('  ' + (c ? '✓' : '✗') + ' ' + n + (d ? '  · ' + d : '')); };

const WS = JSON.stringify({ version: 1, masterAmbient: { seed: 7, bpm: 120, keyOn: true, keyFollow: true, barsPerChord: 1,
  prog: { on: true, name: 'I V', chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 4, 7] }], parts: [{ name: 'Verse', len: 2 }] },
  layers: [] } });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.evaluateOnNewDocument((w) => { try { localStorage.setItem('bloops-workspace', w); } catch (e) {} }, WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await zz(2500);

const r = await page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  document.body.classList.add('view-mix'); try { _ambInitMaster(); } catch (e) {} await w(1200);
  try { rootIdx = 0; currentScale = 'major'; } catch (e) {}
  const E = _masterEng, V2 = window._v2, out = {};
  const byId = (id) => (E.getCfg().layers || []).find((x) => x.id === id);
  // two per-part layers (addDefault binds them, since parts exist)
  const A = V2.addDefault(E); V2.makeSimple(E, byId(A.id), 'bass'); E.getCfg();
  const B = V2.addDefault(E);
  { const L = byId(B.id);
    L.part.kind = 'recorded'; L.part.made = 'compose';
    L.part.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.25, midi: 62, dur: 0.1 }, { t: 0.5, midi: 64, dur: 0.1 }, { t: 0.75, midi: 65, dur: 0.1, hx: 1 }];
    E.getCfg(); }
  const snap = (id) => { const L = byId(id); return { partFor: L.partFor, partN: L.partN, bench: JSON.parse(JSON.stringify(L.part)), parts: JSON.parse(JSON.stringify(L.parts || {})) }; };
  out.before = { A: snap(A.id), B: snap(B.id) };
  // ＋ Part in E, I — IV — V, through the real dialog + menu
  _ambAddPartModal(E, 40, 120); await w(200);
  const ov = document.querySelector('.ambient-addpart-modal').closest('.sm-overlay');
  const rs = ov.querySelector('.ap-root'); rs.value = '4'; rs.dispatchEvent(new Event('change'));
  ov.querySelector('.ap-next').click(); await w(300);
  const btns = () => Array.from(document.querySelectorAll('.ctx-menu button'));
  btns().find((e) => /▸/.test(e.textContent)).click(); await w(300);
  btns().find((e) => !e.disabled && /I — IV — V$/.test(e.textContent.trim())).click(); await w(500);
  E.getCfg();
  out.progParts = (E.getCfg().prog.parts || []).map((p) => p.len);
  out.after = { A: snap(A.id), B: snap(B.id) };
  // what SOUNDS from B in the new part: 2 s per bar → Verse slots 0-1, new part 2-4
  const cap = _ambCaptureNotesSynthetic(E, 20, 0);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const slots = {};
  (cap.notes || []).filter((n) => n.key === 'v2:' + B.id).forEach((n) => {
    const s = Math.floor(n.at / 2 + 1e-6) % 5;
    const pc = ((Math.round(12 * Math.log2(n.freq / 440)) + 69) % 12 + 12) % 12;
    (slots[s] = slots[s] || []).push(NAMES[pc]);
  });
  out.heardB = slots;
  return out;
});

const bA = r.before.A, aA = r.after.A, bB = r.before.B, aB = r.after.B;
const recNew = (s) => (s.parts || {})['1'] || null;
console.log('\n＋ Part seeds each layer from the part before it');
ok('the new part exists (Verse 2 bars + new 3 bars)', JSON.stringify(r.progParts) === '[2,3]', JSON.stringify(r.progParts));
const nA = recNew(aA);
ok('generated layer: the new part is a NEW TAKE of the same rules',
  !!nA && nA.kind === 'live' && (nA.take | 0) === ((bA.bench.take | 0) + 1) && JSON.stringify(nA.rhythm) === JSON.stringify(bA.bench.rhythm),
  JSON.stringify(nA && { kind: nA.kind, take: nA.take, was: bA.bench.take | 0 }));
ok('…and the Verse keeps its own take', (aA.bench.take | 0) === (bA.bench.take | 0), String(aA.bench.take));
const nB = recNew(aB);
const ts = nB && (nB.notes || []).map((n) => +n.t.toFixed(3));
ok('hand-written: fitted by LENGTH — the phrase carries on into the extra bar, not stretched',
  !!nB && JSON.stringify(ts) === '[0,0.167,0.333,0.5,0.667,0.833]', JSON.stringify(ts));
ok('…set to follow the new part\'s chords, stamped with the key it was WRITTEN in (C), pins released on the copy',
  !!nB && nB.harmonize === 'chordlock' && !!nB.key && nB.key.root === 0 && (nB.notes || []).every((n) => !n.hx),
  JSON.stringify(nB && { harmonize: nB.harmonize, key: nB.key }));
ok('…and the Verse\'s own notes are untouched',
  JSON.stringify(aB.bench.notes) === JSON.stringify(bB.bench.notes) && !aB.bench.harmonize, JSON.stringify(aB.bench.notes.map((n) => n.midi)));
const CH = { 2: ['E', 'G#', 'B'], 3: ['A', 'C#', 'E'], 4: ['B', 'D#', 'F#'] };
const heard = [2, 3, 4].map((s) => (r.heardB[s] || []));
const allIn = [2, 3, 4].every((s) => (r.heardB[s] || []).length && (r.heardB[s] || []).every((n) => CH[s].includes(n)));
ok('what SOUNDS in the new part is in each sounding chord (E · A · B)', allIn, JSON.stringify(heard));
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
