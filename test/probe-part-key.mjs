// PROBE — ＋ Part in a NEW KEY keeps that key (and the parts already there).
//
// The bug (2026-10-01, "when I pick a different key for the new part, once it
// creates, it's just in the workspace key"): the "‹ Back" row in each Standard
// family submenu reopened the progression menu WITHOUT its opts, so the pick
// took the plain-area branch — it replaced the whole progression in the
// workspace key and deleted every existing part. Driven through the real
// dialog and menu, both routes: direct, and via ‹ Back.
//
// Poison-verified: reverting the one-line fix fails the ‹ Back checks
// (parts: null, every slot in D).
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
const WS = JSON.stringify({ version: 1, masterAmbient: { seed: 7, bpm: 120, keyOn: true,
  keyFollow: true,
  barsPerChord: 1,
  prog: { on: true, name: 'I IV V', chords: [{ root: 0, intervals: [0,4,7] }, { root: 5, intervals: [0,4,7] }, { root: 7, intervals: [0,4,7] }], parts: [{ name: 'Verse', len: 3 }] },
  layers: [{ id: 1, name: 'A', on: true, kind: 'live', level: 60, instrument: { voice: 'sine' }, part: { bars: 1, rhythm: { kind: 'pulse', steps: 4, n: 4 } } }] } });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.evaluateOnNewDocument((w) => { localStorage.setItem('bloops-workspace', w); }, WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' }); await zz(2500);
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else fail++; console.log('  ' + (c ? '✓' : '✗') + ' ' + n + (d ? '  · ' + d : '')); };
for (const mode of ['follow', 'back']) {
  if (mode === 'back') { await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' }); await zz(2500); }
  const r = await page.evaluate(async (mode) => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  document.body.classList.add('view-mix'); try { _ambInitMaster(); } catch (e) {} await w(1200);
  try { rootIdx = 2; currentScale = 'major'; } catch (e) {}
  const E = _masterEng; const out = {};
  const c0 = E.getCfg(); out.areaKey = [_ambKeyRootPc(c0), _ambKeyScaleName(c0)];
  _ambAddPartModal(E, 40, 120); await w(200);
  const ov = document.querySelector('.ambient-addpart-modal').closest('.sm-overlay');
  out.dlgDefault = [ov.querySelector('.ap-root').value, ov.querySelector('.ap-scale').value];
  const rs = ov.querySelector('.ap-root'); rs.value = '4'; rs.dispatchEvent(new Event('change'));
  ov.querySelector('.ap-next').click(); await w(300);
  const btns = () => Array.from(document.querySelectorAll('.ctx-menu button'));
  const fam = btns().find(e => /▸/.test(e.textContent)); fam.click(); await w(300);
  if (mode === 'back') {   // browse a family, go Back, browse again, then pick
    const bk = btns().find(e => /Back/.test(e.textContent)); bk.click(); await w(300);
    out.afterBack = btns().map(e => e.textContent.trim()).slice(0, 4);
    const fam2 = btns().find(e => /▸/.test(e.textContent)); fam2.click(); await w(300);
  }
  const pick = btns().find(e => !e.disabled && /I — IV — V$/.test(e.textContent.trim())); pick.click(); await w(400);
  const c = E.getCfg(); out.parts = c.prog.parts ? JSON.parse(JSON.stringify(c.prog.parts)) : null; out.chords = c.prog.chords.map(x => x.root);
  // what SOUNDS: notes per chord slot (2 s each at 120 bpm, 1 bar per chord)
  const cap = _ambCaptureNotesSynthetic(E, 14, 0);
  const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const slots = {};
  cap.notes.forEach((n) => { const s = Math.floor(n.at / 2 + 1e-6) % 6; const pc = ((Math.round(12 * Math.log2(n.freq / 440)) + 69) % 12 + 12) % 12; (slots[s] = slots[s] || new Set()).add(NAMES[pc]); });
  out.heard = Object.keys(slots).sort().map((k) => k + ':' + [...slots[k]].join(''));
  // what the part chip SAYS
  out.chips = Array.from(document.querySelectorAll('[data-pov^="part:"], .ambient-pov-key, .ambient-part-key')).map(e => e.textContent.trim()).filter(Boolean).slice(0, 6);
  return out;
}, mode);
  console.log('\n＋ Part in E (' + mode + ' route)');
  ok('the existing part is kept', Array.isArray(r.parts) && r.parts.length === 2, JSON.stringify(r.parts));
  ok('the new part stores its own key', !!(r.parts && r.parts[1] && r.parts[1].key), JSON.stringify(r.parts && r.parts[1]));
  const newPart = (r.heard || []).slice(3).join(' ');
  ok('the new part is HEARD in E (E G# B · A C# E · B D# F#)', /EG#B/.test(newPart) && /BD#F#/.test(newPart), newPart);
}
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
