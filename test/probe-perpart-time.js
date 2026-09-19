// PROBE — Time on a PER-PART record: the part's span IS the cycle.
//
// Asked: "How is Time supposed to work with a progression Part? what do Bars
// and Speed do". Bars already stated its binding (a `▫ N × part` badge, because
// a bound length is reconciled on every normalize and a stepper would lose to
// it). SPEED did not, and it was the same dead control: `cycleWindowAt` returns
// the pass span untouched for a per-part layer — it computes the rate-scaled
// length and then does not use it.
//
// The MEASUREMENT is the load-bearing part. The badge is only honest while
// Speed genuinely does nothing here; if that ever changes, this check fails and
// says to take the badge away.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);

  const run = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    // A PROGRESSION WITH TWO PARTS, and a layer that plays a steady pulse.
    const c0 = E.getCfg();
    c0.prog = { on: true, name: 'P',
      chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }],
      parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }] };
    E._progAnchor = 0; E._barGridAnchor = 0; E._playStartAt = 0;
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.rhythm = { kind: 'pulse', n: 4, steps: 16 };
    L().part.pitch = { kind: 'fixed', degree: 1 };
    L().part.bars = 2;
    E.getCfg();
    // How many notes actually sound over a fixed horizon.
    const onsets = () => {
      let n = 0; const oP = window.playNote;
      window.playNote = function () { n++; };
      E._v2Phase = {}; E._barGridAnchor = 0;
      try { window._v2Tick(E, 0, 16, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = oP; return n;
    };
    const o = {};
    // ── THE CONTROL: an ordinary layer, where Speed plainly works ──
    delete L().partFor; delete L().parts; delete L().partAll; delete L().speed;
    E.getCfg();
    o.plain1 = onsets();
    L().speed = 2; E.getCfg();
    o.plain2 = onsets();
    delete L().speed; E.getCfg();
    // ── PER-PART: the pass IS the cycle ──
    L().partFor = 0; E.getCfg();
    o.perPart = Number.isFinite(L().partFor) && !!(L().parts || L().partAll);
    o.pp1 = onsets();
    L().speed = 2; E.getCfg();
    o.pp2 = onsets();
    o.stored = L().speed;                       // kept, for the trip back
    // ── THE CARD SAYS SO ──
    // A COLLAPSED CARD GETS NO SECTION SHEET — `render` opens one only for an
    // expanded card, so removing the class AFTER a render leaves a card with no
    // editor in it and every row unreachable. Expand, then render again.
    const repaint = async () => {
      const h = document.getElementById('bloom-v2-layers');
      const un = () => { const c = document.querySelector('.v2-layer'); if (c) c.classList.remove('collapsed'); };
      if (h) h._sig = ''; window._v2.render(E); await wait(300); un();
      if (h) h._sig = ''; window._v2.render(E); await wait(340); un(); await wait(140);
    };
    await repaint();
    // Time lives in the CONTENT group; the card's door is the group head, and
    // `.v2-gototab` moves between sections once a sheet is open.
    // THE `.v2-gototab` STRIP ONLY EXISTS INSIDE AN OPEN SHEET. The Content
    // group (which Time belongs to) is default-OPEN inline on the card, so its
    // head is not a door — open a sheet that is, then navigate.
    const openTime = async () => {
      let d = document.querySelector('.v2-layer .v2-gototab[data-goto="Time"]');
      if (!d) {
        const gh = document.querySelector('.v2-layer [data-v2grp="Shape"] .ambient-grp-head') ||
                   document.querySelector('.v2-layer .ambient-grp[data-v2grp] .ambient-grp-head');
        if (gh) { gh.click(); await wait(460); }
        d = document.querySelector('.v2-layer .v2-gototab[data-goto="Time"]');
      }
      if (d) { d.click(); await wait(460); }
      return !!d;
    };
    const toTab = async (nm) => {
      const b = document.querySelector('.v2-layer .v2-pop-tabs [data-tab="' + nm + '"]');
      if (b) { b.click(); await wait(300); }
      return !!b;
    };
    o.pre = { cards: document.querySelectorAll('.v2-layer').length,
              grps: [...document.querySelectorAll('.v2-layer [data-v2grp]')].map((x) => x.getAttribute('data-v2grp')),
              heads: document.querySelectorAll('.v2-layer .ambient-grp-head').length,
              collapsed: !!document.querySelector('.v2-layer.collapsed') };
    o.timeDoor = await openTime();
    o.post = { pane: document.querySelectorAll('.v2-pop-pane').length,
               secpop: document.querySelectorAll('.v2-secpop').length,
               gototabs: [...document.querySelectorAll('.v2-layer .v2-gototab')].map((x) => x.getAttribute('data-goto')),
               cls: (document.querySelector('.v2-layer') || {}).className };
    o.timeTabs = [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')]
      .map((x) => x.getAttribute('data-tab'));
    o.speedTab = await toTab('Speed');
    const rowOf = (lab) => [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')]
      .find((x) => (((x.querySelector('label') || {}).textContent) || '').trim() === lab) || null;
    o.paneRows = [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')].map((x) => ({
      lab: (((x.querySelector('label') || {}).textContent) || '?').trim(),
      tab: x.getAttribute('data-v2tab') || '-',
      h: Math.round(x.getBoundingClientRect().height),
      badge: !!x.querySelector('.ambient-loop-badge') }));
    {
      const r = rowOf('Speed');
      const rect = r ? r.getBoundingClientRect() : null;
      o.speedRow = r ? {
        w: Math.round(rect.width), h: Math.round(rect.height),
        badge: (r.querySelector('.ambient-loop-badge') || {}).textContent || null,
        hint: ((r.querySelector('.ambient-hint') || {}).textContent || '').trim(),
        hasSelect: !!r.querySelector('select[data-f="speed"]'),
      } : null;
    }
    // Bars states its own binding the same way — the sibling claim.
    await toTab('Bars');
    { const r = rowOf('Bars');
      o.barsBadge = r ? ((r.querySelector('.ambient-loop-badge') || {}).textContent || null) : null;
      o.barsSelect = r ? !!r.querySelector('input[data-f="part.bars"]') : null; }
    // ── BACK TO ▭ EVERYWHERE: the dropdown returns, with the speed you had ──
    delete L().partFor; delete L().parts; delete L().partAll; E.getCfg();
    await repaint();
    await openTime(); await toTab('Speed');
    { const r = rowOf('Speed');
      o.backSelect = r ? !!r.querySelector('select[data-f="speed"]') : null;
      o.backBadge = r ? !!r.querySelector('.ambient-loop-badge') : null;
      o.backValue = r ? ((r.querySelector('select[data-f="speed"]') || {}).value || null) : null; }
    delete L().speed; E.getCfg();

    // ── TIME ASKS ONLY "HOW LONG" ────────────────────────────────────
    // The ladder is Everywhere / Locked / Free. Per part is NOT on it: it
    // answers what CONTENT the layer has, which is Generate's question, and
    // only has a length consequence — which Time states instead.
    const cycSel = () => document.querySelector('.v2-pop-pane .v2-cycmode');
    const rowH = (lab) => { const r = rowOf(lab); return r ? Math.round(r.getBoundingClientRect().height) : -1; };
    const badgeIn = (lab) => {
      const r = rowOf(lab); const bg = r && r.querySelector('.ambient-loop-badge');
      return bg ? bg.textContent.trim() : null;
    };
    const stepIn = (lab) => {
      const r = rowOf(lab); return r ? r.querySelector('input.ambient-step-inp') : null;
    };
    const pick = async (v) => {
      const el = cycSel(); if (!el) return false;
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(520);
      await openTime(); await toTab('Cycle');
      return true;
    };
    // a clean Everywhere layer to start from
    delete L().partFor; delete L().parts; delete L().partAll;
    delete L().part.clock; delete L().lenSync;
    E.getCfg();
    await repaint(); await openTime(); await toTab('Cycle');
    o.cycOpts = cycSel() ? [...cycSel().options].map((x) => x.value) : null;
    o.cycNow = cycSel() ? cycSel().value : null;
    await toTab('Bars');
    o.everyRows = { bars: rowH('Bars'), more: rowH('More bars'), badge: badgeIn('Bars'),
                    step: !!stepIn('Bars') };
    await toTab('Cycle');
    // FREE
    await pick('free');
    o.freeMode = { val: cycSel().value, stored: L().part.clock || null };
    await toTab('Bars'); o.freeRows = { bars: rowH('Bars'), more: rowH('More bars') };
    await toTab('Cycle');
    // LOCKED — the rung that used to exist only behind a ⋯ menu modal
    await pick('locked');
    o.lockMode = { val: cycSel().value, lenSync: JSON.parse(JSON.stringify(L().lenSync || null)),
                   clock: L().part.clock || null, bars: L().part.bars };
    await toTab('Bars');
    o.lockRows = { bars: rowH('Bars'), more: rowH('More bars'),
                   step: !!stepIn('Bars'), badge: badgeIn('Bars'),
                   hint: (() => { const r = rowOf('Bars'); const hn = r && r.querySelector('.ambient-hint');
                                  return hn ? hn.textContent.trim() : null; })() };
    // …AND IT IS A CONTROL: driving the passes count moves the loop length
    { const el = stepIn('Bars');
      if (el) { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    await wait(420);
    o.lockDrove = { passes: (L().lenSync || {}).passes, bars: L().part.bars };
    await toTab('Cycle'); await pick('every');
    delete L().lenSync; E.getCfg(); await repaint();

    // ── GENERATE OWNS THE CONTENT QUESTION ───────────────────────────
    const openGen = async () => {
      let d = document.querySelector('.v2-layer .v2-gototab[data-goto="Generate"]');
      if (!d) { await openTime(); d = document.querySelector('.v2-layer .v2-gototab[data-goto="Generate"]'); }
      if (d) { d.click(); await wait(460); }
      return !!d;
    };
    o.genDoor = await openGen();
    o.genTabs = [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')]
      .map((x) => x.getAttribute('data-tab'));
    o.ppTab = await toTab('Per part');
    const ppBtn = () => document.querySelector('.v2-pop-pane .v2-ppmode');
    o.ppRow = (() => {
      const r = rowOf('Per part'); const rr = r ? r.getBoundingClientRect() : null;
      return rr ? { w: Math.round(rr.width), h: Math.round(rr.height),
                    face: ppBtn() ? ppBtn().textContent.trim() : null } : null;
    })();
    // FORK IT — a real press
    if (ppBtn()) { ppBtn().click(); await wait(560); }
    await openGen(); await toTab('Per part');
    o.forked = { partFor: L().partFor, iced: !!L().partAll,
                 face: ppBtn() ? ppBtn().textContent.trim() : null };
    // …and TIME now STATES it rather than owning it
    await openTime(); await toTab('Cycle');
    o.cycWhenPart = { sel: !!cycSel(), badge: badgeIn('Cycle'),
                      hint: (() => { const r = rowOf('Cycle'); const hn = r && r.querySelector('.ambient-hint');
                                     return hn ? hn.textContent.trim() : null; })() };
    await toTab('Bars');
    o.barsWhenPart = { badge: badgeIn('Bars'), step: !!stepIn('Bars') };
    // THE HEAD PILL STAYS IN STEP — one handler, two doors
    o.pillWhenPart = (() => { const q = document.querySelector('.v2-layer .v2-pop-pp');
                              return q ? q.textContent.trim() : null; })();
    // LEAVING ASKS; refusing changes nothing
    const svC = window.confirm;
    await openGen(); await toTab('Per part');
    window.confirm = () => false;
    if (ppBtn()) { ppBtn().click(); await wait(520); }
    await openGen(); await toTab('Per part');
    o.refused = { partFor: L().partFor, face: ppBtn() ? ppBtn().textContent.trim() : null };
    window.confirm = () => true;
    if (ppBtn()) { ppBtn().click(); await wait(560); }
    await openGen(); await toTab('Per part');
    o.accepted = { partFor: L().partFor === undefined ? null : L().partFor,
                   iced: !!L().partAll, face: ppBtn() ? ppBtn().textContent.trim() : null };
    window.confirm = svC;
    await openTime(); await toTab('Cycle');
    o.cycBack = { sel: cycSel() ? cycSel().value : null };

    // ── MORE BARS: THE ONE THING STILL YOURS ON A PER-PART RECORD ────
    // The part owns WHEN and HOW LONG; this owns what happens to the notes
    // when that part is re-cut. The cascade dialog pre-fills from it.
    const modeSel = () => { const r = rowOf('More bars');
      return r ? r.querySelector('select[data-f="part.barsMode"]') : null; };
    const modeOpts = () => { const el = modeSel(); return el ? [...el.options].map((x) => x.value) : null; };
    // a LIVE part, everywhere: two modes (Preserve does nothing on rules)
    delete L().partFor; delete L().parts; delete L().partAll;
    delete L().part.barsMode; L().part.kind = 'live'; E.getCfg();
    await repaint(); await openTime(); await toTab('Bars');
    o.liveModes = modeOpts();
    // a RECORDED part: Preserve is real there and is offered
    L().part.kind = 'recorded';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.25 }, { t: 0.5, midi: 64, dur: 0.25 }];
    E.getCfg(); await repaint(); await openTime(); await toTab('Bars');
    o.recModes = modeOpts();
    // …and a STORED preserve must SHOW as preserve, on any kind
    L().part.barsMode = 'preserve'; E.getCfg();
    L().part.kind = 'live'; delete L().part.notes; E.getCfg();
    await repaint(); await openTime(); await toTab('Bars');
    o.storedPreserve = { opts: modeOpts(), shown: modeSel() ? modeSel().value : null,
                         stored: L().part.barsMode };
    delete L().part.barsMode; E.getCfg();
    // ── AND IT IS THERE ON A PER-PART RECORD ────────────────────────
    await openGen(); await toTab('Per part');
    if (ppBtn()) { ppBtn().click(); await wait(560); }
    await openTime(); await toTab('Bars');
    o.perPartMore = (() => {
      const r = rowOf('More bars');
      const rr = r ? r.getBoundingClientRect() : null;
      const hn = r && r.querySelector('.ambient-hint');
      return rr ? { w: Math.round(rr.width), h: Math.round(rr.height),
                    hint: hn ? hn.textContent.trim() : null,
                    opts: modeOpts() } : null;
    })();
    // it COMMITS from there
    { const el = modeSel();
      if (el) { el.value = 'fill'; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    await wait(380);
    o.perPartWrote = L().part.barsMode || null;
    { const svc = window.confirm; window.confirm = () => true;
      await openGen(); await toTab('Per part');
      if (ppBtn()) { ppBtn().click(); await wait(560); }
      window.confirm = svc; }
    return o;
  });

  ok('the fixture is a real per-part layer over a progression',
    run.perPart === true, JSON.stringify(run.perPart));
  // WHY THE BADGE EXISTS. If this ever flips, the badge is the thing to remove.
  ok('an ORDINARY layer doubles with Speed 2× — the control case',
    run.plain1 === 16 && run.plain2 === 32, JSON.stringify({ x1: run.plain1, x2: run.plain2 }));
  ok('a PER-PART layer does NOT — the pass span is the cycle, rate and all',
    run.pp1 === run.pp2 && run.pp1 === 16, JSON.stringify({ x1: run.pp1, x2: run.pp2 }));
  ok('…and the card no longer offers a Speed that does nothing',
    !!run.speedRow && run.speedRow.hasSelect === false && !!run.speedRow.badge,
    JSON.stringify(run.speedRow));
  ok('…it states the binding, and says the way out',
    !!run.speedRow && /1\u00d7/.test(run.speedRow.badge || '') &&
    /pass sets it/.test(run.speedRow.badge || '') && /Generate/.test(run.speedRow.hint || ''),
    JSON.stringify(run.speedRow));
  ok('…on the Speed tab, REACHABLE — measured, not just present',
    run.timeDoor && run.speedTab && !!run.speedRow && run.speedRow.w > 0 && run.speedRow.h > 0,
    JSON.stringify({ tabs: run.timeTabs, r: run.speedRow }));
  ok('Bars states its binding the same way — one rule, not two',
    !!run.barsBadge && /part/.test(run.barsBadge) && run.barsSelect === false,
    JSON.stringify({ badge: run.barsBadge, stepper: run.barsSelect }));
  // Storing it rather than clearing it is what makes the badge safe: nothing
  // is destroyed by filing a record under a part.
  ok('the stored Speed survives being filed under a part', run.stored === 2,
    JSON.stringify(run.stored));
  ok('…and ▭ Everywhere brings the dropdown back, still on 2×',
    run.backSelect === true && run.backBadge === false && run.backValue === '2',
    JSON.stringify({ sel: run.backSelect, badge: run.backBadge, v: run.backValue }));

  // ── TIME: ONLY "HOW LONG", AND LIVE IN EVERY STATE IT OWNS ───────────
  ok('Cycle offers Everywhere, Locked and Free — Per part is not a cycle setting',
    JSON.stringify(run.cycOpts) === JSON.stringify(['every', 'locked', 'free']),
    JSON.stringify(run.cycOpts));
  ok('…Everywhere gives a live Bars stepper and More bars',
    run.cycNow === 'every' && run.everyRows.step === true &&
    run.everyRows.more > 0 && run.everyRows.badge === null, JSON.stringify(run.everyRows));
  ok('…Free takes the Bars rows away and stores its own clock',
    run.freeMode.val === 'free' && run.freeMode.stored === 'free' &&
    run.freeRows.bars <= 0 && run.freeRows.more <= 0,
    JSON.stringify({ m: run.freeMode, rows: run.freeRows }));
  // The rung that previously existed ONLY behind a ⋯ menu modal.
  ok('…Locked binds the loop to passes of a part, and clears any free clock',
    run.lockMode.val === 'locked' && run.lockMode.lenSync &&
    (run.lockMode.lenSync.passes | 0) === 1 && run.lockMode.clock === null,
    JSON.stringify(run.lockMode));
  ok('…and Bars is a CONTROL there, not a sign pointing at a menu',
    run.lockRows.step === true && run.lockRows.badge === null &&
    /passes of/.test(run.lockRows.hint || ''), JSON.stringify(run.lockRows));
  ok('…driving it moves the loop length — 2 passes of a 2-bar part is 4 bars',
    (run.lockDrove.passes | 0) === 2 && run.lockDrove.bars === 4,
    JSON.stringify(run.lockDrove));

  // ── GENERATE: WHAT CONTENT DOES THIS LAYER HAVE ──────────────────────
  ok('Per part is a Generate control now, on its own tab',
    run.genDoor && run.ppTab && run.genTabs.indexOf('Per part') >= 0,
    JSON.stringify(run.genTabs));
  ok('…REACHABLE there — measured, not just present',
    !!run.ppRow && run.ppRow.w > 0 && run.ppRow.h > 0 && /Everywhere/.test(run.ppRow.face || ''),
    JSON.stringify(run.ppRow));
  ok('…and pressing it forks the content: the Everywhere record is ICED',
    Number.isFinite(run.forked.partFor) && run.forked.iced === true &&
    /Per part/.test(run.forked.face || ''), JSON.stringify(run.forked));

  // ── TIME STATES THE CONSEQUENCE, AND OWNS NOTHING THERE ──────────────
  ok('with a per-part content, Cycle is a BADGE that points at Generate',
    run.cycWhenPart.sel === false && run.cycWhenPart.badge !== null &&
    /Generate/.test(run.cycWhenPart.hint || ''), JSON.stringify(run.cycWhenPart));
  ok('…and Bars says the length is the part\'s',
    run.barsWhenPart.step === false && /\u00d7 part/.test(run.barsWhenPart.badge || ''),
    JSON.stringify(run.barsWhenPart));
  ok('…while the head pill follows the Generate control — one handler, two doors',
    /Per part/.test(run.pillWhenPart || ''), JSON.stringify(run.pillWhenPart));

  // A CANCELLED CONFIRM MUST NEVER LOOK LIKE IT DID SOMETHING.
  ok('going back ASKS, and refusing leaves the fork in place',
    Number.isFinite(run.refused.partFor) && /Per part/.test(run.refused.face || ''),
    JSON.stringify(run.refused));
  ok('…accepting brings the iced Everywhere content back, and Cycle is live again',
    run.accepted.partFor === null && run.accepted.iced === false &&
    /Everywhere/.test(run.accepted.face || '') && run.cycBack.sel === 'every',
    JSON.stringify({ a: run.accepted, c: run.cycBack }));

  // ── MORE BARS ────────────────────────────────────────────────────────
  ok('More bars offers Preserve on a RECORDED part, and not on a live one',
    JSON.stringify(run.liveModes) === JSON.stringify(['stretch', 'fill']) &&
    JSON.stringify(run.recModes) === JSON.stringify(['stretch', 'fill', 'preserve']),
    JSON.stringify({ live: run.liveModes, rec: run.recModes }));
  // A CONTROL'S FIRST DUTY IS NOT TO LIE ABOUT THE MODEL: it used to show
  // "Stretch" over a stored `preserve`, and overwrite it the moment it was touched.
  ok('…and a STORED Preserve shows as Preserve, whatever the part kind',
    run.storedPreserve.stored === 'preserve' && run.storedPreserve.shown === 'preserve' &&
    (run.storedPreserve.opts || []).indexOf('preserve') >= 0,
    JSON.stringify(run.storedPreserve));
  ok('…and on a per-part record it is REACHABLE — the one control still yours there',
    !!run.perPartMore && run.perPartMore.w > 0 && run.perPartMore.h > 0 &&
    /re-cut/.test(run.perPartMore.hint || ''), JSON.stringify(run.perPartMore));
  ok('…and it commits from there', run.perPartWrote === 'fill',
    JSON.stringify(run.perPartWrote));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n  Speed row (per-part): ' + (run.speedRow && run.speedRow.badge) +
              '  |  ' + (run.speedRow && run.speedRow.hint));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
