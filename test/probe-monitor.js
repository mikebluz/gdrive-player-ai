// PROBE — 🎧 Monitor: one chip per layer, tap to play or silence it.
//
// A feature is not done until its UI is REACHABLE, and a control added inside
// something collapsed/behind a tab gets reported as MISSING, not as hidden —
// so this measures rects and `offsetParent` in the view the user actually has
// open, hit-tests each chip with `elementFromPoint`, drives it with a real
// TOUCH, and reads the config back. A `querySelector` hit proves nothing.
//
// It also asserts the two directions of the sync: a chip press must move the
// layer card's head toggle, and a card press must move the chip. That pair is
// the whole reason `_ambSyncOnUI` exists — a chip with no second writer goes
// on claiming a layer is playing after the card silenced it.
//
// Needs `npm start` on :3001.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  · ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  · ' + detail : '')); }
};

// Names of different lengths on purpose: a fixture whose rows all hold the
// same text cannot catch a width bug (docs/traps-ui.md).
// The Bloom master's config lives under `masterAmbient` in the workspace, not
// at its root — a bare cfg loads as a project with NO layers, and then every
// chip check passes vacuously against an empty pane.
const WS = JSON.stringify({
  version: 1,
  masterAmbient: {
    seed: 7,
    layers: [
      { id: 1, name: 'Pad', on: true, kind: 'live', level: 60, instrument: { voice: 'sample:piano' } },
      { id: 2, name: 'Hundred and Something Long', on: true, kind: 'live', level: 55, instrument: { voice: 'sample:piano' } },
      { id: 3, name: 'Bass', on: false, kind: 'live', level: 70, instrument: { voice: 'sample:piano' } },
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

const real = process.env.MON_WS && fs.existsSync(process.env.MON_WS)
  ? (JSON.parse(fs.readFileSync(process.env.MON_WS, 'utf8')).keys || {})['bloops-workspace']
  : null;
await page.evaluateOnNewDocument((w) => { try { localStorage.setItem('bloops-workspace', w); } catch (e) {} },
  real || WS);
await page.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await zz(2500);

console.log('\n🎧 Monitor' + (real ? '  (real project)' : '  (synthetic project)'));

// Open the view the user has open: Grow (body.view-mix), master Bloom panel.
await page.evaluate(async () => {
  document.body.classList.add('view-mix');
  try { _ambInitMaster(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1500));
});

// ── 1. The tab exists, is reachable, and sits to the RIGHT of Mixer ──────────
const tabs = await page.evaluate(() => {
  const bar = document.querySelector('.ambient-tabsec-bar');
  if (!bar) return { noBar: true };
  const all = [...bar.querySelectorAll('.ambient-tabsec-tab')].map((t) => {
    const r = t.getBoundingClientRect();
    return { tab: t.getAttribute('data-tab'), text: t.textContent.trim(),
             x: r.left, w: r.width, h: r.height, off: !!t.offsetParent };
  });
  return { all };
});
if (tabs.noBar) { ok('the tab bar exists', false); }
else {
  const mon = tabs.all.find((t) => t.tab === 'monitor');
  const mix = tabs.all.find((t) => t.tab === 'mixer');
  ok('a 🎧 Monitor tab exists', !!mon, mon ? mon.text : tabs.all.map((t) => t.tab).join(', '));
  ok('it is REACHABLE (non-zero rect, has an offsetParent)',
    !!mon && mon.w > 0 && mon.h > 0 && mon.off,
    mon ? Math.round(mon.w) + '×' + Math.round(mon.h) + ' offsetParent=' + mon.off : 'n/a');
  ok('it sits to the RIGHT of 🎚️ Mixer', !!mon && !!mix && mon.x > mix.x,
    mon && mix ? 'Mixer x=' + Math.round(mix.x) + ', Monitor x=' + Math.round(mon.x) : 'n/a');
}

// ── 2. Press the tab for real, then measure the pane ─────────────────────────
const tabBox = await page.evaluate(() => {
  const t = document.querySelector('.ambient-tabsec-tab[data-tab="monitor"]');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
if (tabBox) {
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, window.scrollY + y - 400)), tabBox.y);
  const b2 = await page.evaluate(() => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="monitor"]');
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.tap(b2.x, b2.y);
  await zz(400);
}

const pane = await page.evaluate(() => {
  const p = document.querySelector('.ambient-tabsec-pane.ambient-monitor');
  if (!p) return { missing: true };
  const pr = p.getBoundingClientRect();
  const chips = [...p.querySelectorAll('.ambient-mon-chip')].map((c) => {
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { key: c.getAttribute('data-monkey'), text: c.textContent.trim(),
             w: r.width, h: r.height, off: !!c.offsetParent,
             right: r.right, on: c.classList.contains('on'),
             hits: !!(hit && hit.closest && hit.closest('.ambient-mon-chip') === c) };
  });
  const all = p.querySelector('.ambient-mon-all');
  const ar = all ? all.getBoundingClientRect() : null;
  const want = (typeof _ambMixerLayers === 'function' && typeof _masterEng !== 'undefined')
    ? _ambMixerLayers(_masterEng.getCfg()).map((l) => l.key) : [];
  return { visible: getComputedStyle(p).display !== 'none' && !!p.offsetParent,
           paneRight: pr.right, paneLeft: pr.left, chips, want,
           all: all ? { text: all.textContent.trim(), w: ar.width, h: ar.height, off: !!all.offsetParent,
                        act: all.dataset.monact } : null,
           count: (p.querySelector('.ambient-mon-count') || {}).textContent,
           docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});

if (pane.missing) { ok('the Monitor pane exists', false); }
else {
  ok('pressing the tab SHOWS the pane', pane.visible === true);
  ok('one chip per layer', pane.chips.length === pane.want.length && pane.want.length > 0,
    pane.chips.length + ' chips for ' + pane.want.length + ' layers');
  ok('every chip is REACHABLE and hit-testable',
    pane.chips.length > 0 && pane.chips.every((c) => c.w > 0 && c.h > 0 && c.off && c.hits),
    pane.chips.filter((c) => !(c.w > 0 && c.h > 0 && c.off && c.hits)).map((c) => c.text).join(', ') || 'all ok');
  ok('the all-on/off button is REACHABLE and full width',
    !!pane.all && pane.all.off && pane.all.h > 0 && pane.all.w > (pane.paneRight - pane.paneLeft) * 0.9,
    pane.all ? '"' + pane.all.text + '" ' + Math.round(pane.all.w) + '×' + Math.round(pane.all.h) : 'missing');
  ok('its face is a VERB, not a bare state word',
    !!pane.all && /Silence all|Play all|Bring back/.test(pane.all.text), pane.all ? pane.all.text : 'n/a');
  // No horizontal scrolling, ever: measure each chip's right edge against its
  // parent's, never documentElement.scrollWidth (html/body clip it).
  ok('no chip overflows the pane',
    pane.chips.every((c) => c.right <= pane.paneRight + 1),
    'widest right edge ' + Math.round(Math.max(...pane.chips.map((c) => c.right)))
      + ' vs pane ' + Math.round(pane.paneRight));
  ok('the page does not scroll sideways', pane.docOverflow === false);
  ok('the count readout states the position', /\d+ of \d+ playing/.test(pane.count || ''), pane.count);
}

// ── 3. A real TOUCH on a chip must flip that layer, and only that layer ──────
const tap = async (sel) => {
  const b = await page.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.height > 0 };
  }, sel);
  if (!b || !b.ok) return false;
  await page.touchscreen.tap(b.x, b.y);
  await zz(250);
  return true;
};

const firstKey = pane.chips && pane.chips.length ? pane.chips[0].key : null;
if (firstKey) {
  const read = () => page.evaluate((k) => {
    const L = _ambLayerByKey(_masterEng, k);
    const chip = document.querySelector('.ambient-mon-chip[data-monkey="' + k + '"]');
    // the card's own head toggle, found the way _ambSyncLevelUI finds the card
    let cardOn = null;
    const cards = document.querySelectorAll('.ambient-layer');
    for (const c of cards) {
      const ph = c.querySelector('[data-phkey]');
      if (!ph || ph.getAttribute('data-phkey') !== k) continue;
      const b = c.querySelector('.ambient-layer-head .ambient-toggle');
      if (b) cardOn = b.classList.contains('on');
      break;
    }
    return { cfgOn: !!(L && L.on), chipOn: !!(chip && chip.classList.contains('on')), cardOn };
  }, firstKey);

  const before = await read();
  await tap('.ambient-mon-chip[data-monkey="' + firstKey + '"]');
  const after = await read();
  ok('a real touch on a chip FLIPS the layer in the config',
    after.cfgOn === !before.cfgOn, firstKey + ': ' + before.cfgOn + ' → ' + after.cfgOn);
  ok('the chip fill follows the config', after.chipOn === after.cfgOn,
    'chip ' + after.chipOn + ' / cfg ' + after.cfgOn);
  ok('the layer CARD toggle follows too (chip → card)',
    after.cardOn === null || after.cardOn === after.cfgOn,
    'card ' + after.cardOn + ' / cfg ' + after.cfgOn);

  await tap('.ambient-mon-chip[data-monkey="' + firstKey + '"]');
  const back = await read();
  ok('a second touch puts it back', back.cfgOn === before.cfgOn,
    before.cfgOn + ' → ' + back.cfgOn);

  // …and the reverse direction: press the CARD, the chip must move.
  const cardMoved = await page.evaluate((k) => {
    const cards = document.querySelectorAll('.ambient-layer');
    for (const c of cards) {
      const ph = c.querySelector('[data-phkey]');
      if (!ph || ph.getAttribute('data-phkey') !== k) continue;
      const b = c.querySelector('.ambient-layer-head .ambient-toggle');
      if (!b) return 'no toggle';
      b.click();
      return 'clicked';
    }
    return 'no card';
  }, firstKey);
  await zz(300);
  const rev = await read();
  ok('pressing the CARD moves the chip (card → chip)',
    cardMoved !== 'clicked' || rev.chipOn === rev.cfgOn,
    cardMoved + ': chip ' + rev.chipOn + ' / cfg ' + rev.cfgOn);
  if (cardMoved === 'clicked') {
    await page.evaluate((k) => {
      const cards = document.querySelectorAll('.ambient-layer');
      for (const c of cards) {
        const ph = c.querySelector('[data-phkey]');
        if (!ph || ph.getAttribute('data-phkey') !== k) continue;
        const b = c.querySelector('.ambient-layer-head .ambient-toggle'); if (b) b.click();
        break;
      }
    }, firstKey);
    await zz(250);
  }
}

// ── 4. Silence all → Bring back N restores exactly what was playing ──────────
const onSet = () => page.evaluate(() =>
  _ambMixerLayers(_masterEng.getCfg()).filter((l) => !!l.layer.on).map((l) => l.key).sort());

const wasOn = await onSet();
await tap('.ambient-mon-all');
const afterAll = await onSet();
const faceAfter = await page.evaluate(() => {
  const b = document.querySelector('.ambient-mon-all');
  return b ? { text: b.textContent.trim(), act: b.dataset.monact } : null;
});
ok('Silence all turns EVERY layer off', afterAll.length === 0, afterAll.join(', ') || 'none on');
ok('…and the face becomes "Bring back N"',
  !!faceAfter && faceAfter.act === 'restore' && faceAfter.text.includes(String(wasOn.length)),
  faceAfter ? faceAfter.text : 'n/a');

await tap('.ambient-mon-all');
const restored = await onSet();
ok('Bring back restores EXACTLY the set that was playing',
  JSON.stringify(restored) === JSON.stringify(wasOn),
  'was [' + wasOn.join(', ') + '] → now [' + restored.join(', ') + ']');

ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed' + (fail ? '  — FAIL' : ''));
process.exit(fail ? 1 : 0);
