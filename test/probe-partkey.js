// PROBE — A PART'S KEY MUST NAME THE CHORDS SHOWN BESIDE IT.
//
// user, 2026-09-27: "why is F# the I chord in the key of E major here".
//
// The overview shifts every chord by `_ambProgViewShift` before drawing it — that is
// what puts the progression in the area key. The part's key chip beside them named the
// UNSHIFTED key, and the chip numerals measured a SHIFTED chord against that unshifted
// root: three surfaces on one row, in two different spaces.
//
// Measured before the fix, chords stored E7·A7·B7 with a part key of E and a shift of 10:
//     chip "♪ E Major"   root "⌂ D"   chords D7·G7·A7   numerals I7–IV7–V7
// — which reads exactly as the report: the I is not the key's tonic. After:
//     chip "♪ D Major"   root "⌂ D"   chords D7·G7·A7   numerals I7–IV7–V7
//
// `_ambPartNumerals` also called `_ambProgViewShift(cfg, chords)` against a signature of
// `(E, cfg, chords, atSec)`, so it read the chord array as `cfg` and returned 0. That one
// is invisible in the DEGREES (shifting chord and key by the same amount cancels), which
// is why it survived — but it is one edit from being visibly wrong, so it is asserted too.
//
//   node test/probe-partkey.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(800);

  // TWO parts — `prog.parts` is pruned at one, so a single-part fixture has no part
  // key to show at all.
  const model = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    const CH = (root, sev) => ({ root, intervals: sev ? [0, 4, 7, 10] : [0, 4, 7], bars: 1 });
    c.prog.on = true;
    c.prog.chords = [CH(2, 0), CH(6, 0), CH(7, 0), CH(4, 1), CH(9, 1), CH(11, 1)];
    c.prog.parts = [{ name: 'Intro', len: 3 },
                    { name: 'I — IV — V', len: 3, key: { root: 4, scale: 'major' } }];
    c.keyOn = true; c.keyRoot = 6; c.keyScale = 'major'; c.keyMode = 'transpose';
    const c2 = E.getCfg();
    return { shift: _ambProgViewShift(E, c2, c2.prog.chords),
             shiftWrongArgs: _ambProgViewShift(c2, c2.prog.chords),
             numerals: _ambPartNumerals(c2, 1),   // true to its name: numerals
             partKeyRoot: c2.prog.parts[1].key.root };
  });
  ok('the fixture really does transpose the view', (model.shift | 0) !== 0, JSON.stringify(model));
  ok('…and the STORE is untouched — the shift is a view, not a rewrite',
    model.partKeyRoot === 4, String(model.partKeyRoot));

  const seen = await page.evaluate(async () => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]');
    if (t) t.click();
    await new Promise((r) => setTimeout(r, 500));
    const h = document.querySelector('.ambient-proggrp .ambient-grp-head[data-grp="\u25a4 Parts"]');
    if (h) h.click();
    try { _ambRenderProgOverview(_masterEng); } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
    const ov = document.querySelector('[id$="prog-overview"]');
    if (!ov) return { err: 'no overview' };
    const parts = [...ov.querySelectorAll('.ambient-pov-part')];
    const pt = parts[parts.length - 1];
    if (!pt) return { err: 'no part card' };
    return {
      name: ((pt.querySelector('.ambient-pov-partname') || {}).textContent || '').trim(),
      key: ((pt.querySelector('.ambient-pov-partkey') || {}).textContent || '').trim(),
      root: ((pt.querySelector('.ambient-pov-partroot') || {}).textContent || '').trim(),
      chips: [...pt.querySelectorAll('.ambient-pov-chord')].map((x) => x.textContent.trim()),
    };
  });
  ok('the chord chips are the TRANSPOSED chords', JSON.stringify(seen.chips) === '["D7","G7","A7"]',
    JSON.stringify(seen.chips));
  // THE WHOLE POINT: the key chip has to name the chords beside it.
  ok('the key chip names the key those chords are IN', /D Major/.test(seen.key || ''),
    JSON.stringify(seen.key));
  ok('…and it agrees with the root chip on the same row',
    /D/.test(seen.root || '') && (seen.key || '').indexOf('D') >= 0, JSON.stringify([seen.key, seen.root]));
  ok('…so the first chord really is the I of the key named',
    /I7/.test(model.numerals || '') && seen.chips[0] === 'D7', JSON.stringify([model.numerals, seen.chips[0]]));
  ok('_ambProgViewShift is called with E FIRST — (cfg, chords) silently returns 0',
    (model.shiftWrongArgs | 0) === 0 && (model.shift | 0) !== 0,
    JSON.stringify([model.shift, model.shiftWrongArgs]));

  // ---- PICKING A KEY LANDS ON THE KEY YOU PICKED -------------------------------
  // (2026-09-27, reported as "I chose F major and it made a part in G major", and
  // "nothing happens".) The chip, the root and the numerals all read in DISPLAYED space;
  // the picker was the one surface still writing raw STORED values, so every pick landed
  // out by the view shift — and picking the key the chip already showed changed the
  // store while the drawing stayed put, which is what "nothing happens" looks like.
  console.log('\n  ♪ picking a key');
  const pick = await page.evaluate(() => {
    const E = _masterEng, c = E.getCfg();
    const vs = _ambProgViewShift(E, c, c.prog.chords) | 0;
    const part = c.prog.parts[1];
    // WHAT THIS DOES AND DOES NOT COVER: it asserts the ROUND TRIP — a key chosen in
    // the menu's space stores unshifted and reads back as the key chosen — which is the
    // invariant that broke. It does NOT drive `_ambPartKeyMenu` itself; stubbing
    // `showCtxMenu` to walk its submenus proved fiddly enough to be its own bug source,
    // so the menu's two lines (the ✓ test and the `unshift` on write) are covered by
    // reading, not by this gate. If they drift, this check will not catch it.
    const want = 5;                                  // F, as the MENU offers it
    part.key = { root: ((((want - vs) % 12) + 12) % 12), scale: 'major' };
    E.getCfg();
    const c2 = E.getCfg();
    const shownRoot = _ambPartKeyShifted(c2.prog.parts[1].key, vs).root;
    return { vs, stored: c2.prog.parts[1].key.root, shown: shownRoot,
             label: _ambKeyLabel(shownRoot, 'major') };
  });
  ok('the view shift is real in this fixture, or the check proves nothing',
    pick.vs !== 0, JSON.stringify(pick));
  ok('a key chosen in the menu\u2019s space stores in the progression\u2019s own space',
    pick.stored === ((((5 - pick.vs) % 12) + 12) % 12), JSON.stringify(pick));
  ok('\u2026and reads back as exactly the key that was chosen, not that key plus the shift',
    pick.shown === 5 && /F/.test(pick.label), JSON.stringify(pick));

  // ---- NAMES, NOT NUMERALS ----------------------------------------------------
  // (2026-09-27, user: "numerals are too obtuse as default — names of Parts should be
  // the actual chords the progression is in the selected Key".) "I — III — IV"
  // describes a relationship and identifies nothing you can hear, and it led every part
  // card. Both readings walk the SAME chords through the SAME view shift — one
  // function, two modes — so the header and the chips under it cannot spell a chord two
  // ways, which is the failure the numerals had until today.
  console.log('\n  ♪ the part label');
  const lab = await page.evaluate(() => {
    const c = _masterEng.getCfg();
    return { names: _ambPartLabel(c, 1), numerals: _ambPartLabel(c, 1, 'numerals'),
             chips: (function () {
               const ov = document.querySelector('[id$="prog-overview"]');
               const ps = ov ? [...ov.querySelectorAll('.ambient-pov-part')] : [];
               const pt = ps[ps.length - 1];
               return pt ? [...pt.querySelectorAll('.ambient-pov-chord')].map((x) => x.textContent.trim()) : [];
             })() };
  });
  ok('a derived part name reads as CHORDS by default', /D7|D/.test(lab.names) && !/^\d+ · I/.test(lab.names),
    JSON.stringify(lab.names));
  ok('…Ⅰ Numerals is still one press away, on the same walk',
    /I7|I/.test(lab.numerals) && lab.numerals !== lab.names, JSON.stringify([lab.names, lab.numerals]));
  ok('…and the header spells them exactly as the chips below it do',
    lab.chips.length > 0 && lab.chips.every((c2) => lab.names.indexOf(c2) >= 0),
    JSON.stringify([lab.names, lab.chips]));

  // ---- THE CARD WEARS THE CURRENT PART'S COLOUR --------------------------------
  // (user: "layers should take on color of current part so it's totally obvious what
  // part is currently selected/active".) `data-part` is the axis the ordinal rail, the
  // overview cards and the roll's note events already use — the card joins it.
  console.log('\n  ▤ the layer card follows the part');
  // this file's fixture is arrangement-only — there is no layer card until now
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click(); });
  await zz(700);
  const hue = await page.evaluate(async () => {
    const E = _masterEng;
    try { _ambRebuildMaster(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 900));
    const seen = [];
    for (const pi of [0, 1]) {
      E._curPart = pi;
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      try { window._v2.render(E); } catch (e) {}
      const card = document.querySelector('.v2-layer');
      if (!card) return { err: 'no card' };
      seen.push({ attr: card.getAttribute('data-part'),
                  border: getComputedStyle(card).borderLeftColor });
    }
    // …and with ONE part there is nothing to tell apart, so no colour is claimed
    const c = E.getCfg(); c.prog.parts = [{ name: 'Only', len: 6 }]; E.getCfg();
    const h2 = document.getElementById('bloom-v2-layers'); if (h2) h2._sig = '';
    try { window._v2.render(E); } catch (e) {}
    const solo = document.querySelector('.v2-layer');
    return { seen, oneAttr: solo ? solo.getAttribute('data-part') : 'no card' };
  });
  ok('the card is stamped with the part you are on', !hue.err &&
    hue.seen[0].attr === '1' && hue.seen[1].attr === '2', JSON.stringify(hue.seen));
  // THE PATH WITHOUT A REBUILD. A part change leaves the card SET untouched, so
  // `V2.render` takes its structure-signature early return — and the stamp first lived
  // only in the rebuild half, which is why the colour moved only sometimes.
  const noRebuild = await page.evaluate(async () => {
    const E = _masterEng;
    // the one-part check above left a single part behind, and with one part the cards
    // deliberately claim no colour — put two back or this measures that rule instead
    const c = E.getCfg();
    c.prog.parts = [{ name: 'Intro', len: 3 }, { name: 'B', len: 3, key: { root: 4, scale: 'major' } }];
    E.getCfg();
    E._curPart = 0; const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = '';
    try { window._v2.render(E); } catch (e) {}
    const before = (document.querySelector('.v2-layer') || {}).getAttribute
      ? document.querySelector('.v2-layer').getAttribute('data-part') : null;
    // …now change ONLY the part and re-render WITHOUT clearing the signature
    E._curPart = 1;
    try { window._v2.render(E); } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
    const after = document.querySelector('.v2-layer').getAttribute('data-part');
    // …and the viz-frame hook, which is what follows the SOUNDING part
    window._v2.paintPart(E, 0);
    const painted = document.querySelector('.v2-layer').getAttribute('data-part');
    return { before, after, painted };
  });
  ok('…and a part change repaints WITHOUT a structural rebuild',
    noRebuild.before === '1' && noRebuild.after === '2', JSON.stringify(noRebuild));
  ok('…while the per-frame hook can paint the SOUNDING part directly',
    noRebuild.painted === '1', JSON.stringify(noRebuild));
  ok('…and the two parts give the card two DIFFERENT colours',
    !hue.err && hue.seen[0].border !== hue.seen[1].border, JSON.stringify(hue.seen));
  ok('…while one part claims no colour at all — nothing to tell apart',
    hue.oneAttr === null, String(hue.oneAttr));
  // THE PART MARKER MUST NOT DRAW ACROSS THE HEAD. An `inset 0 -1px` shadow there spans
  // the head's full width, and the head is a flex row CONTAINING the ⋯ and caret
  // buttons — so it ran straight through them and read as a stray rule colliding with
  // their borders. Reported within the hour of shipping it.
  const noRule = await page.evaluate(async () => {
    const E = _masterEng;
    const c = E.getCfg();
    c.prog.parts = [{ name: 'A', len: 3 }, { name: 'B', len: 3 }];
    E.getCfg(); E._curPart = 0;
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    try { window._v2.render(E); } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
    const card = document.querySelector('.v2-layer');
    if (!card) return { err: 'no card' };
    const hd = card.querySelector('.ambient-layer-head');
    const cs = hd && getComputedStyle(hd);
    return { attr: card.getAttribute('data-part'), shadow: cs && cs.boxShadow,
             bb: cs && cs.borderBottomWidth,
             left: getComputedStyle(card).borderLeftColor };
  });
  ok('the part hue is on the card EDGE, never a line across the head',
    !noRule.err && noRule.attr === '1' &&
    (noRule.shadow === 'none' || !noRule.shadow) && parseFloat(noRule.bb || '0') === 0,
    JSON.stringify(noRule));

  // ---- THE SUBSECTIONS READ AS ACCORDIONS --------------------------------------
  // (2026-09-27, user: "these subsections need to be more obviously expandable
  // subsections, Novelty should be closed by default".) The head was a transparent,
  // borderless caption whose only affordance — the caret — sat at the far RIGHT,
  // hundreds of pixels from the word it belongs to.
  console.log('\n  ▸ the arrangement accordions');
  const acc = await page.evaluate(async () => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]');
    if (t) t.click();
    await new Promise((r) => setTimeout(r, 500));
    const heads = [...document.querySelectorAll('.ambient-proggrp > .ambient-grp-head')];
    const v = heads.find((h) => /VARIATION/i.test(h.textContent));
    if (!v) return { err: 'no Variation head', heads: heads.map((h) => h.textContent.trim()) };
    const g = v.closest('.ambient-grp');
    const cs = getComputedStyle(v);
    const hr = v.getBoundingClientRect();
    const car = v.querySelector('.ambient-grp-caret');
    const cr = car ? car.getBoundingClientRect() : null;
    const out = {
      closed: !g.classList.contains('open'), aria: v.getAttribute('aria-expanded'),
      bg: cs.backgroundColor, border: cs.borderTopWidth, h: Math.round(hr.height),
      // the caret must LEAD the title, i.e. sit in the left quarter of the bar
      caretLeads: !!(cr && hr.width > 0 && (cr.left - hr.left) < hr.width * 0.25),
    };
    v.click();
    await new Promise((r) => setTimeout(r, 300));
    out.openedAria = v.getAttribute('aria-expanded');
    out.opened = g.classList.contains('open');
    return out;
  });
  ok('✺ Variation opens CLOSED', !acc.err && acc.closed === true && acc.aria === 'false',
    JSON.stringify(acc));
  ok('…the head is a pressable SURFACE, not a caption',
    !acc.err && acc.bg !== 'rgba(0, 0, 0, 0)' && parseFloat(acc.border) > 0 && acc.h >= 30,
    JSON.stringify([acc.bg, acc.border, acc.h]));
  ok('…the caret LEADS the title instead of sitting at the far right',
    acc.caretLeads === true, JSON.stringify(acc.caretLeads));
  ok('…and pressing it opens the group AND says so',
    acc.opened === true && acc.openedAria === 'true', JSON.stringify([acc.opened, acc.openedAria]));

  // ---- ＋ ADD PART SPEAKS THE SAME SPACE ----------------------------------------
  // (2026-09-27, reported as "I chose A# major but it created the part in C major".)
  // Same two-spaces bug as the part-key menu, one surface further back — and it is a
  // DOUBLE conversion, because the dialog both OFFERS a key (the inherited one, a stored
  // part key) and WRITES one. Unfixed, the note read "the area stays in A# bebop" while
  // every chip beside it said C, so the key the user copied off the note was already two
  // semitones out before they touched it.
  console.log('\n  ＋ adding a part');
  const addp = await page.evaluate(async () => {
    const E = _masterEng, c = E.getCfg();
    // Re-lay the fixture: the sections above edit both chords and parts, and this one
    // needs an inherited part KEY to read the offered default off.
    const CH = (root, sev) => ({ root, intervals: sev ? [0, 4, 7, 10] : [0, 4, 7], bars: 1 });
    c.prog.on = true;
    c.prog.chords = [CH(2, 0), CH(6, 0), CH(7, 0), CH(4, 1), CH(9, 1), CH(11, 1)];
    const vs = _ambProgViewShift(E, c, c.prog.chords) | 0;
    c.prog.parts = [{ name: 'Intro', len: 3 },
                    { name: 'Changes', len: 3, key: { root: ((((5 - vs) % 12) + 12) % 12), scale: 'major' } }];
    const storedInh = E.getCfg().prog.parts[1].key.root;   // F as the chips draw it, stored
    _ambAddPartModal(E, 40, 120);
    await new Promise((r) => setTimeout(r, 60));
    const ov = document.querySelector('.ambient-addpart-modal');
    if (!ov) return { err: 'no add-part modal' };
    const rootSel = ov.querySelector('.ap-root'), scaleSel = ov.querySelector('.ap-scale');
    const offered = rootSel.value | 0;                   // the DEFAULT it inherits
    const WANT = 10;                                     // A♯, as the dialog offers it
    rootSel.value = String(WANT); scaleSel.value = 'major';
    rootSel.dispatchEvent(new Event('change'));
    const note = (ov.querySelector('.ap-note') || {}).textContent || '';
    // Capture the progression menu rather than driving its nested ▸ submenus: the pick
    // this checks happens when one of its leaves runs, and a leaf is a plain fn.
    const prevCtx = window.showCtxMenu;
    let items = null;
    window.showCtxMenu = (x, y, its) => { items = its; };
    try {
      ov.querySelector('.ap-next').click();
      await new Promise((r) => setTimeout(r, 80));
      let leaf = null;
      for (let hop = 0; hop < 3 && !leaf; hop++) {
        const list = (items || []).filter((it) => it && typeof it === 'object' && it.fn && !it.disabled);
        leaf = list.find((it) => !/▸/.test(it.label) && !/✎|⌨|‹ Back/.test(it.label)) || null;
        if (leaf) break;
        const sub = list.find((it) => /▸/.test(it.label));
        if (!sub) break;
        items = null; sub.fn();
        await new Promise((r) => setTimeout(r, 60));
      }
      if (!leaf) return { err: 'no progression leaf', labels: (items || []).map((i) => i && i.label) };
      leaf.fn();
    } finally { window.showCtxMenu = prevCtx; }
    await new Promise((r) => setTimeout(r, 200));
    const c2 = E.getCfg();
    const vs2 = _ambProgViewShift(E, c2, c2.prog.chords) | 0;
    const parts = c2.prog.parts || [];
    const np = parts[parts.length - 1] || {};
    // the first chord of the part just added, as it DRAWS
    let from = 0; for (let i = 0; i < parts.length - 1; i++) from += Math.max(1, parts[i].len | 0);
    const c0 = c2.prog.chords[from];
    return { vs, vs2, storedInh, offered, want: WANT, note,
             stored: np.key ? (np.key.root | 0) : null,
             shown: np.key ? _ambPartKeyShifted(np.key, vs2).root : null,
             chordShown: c0 ? ((((c0.root | 0) + vs2) % 12) + 12) % 12 : null,
             label: np.key ? _ambKeyLabel(_ambPartKeyShifted(np.key, vs2).root, np.key.scale) : null };
  });
  ok('the view shift survives the append, or the rest of this reads the wrong space',
    !addp.err && addp.vs !== 0 && addp.vs === addp.vs2, JSON.stringify(addp));
  ok('the key it OFFERS is the inherited key as the chips draw it',
    addp.offered === ((((addp.storedInh + addp.vs) % 12) + 12) % 12) && addp.offered === 5,
    JSON.stringify([addp.offered, addp.storedInh, addp.vs]));
  ok('…and the note names BOTH keys in that space — what it plays, what it leaves',
    /play in A♯ major/.test(addp.note) && /area stays in F /.test(addp.note),
    JSON.stringify(addp.note));
  ok('the key chosen stores in the progression’s own space',
    addp.stored === ((((addp.want - addp.vs) % 12) + 12) % 12), JSON.stringify(addp));
  ok('…and the new part READS BACK as the key that was chosen',
    addp.shown === addp.want && /A♯/.test(addp.label || ''), JSON.stringify([addp.shown, addp.label]));
  ok('…with its first chord drawn on that same root',
    addp.chordShown === addp.want, JSON.stringify([addp.chordShown, addp.want]));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
