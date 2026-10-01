// PROBE — a take in Harvest survives a reload (and a deleted one stays deleted).
//
// The bug (2026-10-01, "captured audio not showing up in harvest"): the
// Harvest bank was an in-memory array and nothing wrote it anywhere, so any
// reload emptied it — and the phone app reloads often (relaunch, a killed
// background app, the bfcache-teardown reload). It now lives in IndexedDB.
//
// Measured: bounce a short take → reload → the bank holds it, with a playable
// blob, and the Harvest list shows its row at a real size once the tab is open.
// Then delete it → reload → gone.
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';

const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else fail++; console.log('  ' + (c ? '✓' : '✗') + ' ' + n + (d ? '  · ' + d : '')); };

const WS = JSON.stringify({ version: 1, masterAmbient: { seed: 11, bpm: 120,
  layers: [{ id: 1, name: 'A', on: true, kind: 'live', level: 60, instrument: { voice: 'sine' },
    part: { bars: 1, rhythm: { kind: 'pulse', steps: 4, n: 4 } } }] } });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
// seed the project before the app reads it, ONCE — a reload must then keep
// whatever the page itself stored (sessionStorage survives the reload)
await page.evaluateOnNewDocument((w) => {
  try { if (!sessionStorage.getItem('probeSeeded')) { sessionStorage.setItem('probeSeeded', '1'); localStorage.setItem('bloops-workspace', w); } } catch (e) {}
}, WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bloops-harvest'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page.reload({ waitUntil: 'networkidle2' }); await zz(2500);

const bank = () => page.evaluate(() => (_ambCaptureBank || []).map((x) => ({ id: x.id, name: x.name, blob: !!(x.blob && x.blob.size), url: !!x.url })));
const reload = async () => { await zz(900); await page.reload({ waitUntil: 'networkidle2' }); await zz(2500); };

console.log('\nHarvest survives a reload');
const made = await page.evaluate(async () => {
  document.body.classList.add('view-mix');
  try { _ambInitMaster(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1200));
  try { await Tone.start(); } catch (e) {}
  const r = await _ambBounceToBank(_masterEng, 3);
  return { ok: !!(r && r.ok !== false), reason: r && r.reason, layers: (_masterEng.getCfg().layers || []).length, n: (_ambCaptureBank || []).length };
});
ok('a bounce lands in the bank', made.n === 1, JSON.stringify(made));
const before = await bank();

await reload();
const after = await bank();
ok('…and is STILL there after a reload', after.length === 1 && after[0].name === (before[0] || {}).name, JSON.stringify(after));
ok('…with its audio (blob) and a playable url', after.length === 1 && after[0].blob && after[0].url, JSON.stringify(after[0] || {}));
const row = await page.evaluate(async () => {
  const t = document.getElementById('harvest-tab');   // the top-bar door the user presses
  if (t) t.click();
  await new Promise((r) => setTimeout(r, 600));
  const rows = Array.from(document.querySelectorAll('#harvest-capbank .ambient-cap-item'))
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  return { n: rows.length, w: rows[0] ? Math.round(rows[0].width) : 0, h: rows[0] ? Math.round(rows[0].height) : 0 };
});
ok('…and its row is on screen in Harvest at a real size', row.n >= 1 && row.w > 50 && row.h > 10, JSON.stringify(row));

// delete it → reload → gone
await page.evaluate(() => { _ambCaptureBank.length = 0; _ambRenderCaptureBank(); });
await reload();
const gone = await bank();
ok('a deleted take stays deleted after a reload', gone.length === 0, JSON.stringify(gone));
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
