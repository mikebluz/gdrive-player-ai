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
    ok('pressing it BUILDS the target menu', false, 'not reached');
    ok('…above the section sheet it was opened from, not under it', false, 'not reached');
    ok('…a tap ticks a target and the button face names it', false, 'not reached');
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
    ok('pressing it BUILDS the target menu', false, 'not reached');
    ok('…above the section sheet it was opened from, not under it', false, 'not reached');
    ok('…a tap ticks a target and the button face names it', false, 'not reached');
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

  // ── …AND THE MENU IT OPENS IS ON TOP OF THE SHEET IT OPENED FROM ─────
  // (2026-09-26, reported as "the Ramp target dropdown does nothing on click".)
  // A BOX ON THE BUTTON PROVES NOTHING ABOUT THE SURFACE BEHIND IT — which is
  // how this survived the checks above for six days. `.modal-overlay` is z 1200
  // and `.v2-secpop-wrap` is 10250, so opened from Mix ▸ Ramps the modal BUILT
  // COMPLETELY, 390×780 with all 61 targets in it, and painted UNDER the sheet:
  // the centre of its first item hit-tested to `.ambient-ramps-head-mini`, a row
  // of the sheet on top of it. A built-but-covered panel and a handler that never
  // ran look identical from the outside and are opposite bugs, so this measures
  // the DOM growth AND the hit test, then drives the item and reads the face.
  const menu = await page.evaluate(async () => {
    const c = document.querySelector('.v2-layer');
    document.querySelectorAll('.v2-secpop-close').forEach((b2) => b2.click());
    // DRIVE THE HEAD. `classList.remove('collapsed')` is not expanding a card —
    // the head's own handler is what calls `popOpen`, and the section doors live
    // in the sheet it builds. The checks above leave this card expanded with NO
    // pop head (they re-render it directly), so cycle it: collapse, then open.
    const hd = c.querySelector('.ambient-layer-head');
    for (let i = 0; i < 2 && !c.querySelector('.v2-gototab[data-goto="Mix"]'); i++) {
      if (hd) hd.click();
      await new Promise((r) => setTimeout(r, 600));
    }
    const c1 = document.querySelector('.v2-layer');
    const g = c1.querySelector('.v2-gototab[data-goto="Mix"]');
    if (!g) return { err: 'no Mix door', cls: c1.className,
      gotos: [...c1.querySelectorAll('.v2-gototab')].map((b3) => b3.getAttribute('data-goto')) };
    g.click();
    await new Promise((r) => setTimeout(r, 550));
    const t = [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Ramps');
    if (!t) return { err: 'no Ramps tab', chips: [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')].map((x) => x.getAttribute('data-tab')) };
    t.click();
    await new Promise((r) => setTimeout(r, 350));
    const btn = document.querySelector('.v2-layer .ambient-ramp-target');
    if (!btn) return { err: 'no target button in the sheet' };
    const wasFace = btn.textContent.trim();
    const before = document.querySelectorAll('.modal-overlay').length;
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const ov = document.querySelector('.modal-overlay.amb-ramptgt-ov');
    if (!ov) return { err: 'no overlay', before };
    const it = ov.querySelector('.amb-ramptgt-item');
    if (!it) return { err: 'no items', before };
    const r2 = it.getBoundingClientRect();
    const hit = document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2);
    const out = { before, after: document.querySelectorAll('.modal-overlay').length,
                  z: getComputedStyle(ov).zIndex, sheetZ: (() => { const w = document.querySelector('.v2-secpop-wrap');
                    return w ? getComputedStyle(w).zIndex : null; })(),
                  hit: hit ? (hit.tagName + '.' + hit.className) : null,
                  hitOk: !!(hit && hit.closest && hit.closest('.amb-ramptgt-item')),
                  label: it.textContent.trim(), wasFace };
    it.click();
    await new Promise((r) => setTimeout(r, 250));
    out.ticked = !!ov.querySelector('.amb-ramptgt-item.on');
    const done = ov.querySelector('.amb-ramptgt-ok'); if (done) done.click();
    await new Promise((r) => setTimeout(r, 400));
    const face = document.querySelector('.v2-layer .ambient-ramp-target');
    out.face = face ? face.textContent.trim() : null;
    out.closed = !document.querySelector('.modal-overlay.amb-ramptgt-ov');
    return out;
  });
  await zz(300);
  ok('pressing it BUILDS the target menu', menu.after === menu.before + 1, JSON.stringify(menu));
  ok('…above the section sheet it was opened from, not under it',
    menu.hitOk && (+menu.z > +menu.sheetZ), JSON.stringify(menu));
  ok('…a tap ticks a target and the button face names it',
    menu.ticked && menu.closed && menu.face && menu.face !== '+ Targets…', JSON.stringify(menu));

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
  // (♫ Mod moved to FX on 2026-09-26 at the user's request, so Ramps is the
  // only automation tab left in Mix — it is still a TAB, which is what this asks.)
  ok('the Mix sheet shows a Ramps tab',
    tabInfo.has && tabInfo.on && tabInfo.w > 20, JSON.stringify(tabInfo));

  // —— THE TARGET LIST: SUBSECTIONS, AND THE PARAMS THAT WERE MISSING —————
  // (2026-09-26, user: "needs to be organized with subsections, also it's missing a lot
  // of params; add as many as possible, including Mod".) ♫ Mod is the one to assert
  // hardest: it is THREE levels deep, so the generic nested-FX branch would have written
  // `obj.mod['vca.depth']` — a field nothing reads, which measures as a ramp that runs
  // and is silent.
  console.log('\n  ◇ the target list — sections, and Mod');
  const tl = await page.evaluate(() => {
    const cfg = _masterEng.getCfg();
    const gs = _ambRampTargetGroups(cfg) || [];
    const mine = gs.find(g => (g.items || []).some(i => /^v2:/.test(i.value)));
    const items = mine ? mine.items : [];
    const secs = [];
    items.forEach(i => { if (secs.indexOf(i.sec) < 0) secs.push(i.sec); });
    const has = (k) => items.some(i => i.value.indexOf('.' + k) === i.value.indexOf('.') && i.value.slice(i.value.indexOf('.') + 1) === k);
    // resolve + WRITE each new family, then read the store back through getCfg
    const L = (cfg.layers || [])[0];
    // ◇ Tone set is INERT WITHOUT A SET: `toneSeq` with no `steps` is pruned by the
    // normalizer, so a palette ramp on a layer that has no voices listed writes
    // nothing — correct, and it means this check has to give it a set first.
    L.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 4 }, { tone: 'square', bars: 4 }] };
    _masterEng.getCfg();
    const key = 'v2:' + (L.id | 0);
    const drive = (k, v) => { const r = _ambRampResolve(_masterEng.getCfg(), key + '.' + k);
      if (!r) return 'no resolve'; if (r.set) r.set(v); else r.obj[r.key] = v;
      return null; };
    const errs2 = [];
    [['mod.vca.depth', 61], ['mod.vco.rate', 42], ['eq.low', -7], ['tg.depth', 33],
     ['toneSeq.pal', 80], ['portamento', 250], ['instrument.attack', 900],
     ['part.timing.lean', -20], ['pecho.timeMs', 600]].forEach(pr => {
      const e = drive(pr[0], pr[1]); if (e) errs2.push(pr[0] + ': ' + e);
    });
    const L2 = (_masterEng.getCfg().layers || []).find(x => (x.id | 0) === (L.id | 0));
    return { n: items.length, secs, errs2,
             modNested: ((L2.mod || {}).vca || {}).depth,
             modFlatBug: !!(L2.mod && ('vca.depth' in L2.mod)),
             modRate: ((L2.mod || {}).vco || {}).rate,
             eq: (L2.eq || {}).low, tg: (L2.tg || {}).depth, pal: (L2.toneSeq || {}).pal,
             glide: L2.portamento, atk: (L2.instrument || {}).attack,
             lean: (((L2.part || {}).timing) || {}).lean, echo: (L2.pecho || {}).timeMs };
  });
  console.log('     ' + tl.n + ' targets in ' + tl.secs.length + ' sections: ' + JSON.stringify(tl.secs));
  ok('every target carries a subsection, and there are several',
    tl.secs.length >= 8 && tl.secs.every(x => !!x), JSON.stringify(tl.secs));
  ok('♫ Mod is on offer, and every resolve succeeded',
    JSON.stringify(tl.errs2) === '[]', JSON.stringify(tl.errs2));
  ok('…a Mod ramp writes THREE levels down, not a dotted key nothing reads',
    tl.modNested === 61 && tl.modRate === 42 && tl.modFlatBug === false, JSON.stringify(tl));
  ok('…and ≡ EQ · ▦ Chop · ◇ Tone set · Glide · Envelope · Lean · Pitch echo all land',
    tl.eq === -7 && tl.tg === 33 && tl.pal === 80 && tl.glide === 250 &&
    tl.atk === 900 && tl.lean === -20 && tl.echo === 600, JSON.stringify(tl));

  // …and the picker actually DRAWS the sections, with a find box that narrows
  const pk = await page.evaluate(async () => {
    const c = document.querySelector('.v2-layer');
    document.querySelectorAll('.v2-secpop-close').forEach((b2) => b2.click());
    const hd = c.querySelector('.ambient-layer-head');
    for (let i = 0; i < 2 && !c.querySelector('.v2-gototab[data-goto="Mix"]'); i++) {
      if (hd) hd.click();
      await new Promise((r) => setTimeout(r, 600));
    }
    const g = document.querySelector('.v2-layer .v2-gototab[data-goto="Mix"]');
    if (!g) return { err: 'no Mix door' };
    g.click();
    await new Promise((r) => setTimeout(r, 550));
    const t9 = [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Ramps');
    if (t9) t9.click();
    await new Promise((r) => setTimeout(r, 350));
    // A FRESH RAMP. The sweep check above replaces `cfg.ramps` wholesale, so the row
    // still on screen names an id the store no longer has — and `_ambShowRampTargetsMenu`
    // bails on that (`if (!getR()) return`), which measures as a dead button.
    const add9 = document.querySelector('.v2-layer .ambient-ramp-add');
    if (add9) { add9.click(); await new Promise((r) => setTimeout(r, 450)); }
    const rows9 = [...document.querySelectorAll('.v2-layer .ambient-ramp-target')];
    const btn = rows9[rows9.length - 1];
    if (!btn) return { err: 'no target button' };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const ov = document.querySelector('.modal-overlay.amb-ramptgt-ov');
    if (!ov) return { err: 'no overlay' };
    const secs = [...ov.querySelectorAll('.amb-ramptgt-sec')].map(n => n.textContent.trim());
    const find = ov.querySelector('.amb-ramptgt-find');
    const before = [...ov.querySelectorAll('.amb-ramptgt-item')].filter(n => !n.hidden).length;
    // MEASURE BEFORE FILTERING. Measured after, the first heading is one the filter has
    // just hidden, so it reads 0×0 and the check calls a working control missing — the
    // documented 0×0 tell, self-inflicted.
    const s0 = ov.querySelector('.amb-ramptgt-sec');
    const r0 = s0 ? s0.getBoundingClientRect() : null;
    find.value = 'vca'; find.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const after = [...ov.querySelectorAll('.amb-ramptgt-item')].filter(n => !n.hidden).length;
    const heads = [...ov.querySelectorAll('.amb-ramptgt-sec')].filter(n => !n.hidden).map(n => n.textContent.trim());
    find.value = ''; find.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const restored = [...ov.querySelectorAll('.amb-ramptgt-item')].filter(n => !n.hidden).length;
    const done = ov.querySelector('.amb-ramptgt-ok'); if (done) done.click();
    await new Promise((r) => setTimeout(r, 300));
    return { secs, before, after, heads, restored, w: r0 ? Math.round(r0.width) : 0 };
  });
  ok('the picker draws the subsection headings, measured', (pk.secs || []).length >= 8 && pk.w > 40,
    JSON.stringify(pk));
  ok('…a search narrows the list', pk.after > 0 && pk.after < pk.before,
    JSON.stringify([pk.before, pk.after]));
  ok('…and leaves only the headings that still have rows under them',
    (pk.heads || []).length > 0 && (pk.heads || []).length < (pk.secs || []).length,
    JSON.stringify(pk.heads));
  ok('…clearing it puts every row back', pk.restored === pk.before,
    JSON.stringify([pk.before, pk.restored]));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
