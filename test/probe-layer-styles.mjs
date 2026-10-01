// PROBE — ＋ Add layer → Layer → a STYLE makes a layer that already plays.
//
// user (2026-10-01): "when creating a new layer, add a new initial options
// screen where user can choose beat, melody, chords, bass, ambience, drone,
// and have them be macros for bootstrapping a new v2 layer in that style with
// generated content". Driven through the real sheets, per style:
//   · the kind chooser opens, with Empty first and all six styles,
//   · the layer is created, NAMED for its style, and is generated (`live`),
//   · it SOUNDS — notes reach playNote under its key within a few seconds,
//   · its card is on screen at a real size.
// And "Empty" still makes today's blank, hand-written layer.
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';

const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else fail++; console.log('  ' + (c ? '✓' : '✗') + ' ' + n + (d ? '  · ' + d : '')); };

const WS = JSON.stringify({ version: 1, masterAmbient: { seed: 5, bpm: 110, layers: [] } });
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
await page.evaluate(async () => {
  document.body.classList.add('view-mix'); _ambInitMaster();
  try { await Tone.start(); } catch (e) {}
  window.__cap = {};
  const f = window.playNote;
  window.playNote = function (freq, params, d, at, ...rest) {
    try { const k = window._ambEmitKey || '?'; window.__cap[k] = (window.__cap[k] || 0) + 1; } catch (e) {}
    return f.call(this, freq, params, d, at, ...rest);
  };
});
await zz(600);

// RegExp cannot cross into the page; use a source string and rebuild there
const choose = (styleWord) => page.evaluate(async (styleWord) => {
  const b = document.getElementById('mix-bloom-add-layer'); if (!b) return { err: 'no + Add layer' };
  b.scrollIntoView({ block: 'center' }); b.click();
  await new Promise((r) => setTimeout(r, 450));
  let bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
  const lay = bs.find((x) => x.textContent.trim() === 'Layer');
  if (!lay) return { err: 'no "Layer" entry' };
  lay.click();
  await new Promise((r) => setTimeout(r, 450));
  bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
  const menu = bs.map((x) => x.textContent.trim());
  const t = bs.find((x) => new RegExp(styleWord, 'i').test(x.textContent.trim()));
  if (!t) return { err: 'no ' + styleWord + ' in ' + menu.join(' | ') };
  const before = new Set((_masterEng.getCfg().layers || []).map((x) => x.id));
  t.click();
  await new Promise((r) => setTimeout(r, 700));
  const L = (_masterEng.getCfg().layers || []).find((x) => !before.has(x.id));
  if (!L) return { err: 'no layer created', menu };
  return { menu, id: L.id, name: L.name, kind: L.part && L.part.kind, made: L.part && L.part.made,
    tone: L.instrument && L.instrument.tone, notes: (L.part && L.part.notes || []).length };
}, styleWord);

console.log('\n＋ Layer in a style');
const STYLES = ['Beat', 'Melody', 'Chords', 'Bass', 'Ambience', 'Drone'];
const made = {};
for (const s of STYLES) {
  const r = await choose(s);
  made[s] = r;
  if (r.err) { ok(s + ' — created', false, r.err); continue; }
  ok(s + ' — created, named for its style, and generated', new RegExp('^' + s).test(r.name) && r.kind === 'live',
    JSON.stringify({ name: r.name, kind: r.kind, tone: r.tone }));
}
const menu = (made.Beat && made.Beat.menu) || [];
ok('the chooser offers Empty first, then all six', /^Empty/.test(menu[0] || '') && STYLES.every((s) => menu.some((m) => m.includes(s))), menu.join(' | '));

// they SOUND
const sound = await page.evaluate(async (ids) => {
  window.__cap = {};
  try { document.getElementById('mix-bloom-play-btn').click(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 5000));
  try { document.getElementById('mix-bloom-play-btn').click(); } catch (e) {}
  const out = {}; ids.forEach((id) => { out[id] = window.__cap['v2:' + id] || 0; }); return out;
}, STYLES.map((s) => made[s] && made[s].id).filter((x) => x != null));
STYLES.forEach((s) => {
  const id = made[s] && made[s].id; if (id == null) return;
  ok(s + ' — plays notes straight away', (sound[id] | 0) > 0, (sound[id] | 0) + ' notes in 5 s');
});

// on screen
const cards = await page.evaluate((ids) => ids.map((id) => {
  const c = document.querySelector('[data-v2id="' + id + '"], .v2-card[data-id="' + id + '"], [data-layer-id="' + id + '"]');
  if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect();
  return Math.round(r.width) + 'x' + Math.round(r.height);
}), STYLES.map((s) => made[s] && made[s].id).filter((x) => x != null));
ok('each new layer has a card on screen', cards.every((c) => c && !/^0x|x0$/.test(c)), JSON.stringify(cards));

const empty = await choose('^Empty');
ok('"Empty" still makes a blank, hand-written layer', !empty.err && empty.kind === 'recorded' && empty.notes === 0,
  JSON.stringify(empty.err ? empty : { name: empty.name, kind: empty.kind, made: empty.made, notes: empty.notes }));
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
