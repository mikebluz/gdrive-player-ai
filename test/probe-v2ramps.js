// PROBE — ⇗ RAMPS ON A v2 LAYER CARD.
//
// "v2 layers should have ramps." The engine half was already there: the ramp
// table has a 61-target `v2` entry, `_ambRampTargetGroups` lists v2 layers, and
// a saw on `part.rhythm.pulses` genuinely sweeps (1·5·9·12·1·5·9·12). What was
// missing was the ＋ Ramp block on the card — every v1 layer card renders one
// and the v2 card did not, so the only way in was the Area ▸ Ramps block.
//
// The cause is one this file keeps paying for: v2's cards live in their own
// host (`#bloom-v2-layers`), and `_ambRenderRamps` swept only `E.hostId`. A new
// layer store must join EVERY sweep.
//
//   node test/probe-v2ramps.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(900);
  await page.evaluate(() => { const c = document.querySelector('.v2-layer'); if (c) {
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open')); } });
  await zz(600);

  // ── THE BLOCK IS ON THE CARD, AND REACHABLE ──────────────────────────
  const box = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer'); if (!card) return { err: 'no card' };
    const blk = card.querySelector('.ambient-layer-ramps');
    const btn = card.querySelector('.ambient-ramp-add');
    if (!blk || !btn) return { err: 'no ramp block', has: !!blk, hasBtn: !!btn };
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { key: blk.getAttribute('data-rampkey'),
             w: Math.round(r.width), h: Math.round(r.height),
             on: !!btn.offsetParent, covered: !(hit === btn || btn.contains(hit)),
             inV2Host: !!document.getElementById('bloom-v2-layers')?.contains(btn) };
  });
  const id = await page.evaluate(() => (_masterEng.getCfg().layers || [])[0].id);
  ok('the v2 card carries a Ramps block keyed to this layer',
    box.key === 'v2:' + id, JSON.stringify(box));
  // It lives in `#bloom-v2-layers`, which is INSIDE the panel host — so the
  // existing sweep and the existing ＋ listener both reach it with no change.
  // Poison-verified: restricting the sweep to `E.hostId` explicitly changes
  // nothing. The block simply was not being emitted.
  ok('…and it sits in the v2 host, reached by the existing sweep',
    box.inV2Host === true, JSON.stringify(box));
  ok('…with a ＋ Ramp button that is REACHABLE — real box, nothing over it',
    box.on && box.w > 40 && box.h > 10 && !box.covered, JSON.stringify(box));

  // STOP CLEANLY IF THE BLOCK IS NOT THERE. Every check below drives it, so
  // without this the whole file dies on `null.click()` and the report is a
  // stack trace instead of three named failures — which is exactly what the
  // poison run produced the first time. A gate has to fail legibly, not crash.
  if (box.err || !box.key) {
    ok('＋ Ramp adds exactly ONE ramp, owned by THIS layer', false, 'no Ramps block on the card');
    ok('…and the row renders inside the card, not somewhere else', false, 'no Ramps block on the card');
    ok('the row has a reachable target picker', false, 'no Ramps block on the card');
    ok('…and this layer’s own parameters are on offer', false, 'no Ramps block on the card');
    ok('a ramp on a v2 parameter sweeps it', false, 'not reached');
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    await browser.close();
    process.exit(1);
  }

  // ── AND ON A CARD THAT ALREADY EXISTS ────────────────────────────────
  // `V2.render` has TWO paths. The structure-signature early return — which
  // fires for every value edit on an unchanged set of cards, i.e. nearly every
  // render — re-applies the gate and bails. The first version of this feature
  // only appended on the full-rebuild path, so a layer added after page load
  // got the block and one that was already there never did. The gate missed it
  // because it builds a FRESH layer; this drives the path a real card takes.
  const persists = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const grp = card.querySelector('.ambient-grp[data-v2grp="Mix"]');
    const before = !!card.querySelector('.ambient-layer-ramps');
    // re-render with NO structural change — the early-return path, which is
    // what nearly every render takes
    window._v2.render(_masterEng);
    window._v2.render(_masterEng);
    const c2 = document.querySelector('.v2-layer');
    const after = c2.querySelector('.ambient-layer-ramps');
    return { before, inGroup: !!(grp && grp.contains(card.querySelector('.ambient-layer-ramps'))),
             still: !!after, key: after ? after.getAttribute('data-rampkey') : null,
             onePerCard: document.querySelectorAll('.v2-layer .ambient-layer-ramps').length,
             tab: (() => { const row = after && after.closest('.ambient-ctrl');
                    return row ? row.getAttribute('data-v2tab') : null; })(),
             innerTabs: after ? after.querySelectorAll('[data-v2tab]').length : -1,
             secs: (window._v2.secs ? window._v2.secs() : []) };
  });
  ok('the block lives INSIDE the Mix group, not bolted under the card',
    persists.inGroup === true, JSON.stringify(persists));
  ok('…and survives re-renders that take the early-return path',
    persists.still === true && persists.key === 'v2:' + id, JSON.stringify(persists));
  ok('…exactly one per card, however many times render runs',
    persists.onePerCard === 1, JSON.stringify(persists));
  // A TAB OF MIX, not a section of its own — so the navigator is unchanged and
  // the block carries `data-v2tab="Ramps"`, which is what makes the sheet give
  // it a tab beside Mod.
  ok('Ramps is NOT its own section \u2014 the navigator is unchanged',
    (persists.secs || []).indexOf('Ramps') < 0, JSON.stringify(persists.secs));
  // The stamp is on the ROW (`.ambient-ctrl.v2-rampctl`) — that is what
  // `syncSheet` groups into tabs; the block inside is v1's markup, untouched.
  ok('\u2026it is a TAB of Mix, stamped on its row',
    persists.tab === 'Ramps', JSON.stringify(persists));
  ok('\u2026and the stamp is on the OUTER div only, not its children',
    persists.innerTabs === 0, JSON.stringify(persists));

  // The check above REMOVES the block to prove render puts it back, so every
  // check below it depends on that having worked. Bail legibly rather than
  // dying on a null button — the same lesson as the guard further up, which I
  // wrote and then walked straight past when adding this check.
  if (!persists.still) {
    ok('＋ Ramp adds exactly ONE ramp, owned by THIS layer', false, 'block not restored by render');
    ok('…and the row renders inside the card, not somewhere else', false, 'block not restored by render');
    ok('the row has a reachable target picker', false, 'block not restored by render');
    ok('…and this layer’s own parameters are on offer', false, 'block not restored by render');
    ok('a ramp on a v2 parameter sweeps it', false, 'not reached');
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    await browser.close();
    process.exit(1);
  }

  // ── PRESSING IT MAKES A RAMP ON THIS LAYER ───────────────────────────
  const added = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const btn = card.querySelector('.ambient-ramp-add');
    const before = ((_masterEng.getCfg().ramps) || []).length;
    btn.click();
    const cfg = _masterEng.getCfg();
    const rs = cfg.ramps || [];
    const mine = rs.filter((r) => r && r.layerKey === 'v2:' + (card.getAttribute('data-v2id') | 0));
    return { before, after: rs.length, mine: mine.length,
             key: mine[0] ? mine[0].layerKey : null,
             rowsInCard: card.querySelectorAll('.ambient-layer-ramps-list .ambient-ramp-row').length };
  });
  // EXACTLY ONE. The v2 host sits inside the panel host, so the delegated
  // listener already bound there catches this press; adding a second listener
  // on the v2 host made one tap add TWO (measured) — the double-wiring trap, in
  // the add direction instead of the cancel one. This count is what pins it.
  ok('＋ Ramp adds exactly ONE ramp, owned by THIS layer',
    added.after === added.before + 1 && added.mine === 1 && added.key === 'v2:' + id,
    JSON.stringify(added));
  ok('…and the row renders inside the card, not somewhere else',
    added.rowsInCard >= 1, JSON.stringify(added));

  // ── ITS TARGET MENU OFFERS THIS LAYER'S OWN PARAMS ───────────────────
  // The target control is a BUTTON that opens a menu, not a <select> — the
  // first <select> in the row is the waveform, which is what an earlier version
  // of this check measured (5 options, none of them a target).
  const targets = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const btn = card.querySelector('.ambient-ramp-target');
    const r = btn ? btn.getBoundingClientRect() : null;
    let v2 = 0, sample = [];
    try {
      const gs = window._ambRampTargetGroups(_masterEng.getCfg()) || [];
      const mine = gs.find((g) => (g.items || []).some((i) => /^v2:/.test(i.value)));
      v2 = mine ? mine.items.length : 0;
      sample = mine ? mine.items.slice(0, 3).map((i) => i.label) : [];
    } catch (e) {}
    return { hasBtn: !!btn, w: r ? Math.round(r.width) : 0,
             on: !!(btn && btn.offsetParent), v2, sample };
  });
  ok('the row has a reachable target picker',
    targets.hasBtn && targets.on && targets.w > 40, JSON.stringify(targets));
  ok('…and this layer’s own parameters are on offer',
    targets.v2 > 20, JSON.stringify(targets));

  // ── AND A RAMP ON A v2 PARAM ACTUALLY SWEEPS IT ──────────────────────
  const swept = await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live';
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0, n: 1 };
    E.getCfg();
    const cfg = E.getCfg();
    cfg.ramps = [{ id: 99, on: true, layerKey: 'v2:' + (L.id | 0),
                   target: 'v2:' + (L.id | 0) + '.part.rhythm.pulses',
                   a: 1, b: 16, wave: 'saw', periodSec: 8 }];
    E.getCfg();
    const seen = [];
    for (let i = 0; i <= 8; i++) {
      try { window._ambApplyRamps(E.getCfg(), i); } catch (e) {}
      seen.push((E.getCfg().layers || [])[0].part.rhythm.pulses);
    }
    const c2 = E.getCfg(); c2.ramps = []; E.getCfg();
    return { seen, distinct: new Set(seen).size };
  });
  ok('a ramp on a v2 parameter sweeps it',
    swept.distinct > 2, JSON.stringify(swept));
  console.log('      pulses over 8 ticks: ' + JSON.stringify(swept.seen));

  // ── AND THE TAB ACTUALLY RENDERS IN THE MIX SHEET ────────────────────
  // LAST, because it navigates the card and would disturb every check above
  // it — the first version clicked the group HEAD (which opens the group
  // inline, not the sheet) and left the target picker at 0 wide.
  // The sheet is navigated by its own chips: the card opens on Content, and
  // `.v2-gototab[data-goto="Mix"]` is how a finger gets to Mix.
  // The card must be expanded BY ITS HANDLER — `classList.remove('collapsed')`
  // (what the setup above does) skips the code that opens the default sheet,
  // so there is no navigator to click. Collapse, then tap the caret for real.
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer'); if (c) c.classList.add('collapsed');
  });
  await zz(300);
  const caret = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer .ambient-collapse'); if (!c) return null;
    c.scrollIntoView({ block: 'center' });
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (caret) await page.touchscreen.tap(caret.x, caret.y);
  await zz(900);
  await page.evaluate(() => {
    document.querySelectorAll('.v2-secpop-close').forEach((b2) => b2.click());
    const g = document.querySelector('.v2-layer .v2-gototab[data-goto="Mix"]');
    if (g) g.click();
  });
  await zz(900);
  const tabInfo = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const all = [...card.querySelectorAll('.v2-pop-tabs button, .v2-pop-tab')];
    const chips = all.map((e) => (e.textContent || '').trim());
    const chip = all.find((e) => /^Ramps$/i.test((e.textContent || '').trim()));
    const r = chip ? chip.getBoundingClientRect() : null;
    return { chips, has: !!chip, w: r ? Math.round(r.width) : 0,
             on: !!(chip && chip.offsetParent) };
  });
  ok('the Mix sheet shows a Ramps tab, beside Mod',
    tabInfo.has && tabInfo.on && tabInfo.w > 20, JSON.stringify(tabInfo));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
