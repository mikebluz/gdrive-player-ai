#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// UI LIFECYCLE GATE — the gate the UI never had.
//
// WHY THIS EXISTS. Audio has five gates (golden, arch, partseq, harness,
// mod-parity) and a regression there is caught by a script in seconds. The UI
// had none, so every UI regression was caught by the user instead — four rounds
// on one expand button, three separate instances in one day of the SAME
// double-wiring shape.
//
// THE SPECIFIC HOLE: ad-hoc probes build state in an order the app never uses —
// init, add a card, interact. The device is ALWAYS in a different order:
//
//     init  →  card exists  →  PANEL REBUILD  →  interact
//
// That rebuild is what re-runs the panel's build-time wiring sweeps
// (`host.querySelectorAll('.ambient-collapse')`, `('.ambient-grp-head')`), which
// attach a SECOND handler to any card that renders inside the panel host and
// reuses those classes. Both handlers toggle, the taps cancel, the control is
// dead — and no test that skipped the rebuild could ever see it.
//
// So this gate reproduces the real lifecycle and then DRIVES EVERY CONTROL under
// touch, asserting the user-visible outcome (a body's height, a config value),
// never that a handler ran.
//
//   npm run test:ui           (needs `npm start` on :3001)
//   npm run test:ui -- --only=<regex>
//
// --only RUNS TO A CHECK, IT DOES NOT JUMP TO IT. The probes below are one
// sequence sharing page state (a card, an open sheet, a selected bar), so a
// check cannot be started cold. What --only does: every check whose NAME does
// not match runs QUIETLY (a pass is counted, not printed; a failure is still
// printed, because it may be what breaks the check you asked for), and the
// gate STOPS after the last matching check — a check near the top finishes in
// seconds. Names are matched against the literal first argument of ok(), read
// from this file, so a pattern that matches nothing is an error, not a green.
// ─────────────────────────────────────────────────────────────────────────────
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// `npm start` on 3001 by default. BLOOPS_URL overrides it so a worktree can be
// gated against its OWN server without stopping the one the main checkout uses.
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';

// UI_WAIT_SCALE scales every settle-wait (node-side and in-page) so a dev
// iteration can run at ~0.6 while the FINAL verification runs at 1. The
// checks' semantics do not change — only how long the gate idles between
// actions. A failure seen only at a reduced scale is re-run at 1 before it
// is believed.
const WS = Math.max(0.3, Number(process.env.UI_WAIT_SCALE || 1) || 1);
// only SHORT waits scale — those are DOM settles; anything longer is usually
// waiting on the AUDIO clock (a choke boundary, a preview ring-out), which
// runs on wall time whatever the gate does (4 checks failed at 0.6 before
// this split, all of them clock-dependent)
const zz = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * WS) : ms));
let pass = 0, fail = 0;
// ---- --only=<regex> ----------------------------------------------------------
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? new RegExp(ONLY_ARG.slice(7), 'i') : null;
let onlyLeft = 0, quiet = 0, halting = false;
let browser = null;
if (ONLY) {
  // the check names are literals, so the LAST match is known before the run
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const names = [...src.matchAll(/^\s*ok\(\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gm)]
    .map((m) => m[2] != null ? m[2] : m[3]);
  onlyLeft = names.filter((n) => ONLY.test(n)).length;
  if (!onlyLeft) {
    console.error('UI LIFECYCLE: --only matches no check name (' + names.length + ' names scanned)');
    process.exit(2);
  }
  console.log('UI LIFECYCLE: --only ' + ONLY + ' — ' + onlyLeft + ' matching check(s); earlier checks run quietly\n');
}
const finish = () => {
  const tail = ONLY ? ' (' + quiet + ' earlier checks ran quietly' + (fail ? '' : ' and passed') + ')' : '';
  console.log('\nUI LIFECYCLE: ' + (fail ? ('✗ ' + fail + ' failed, ' + pass + ' passed') : ('✓ all ' + pass + ' checks pass')) + tail + '\n');
  const code = fail ? 1 : 0;
  const bye = () => process.exit(code);
  if (browser) browser.close().then(bye, bye); else bye();
};
const ok = (name, cond, detail) => {
  const mine = !ONLY || ONLY.test(name);
  if (cond) { pass++; if (mine) console.log('  ✓ ' + name); else quiet++; }
  else { fail++; console.log('  ✗ ' + (mine ? '' : '(earlier) ') + name + (detail ? '  — ' + detail : '')); }
  // the last wanted check has spoken: stop here, whatever the script has left
  if (ONLY && mine && --onlyLeft === 0) { halting = true; finish(); }
};

(async () => {
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000,
  });
  const page = await browser.newPage();
  // `zz` exists in BOTH scopes: the sleep substitution cannot tell node-side
  // code from page-evaluate templates, so the page carries the same helper
  await page.evaluateOnNewDocument((ws) => {
    window.__WS = ws;
    window.zz = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * ws) : ms));
  }, WS);
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  // BACK TO CONTENT. The section row lost its Content button (2026-09-13) —
  // the body IS Content, so a button for it could only say "you are here".
  // Getting back to it means dismissing the section popover, if one is open.
  await page.evaluate(() => {
    window.__toContent = () => {
      document.querySelectorAll('.v2-secpop-close').forEach((b) => b.click());
    };
    // …and OPEN a section. Content's families (Make · Time · Bank) became
    // section buttons too, so "go to the rows" is now "open the section that
    // holds them"; the body itself holds only the drawing.
    // THE LAYER A CHECK IS LOOKING AT (2026-09-16). While ✨ Quick or ⚙ Deep is
    // open its edits are STAGED — the layer proper does not change until ✓ Done —
    // so "what did that press do" is asked of the staged copy, and after Done
    // (or with no panel open) of the layer itself. `__Lreal` is the layer proper,
    // for the checks that pin the staging itself.
    window.__Lreal = (E) => (E.getCfg().layers || [])[0];
    window.__Lv2 = (E) => {
      const l0 = (E.getCfg().layers || [])[0];
      const s0 = l0 && window._v2 && window._v2.stagedOf && window._v2.stagedOf(l0.id);
      return s0 || l0;
    };
    window.__sec = (nm) => {
      window.__toContent();
      const b = document.querySelector('.v2-gototab[data-goto="' + nm + '"]');
      if (b) b.click();
      return !!b;
    };
    // \ud83c\udfb2 NEW TAKE ASKS BEFORE IT ROLLS (2026-09-18). \ud83d\udcbe Save this take is no
    // longer a button of its own: the dice opens a keep-gate \u2014 Save \u00b7 Discard \u00b7
    // Close \u2014 and so does loading from the Bank. Every driver of either press
    // goes through here so the answer is stated once, and a check that wants
    // the plain roll it always had asks for 'roll'.
    //
    // The popover is built SYNCHRONOUSLY inside the click handler, so it is
    // already in the DOM when click() returns; its own actions are deferred a
    // tick past its dismiss (the documented dispatch order), hence the yield.
    // NO GATE IS NOT A FAILURE \u2014 a press with nothing to lose (an empty part,
    // a live one whose cycle comes out empty) rolls outright, by design.
    window.__gate = async (btn, which) => {
      if (!btn) return 'nobtn';
      btn.click();
      const pop = document.querySelector('.ambient-addpop');
      if (!pop) return 'nogate';
      const re = which === 'save' ? /Save it to the bank|Save this take to the bank/
        : which === 'close' ? /^Close$/
        : /Roll over it|what is here is gone/;
      const b = [...pop.querySelectorAll('.addpop-btn, .addpop-close')]
        .find((x) => re.test(x.textContent.trim()));
      if (!b) { const ov = pop.closest('.sm-overlay'); if (ov) ov.remove(); return 'noanswer'; }
      b.click();
      await new Promise((r) => setTimeout(r, 20));
      return 'ok';
    };
    // what the gate SAYS, without answering it \u2014 for the checks that read it
    window.__gatePeek = (btn) => {
      if (!btn) return null;
      btn.click();
      const pop = document.querySelector('.ambient-addpop');
      if (!pop) return null;
      const o = { title: (pop.querySelector('.sm-title') || {}).textContent || '',
        head: (pop.querySelector('.addpop-head') || {}).textContent || '',
        btns: [...pop.querySelectorAll('.addpop-btn')].map((x) => x.textContent.trim()) };
      const ov = pop.closest('.sm-overlay'); if (ov) ov.remove();
      return o;
    };
  });
  await zz(2500);

  // ---- the REAL lifecycle -------------------------------------------------
  // THE CARD IS CREATED THROUGH THE MENU, not `_v2.addDefault`. Calling the API
  // is how this gate went 43 checks green while the user could not find the
  // surface at all: everything after "a card exists" was verified, and nothing
  // verified that pressing + Add layer produces one. Drive the door.
  await page.evaluate(() => {
    document.body.classList.add('view-mix');
    _ambInitMaster();                 // 1. panel builds (wiring sweeps run)
  });
  await zz(500);
  const doorOpened = await page.evaluate(() => {
    const b = document.getElementById('mix-bloom-add-layer'); if (!b) return 'no + Add layer button';
    b.scrollIntoView({ block: 'center' }); b.click(); return null;
  });
  await zz(450);
  const doorPicked = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (!bs.length) return 'Add-layer popover did not open';
    const t = bs.find((x) => x.textContent.trim() === 'Layer');
    if (!t) return 'no "Layer" entry among: ' + bs.map((x) => x.textContent.trim()).join(' | ');
    t.click(); return null;
  });
  await zz(600);
  ok('+ Add layer → "Layer" creates a v2 card', !doorOpened && !doorPicked, doorOpened || doorPicked);
  await page.evaluate(() => { _ambRebuildMaster(); });   // 3. THE STEP ad-hoc probes skip
  await zz(500);

  // ---- helpers ------------------------------------------------------------
  // A tap is only meaningful if the element is actually reachable: non-zero box,
  // and whatever is at its centre is the element itself (not something covering
  // it). Both have been real failures here.
  const tap = async (sel) => {
    // A SECTION POPOVER IS MODAL — it covers the card, exactly as it does for a
    // finger. So a tap aimed OUTSIDE it dismisses it first, which is what a
    // person would have to do; a tap aimed INSIDE it leaves it alone. (Before
    // 2026-09-13 the five sections rebuilt the card body, so a probe could
    // navigate and go on poking the card; now it has to come back out.)
    await page.evaluate((s) => {
      const ov = document.querySelector('.v2-secpop-wrap'); if (!ov) return;
      const t = document.querySelector(s); if (t && ov.contains(t)) return;
      const c = ov.querySelector('.v2-secpop-close'); if (c) c.click();
    }, sel);
    await zz(120);
    const box = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { err: 'missing' };
      // Subsections start closed, so open the one this control lives in — the
      // same move the user makes before touching it.
      const isHead = el.classList && el.classList.contains('ambient-grp-head');
      const grp = (!isHead && el.closest) ? el.closest('.ambient-grp') : null;
      if (grp && !grp.classList.contains('open')) grp.classList.add('open');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { err: 'zero-size' };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit !== el && !el.contains(hit)) return { err: 'covered by ' + (hit ? (hit.className || hit.tagName) : 'nothing') };
      return { x: cx, y: cy };
    }, sel);
    if (box.err) return box.err;
    await page.touchscreen.tap(box.x, box.y);
    await zz(250);
    return null;
  };
  const state = () => page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const L = (_masterEng.getCfg().layers || [])[0];
    return {
      exists: !!c,
      collapsed: c ? c.classList.contains('collapsed') : null,
      bodyH: c ? Math.round(c.querySelector('.ambient-layer-body').getBoundingClientRect().height) : 0,
      grpsOpen: c ? c.querySelectorAll('.ambient-grp.open').length : 0,
      on: L ? L.on : null,
      register: L ? L.instrument.register : null,
      rhythm: L ? L.part.rhythm.kind : null,
      menuOpen: !!document.querySelector('.ctx-menu'),
    };
  });

  console.log('\nUI LIFECYCLE — v2 layer card (init → card → rebuild → touch)\n');
  ok('card survives a panel rebuild', (await state()).exists);

  // A NEW LAYER MUST ARRIVE ON THE PATTERN GRID. It defaulted to `pulse`, which
  // has no grid, so a freshly added layer showed no compose surface at all
  // unless you opened the Rhythm dropdown and picked the right entry — reported
  // twice as "no grid or pattern".
  const asAdded = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    // Peek, then PUT IT BACK. The expand/collapse checks below toggle three
    // times and assert the state after each, so leaving the card open here
    // flips their parity and every later tap lands on a collapsed card — 14
    // checks failed with "zero-size" for that reason alone.
    const wasCollapsed = c.classList.contains('collapsed');
    const wasOpen = [...c.querySelectorAll('.ambient-grp')].map((g) => g.classList.contains('open'));
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    // RESTATED 2026-09-15 — the grid is no longer a ROW inside Roll; ▦ Pattern
    // is its one home. The contract ("no hunting") is unchanged: the DOOR to it
    // must be on screen without opening anything. This stays a PURE PEEK — the
    // first cut pressed the switch here and broke six later checks, because the
    // press re-renders (detaching the node the peek then clicked again) and
    // left the card in the other form, which flipped the expand/collapse parity
    // this block is careful to preserve. What the grid looks like once you
    // arrive is asserted by the form checks, which can afford to await.
    const fb = c.querySelector('.v2-formbtn');
    const fr = fb ? fb.getBoundingClientRect() : null;
    const out = { rhythm: (_masterEng.getCfg().layers || [])[0].part.rhythm.kind,
             doorShown: !!fb && !!fb.offsetParent && !!fr && fr.width > 40 && fr.height > 20,
             names: fb ? fb.textContent.replace(/\s+/g, ' ').trim() : '' };
    if (wasCollapsed) c.classList.add('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((gr, i) => gr.classList.toggle('open', !!wasOpen[i]));
    return out;
  });
  ok('the pattern grid is ONE press from a new layer — the door is on screen, named',
    asAdded.doorShown && /Roll/.test(asAdded.names) && /Pattern/.test(asAdded.names),
    JSON.stringify(asAdded));

  // ---- EXPAND / COLLAPSE --------------------------------------------------
  // The regression that cost four rounds: two handlers, taps cancel, dead control.
  let e = await tap('.v2-layer .ambient-collapse');
  let s = await state();
  ok('expand is reachable', !e, e);
  ok('expand REVEALS the body', s.collapsed === false && s.bodyH > 100, JSON.stringify(s));

  await tap('.v2-layer .ambient-collapse');
  s = await state();
  ok('collapse hides the body', s.collapsed === true && s.bodyH === 0, JSON.stringify(s));

  await tap('.v2-layer .ambient-collapse');
  s = await state();
  ok('expand again (toggles, never cancels)', s.collapsed === false && s.bodyH > 100, JSON.stringify(s));

  // ---- GROUP GRID → SHEET -------------------------------------------------
  // The card body is a grid of buttons; a button opens its group's rows in a
  // bottom sheet, tabbed one parameter per tab. The old accordion heads are
  // hidden storage now (`.ambient-grp.open` survives as the test hook the
  // in-card checks below use).
  // FAMILY AUDIT, both directions (the §5i popover-group precedent): a group
  // with no button is unreachable, a button with no group opens nothing.
  s = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const btns = [...c.querySelectorAll('.v2-gototab')].map((b2) => b2.getAttribute('data-goto'));
    // RESTATED with the move: the navigator is the editor's own SECTION TABS
    // now (the button grid was a second navigator for one thing and came down
    // with the sheet). Same audit, both directions, on the surface that exists.
    const grps = [...c.querySelectorAll('.ambient-grp')].map((g) => g.getAttribute('data-v2grp'));
    return {
      btns: btns.length, grps: grps.length,
      // CONTENT IS THE BODY (2026-09-13), so it is the one group that must NOT
      // have a button — pressing one could only have said "you are here". The
      // pairing still binds in both directions for the five treatments.
      // A SECTION NAMES A GROUP, and three of them (Make · Time · Bank) name
      // the SAME one — they are the Content group seen three ways. Asked of the
      // app rather than re-derived here, so the check cannot drift from it.
      buttonless: grps.filter((g) => g !== 'Content' &&
        !btns.some((b2) => window._v2.secGrp(b2) === g)),
      contentHasButton: btns.indexOf('Content') >= 0,
      groupless: btns.filter((b2) => grps.indexOf(window._v2.secGrp(b2)) < 0),
    };
  });
  // The invariant is the PAIRING in both directions, not a count — pinning 12
  // made a deliberate regroup look like a break. (12 -> 7: Envelope, Voicing,
  // Motion, Mod and Space folded into the group each belongs to.)
  ok('every treatment has a section button and every button a group — Content is the body',
    s.btns === 8 && s.grps === 6 && !s.buttonless.length && !s.groupless.length &&
    !s.contentHasButton, JSON.stringify(s));
  // THE EDITOR IS THE CARD'S BODY — there is nothing to press. It opens on
  // Content, the section that holds the drawing, and every other section is one
  // tap away in the head. Nothing is `position: fixed` any more, so it cannot
  // be covered by the app header or the shell's status bar.
  s = await page.evaluate(() => {
    const w = document.querySelector('.v2-pop-wrap');
    const sheet = w && w.querySelector('.v2-pop');
    const r = sheet && sheet.getBoundingClientRect();
    const pane = w && w.querySelector('.v2-pop-pane');
    const over = pane ? Math.max(0, ...[...pane.querySelectorAll('*')].map((n) =>
      Math.round(n.getBoundingClientRect().right - pane.getBoundingClientRect().right))) : -1;
    return {
      open: !!w,
      // THE BODY IS CONTENT and the row is the five treatments, so with no
      // popover open NOTHING is lit — a row that always lit something would be
      // claiming a treatment is open when none is. What says the body is
      // Content is its summary, which is keyed by group.
      title: w ? ((w.querySelector('.v2-grpsum') || {}).getAttribute
                  && w.querySelector('.v2-grpsum').getAttribute('data-grp')) || null : null,
      litNone: w ? w.querySelectorAll('.v2-gototab.on').length === 0 : false,
      noContentBtn: w ? !w.querySelector('.v2-gototab[data-goto="Content"]') : false,
      tabs: w ? w.querySelectorAll('.v2-pop-tab').length : 0,
      onTabs: w ? w.querySelectorAll('.v2-pop-tab.on').length : 0,
      rows: w ? w.querySelectorAll('.v2-pop-pane .ambient-ctrl').length : -1,
      hasViz: !!(w && w.querySelector('.v2-partviz')),
      // EMBEDDED, not floating: inside the layer's own body box, in the flow.
      // (The old check asserted it was centred in the visible band below the
      // app header — the whole class of bug that centring dodged is gone with
      // the overlay.)
      embedded: (() => {
        const body = document.querySelector('.v2-layer > .ambient-layer-body');
        if (!w || !body) return false;
        const br = body.getBoundingClientRect();
        return body.contains(w) && getComputedStyle(w).position === 'static' &&
          r.top >= br.top - 1 && r.bottom <= br.bottom + 1 &&
          r.left >= br.left - 1 && r.right <= br.right + 1;
      })(),
      over,
    };
  });
  ok('the layer body IS the content — the drawing, and no settings in it',
    s.open && s.title === 'Content' && s.litNone && s.noContentBtn &&
    s.tabs === 0 && s.rows === 0 && s.hasViz && s.embedded && s.over <= 0,
    JSON.stringify(s));
  // …and the rest of this section reads the Instrument rows
  await tap('.v2-gototab[data-goto="Instrument"]');
  // one parameter at a time: exactly the active tab's rows are visible
  s = await page.evaluate(() => {
    const pane = document.querySelector('.v2-pop-pane');
    const rows = [...pane.querySelectorAll('.ambient-grp-body > .ambient-ctrl, .ambient-grp-body > .ambient-mod-target')];
    const vis = rows.filter((n) => getComputedStyle(n).display !== 'none');
    const act = (document.querySelector('.v2-pop-tab.on') || {}).getAttribute
      ? document.querySelector('.v2-pop-tab.on').getAttribute('data-tab') : null;
    return { vis: vis.length, act };
  });
  // RESTATED: it counted rows (1-3), which was a proxy for "only one tab is
  // showing" — and broke when a tab legitimately grew a couple of folded
  // subsection headers. Assert the thing itself: every visible row belongs to
  // the ACTIVE tab, and no row of another tab is on screen.
  s = await page.evaluate(() => {
    const pane = document.querySelector('.v2-pop-pane');
    const rows = [...pane.querySelectorAll('.ambient-grp-body > .ambient-ctrl, .ambient-grp-body > .ambient-mod-target')];
    const act = (document.querySelector('.v2-pop-tab.on') || {}).getAttribute
      ? document.querySelector('.v2-pop-tab.on').getAttribute('data-tab') : null;
    const nameOf = (r) => {
      const t = r.getAttribute('data-v2tab'); if (t) return t;
      const lab = r.querySelector(':scope > label') || r.querySelector('.ambient-mod-sub');
      if (!lab) return '…';
      const s2 = ((lab.childNodes[0] && lab.childNodes[0].textContent) || lab.textContent || '').trim();
      return (s2.split('·')[0].trim()) || '…';
    };
    const vis = rows.filter((n) => getComputedStyle(n).display !== 'none');
    return { vis: vis.length, act, strays: vis.filter((r) => nameOf(r) !== act).map(nameOf) };
  });
  ok('sheet shows one tab of rows at a time', s.vis >= 1 && !!s.act && s.strays.length === 0,
    JSON.stringify(s));
  // switching tabs moves the visible row
  s = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.v2-pop-tab')];
    return tabs.length > 1 ? tabs[1].getAttribute('data-tab') : null;
  });
  if (s) {
    const want = s;
    await tap('.v2-pop-tab:nth-child(2)');
    s = await page.evaluate(() => {
      const on = document.querySelector('.v2-pop-tab.on');
      const pane = document.querySelector('.v2-pop-pane');
      const vis = [...pane.querySelectorAll('.ambient-grp-body > *')]
        .filter((n) => n.classList && !n.classList.contains('v2-rowoff') &&
                       getComputedStyle(n).display !== 'none' && n.querySelector('label'));
      return { on: on && on.getAttribute('data-tab'),
               lab: vis[0] ? (vis[0].querySelector('label').childNodes[0] || {}).textContent : null };
    });
    ok('tab switch shows that parameter', s.on === want, JSON.stringify({ want, got: s }));
  }
  // COLLAPSING returns the rows to their group — nothing orphaned. There is no
  // close button now (the editor is the body), so the contract moved to the
  // caret: a folded card must give its borrowed rows back, or a rebuild would
  // mint a second copy of every id-bound control.
  await tap('.v2-layer .ambient-collapse');
  s = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const g = [...c.querySelectorAll('.ambient-grp')].find((x) => x.getAttribute('data-v2grp') === 'Instrument');
    return {
      gone: !document.querySelector('.v2-pop-wrap'),
      rowsBack: g ? g.querySelectorAll('.ambient-grp-body .ambient-ctrl').length : 0,
    };
  });
  ok('collapsing the card returns its rows to the group', s.gone && s.rowsBack > 3, JSON.stringify(s));
  await tap('.v2-layer .ambient-collapse');   // …and back, for the checks below

  // ---- ON / OFF -----------------------------------------------------------
  const onBefore = (await state()).on;
  await tap('.v2-layer .ambient-toggle');
  ok('on/off toggles the config', (await state()).on === !onBefore);
  await tap('.v2-layer .ambient-toggle');
  ok('on/off toggles back', (await state()).on === onBefore);

  // ---- ⋯ MENU -------------------------------------------------------------
  e = await tap('.v2-layer .ambient-layer-menu-btn');
  ok('layer menu opens', !e && (await state()).menuOpen, e);
  await page.evaluate(() => document.querySelectorAll('.ctx-menu').forEach((m) => m.remove()));

  // ---- STEPPER (must move by exactly one) ---------------------------------
  // Register lives in the SHEET HEAD now, not in a tab — it is the control you
  // reach for while listening. Same markup, same document-level ± delegation,
  // so the check follows it rather than being dropped.
  await tap('.v2-gototab[data-goto="Instrument"]');
  const regBefore = (await state()).register;
  await tap('.v2-pop-xtra .ambient-step-up');
  s = await state();
  ok('stepper + moves by exactly 1 (no double-fire)', s.register === regBefore + 1,
    'was ' + regBefore + ' now ' + s.register);

  // ---- SELECT writes + the gate follows ------------------------------------
  await page.evaluate(() => {
    const el = document.querySelector('.v2-layer [data-f="part.rhythm.kind"]');
    el.value = 'euclid'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await zz(250);
  s = await state();
  ok('select writes to the config', s.rhythm === 'euclid');
  const gate = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    // BY FIELD, NOT BY LABEL (2026-09-15). These two rows live only in the
    // ⚙ Generated panel now — the Method tab's duplicates of them are gone —
    // and THE PANEL CALLS BOTH OF THEM "How many": `pulses` is the euclid
    // count, `n` the pulse count, and the GATE is the only thing that tells
    // them apart. A label-based check could not see the difference at all, so
    // it asks the field whose gate is under test. (`applyGate` owns the inline
    // display on a gated row whether or not the panel is open, which is what
    // this reads — the panel being reachable is pinned where it is opened.)
    const rowOf = (f) => { const el = c.querySelector('[data-f="' + f + '"]');
      return el ? (el.closest('.ambient-ctrl') || el.parentElement) : null; };
    const shown = (f) => { const r = rowOf(f); return !!r && r.style.display !== 'none'; };
    return { pulses: shown('part.rhythm.pulses'), onsets: shown('part.rhythm.n'),
             labs: ['part.rhythm.pulses', 'part.rhythm.n'].map((f) => { const r = rowOf(f);
               const lb = r && r.querySelector('label');
               return ((lb && lb.textContent) || '?').trim(); }).join(' / ') };
  });
  ok('gate follows the piece value (euclid shows Pulses, hides Onsets)', gate.pulses && !gate.onsets, JSON.stringify(gate));

  // ---- WRITE: THE DOOR (live → recorded → live) ---------------------------
  // Driven through the ⋯ menu, i.e. the way a user reaches it — not by calling
  // the API. A menu item that exists but cannot be reached is the failure this
  // repo has shipped more than once.
  const menuItem = async (match) => {
    await tap('.v2-layer .ambient-layer-menu-btn');
    const clicked = await page.evaluate((m) => {
      const items = [...document.querySelectorAll('.ctx-menu button, .ctx-menu [role="menuitem"], .ctx-menu div')];
      const it = items.find((x) => new RegExp(m).test((x.textContent || '').replace(/\s+/g, ' ')));
      if (!it) return false;
      it.click();
      return true;
    }, match);
    await zz(400);
    await page.evaluate(() => document.querySelectorAll('.ctx-menu').forEach((m) => m.remove()));
    return clicked;
  };
  const partKind = () => page.evaluate(() => (_masterEng.getCfg().layers || [])[0].part.kind);

  ok('Capture is offered on a live layer', await menuItem('Capture'));
  ok('Capture makes the part recorded', (await partKind()) === 'recorded');
  const kept = await page.evaluate(() => {
    const p = (_masterEng.getCfg().layers || [])[0].part;
    return { notes: (p.notes || []).length, liveSpec: !!(p.rhythm && p.rhythm.kind) };
  });
  ok('Capture stores notes AND keeps the live spec', kept.notes > 0 && kept.liveSpec, JSON.stringify(kept));
  ok('Release is offered on a captured layer', await menuItem('Release'));
  ok('Release returns it to live', (await partKind()) === 'live');

  // THE DEAD END, reported by the user: picking "Recorded" from the dropdown on a
  // layer with no notes is a silent part with no way forward. There must be a way
  // to CREATE a recorded part from the card itself, not only from the ⋯ menu.
  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    L.part.notes = [];                              // a genuinely empty recorded part
    // (the Source select is gone — it was the destructive door to this state,
    // writing the field and capturing nothing. The state itself still exists,
    // reached by locking an empty take or loaded from a project, and it still
    // has to explain itself.)
    L.part.kind = 'recorded'; _masterEng.getCfg();
    window._v2.render(_masterEng);
  });
  await zz(350);
  // RESTATED, not relaxed. It pinned the SENTENCE ("Nothing recorded yet"),
  // which broke when the empty state was reworded to name its new door — while
  // the contract it exists for never moved. Assert the contract instead, and
  // one notch harder than before: the explanation must name a control that is
  // actually ON the card, so a hint pointing at a button that no longer exists
  // fails here rather than being read by a user who then cannot find it.
  const emptyState = await page.evaluate(() => {
    const hint = [...document.querySelectorAll('.v2-layer .ambient-hint')]
      .map((h) => h.textContent.trim())
      .find((t) => /nothing (here|recorded) yet/i.test(t)) || '';
    const named = [...document.querySelectorAll('.v2-layer button')]
      .filter((b) => b.offsetParent !== null || b.closest('.v2-partviz'))
      .map((b) => b.textContent.trim().replace(/^[^A-Za-z]+/, ''))
      .filter(Boolean);
    return {
      notes: ((_masterEng.getCfg().layers || [])[0].part.notes || []).length,
      hint: hint,
      // the hint has to point somewhere real
      doorOnCard: named.some((n) => n && hint.indexOf(n) >= 0),
    };
  });
  ok('an empty recorded part explains itself, naming a door that is on the card',
    emptyState.notes === 0 && !!emptyState.hint && emptyState.doorOnCard, JSON.stringify(emptyState));
  // THE TAKE BAR IS TWO BUTTONS WITH ONE JOB EACH: 🎲 makes material (New
  // take / Roll a take / Replace / Re-roll bar N) and the second is a pure
  // toggle along the STATIC ⟷ GENERATED axis (WRITTEN until 2026-09-16 —
  // the state gave the word up, see the vocabulary check below). It used to carry a "Replace
  // with a new take" face — a control that sometimes DISCARDS your notes is
  // two actions in one — and before that "❄ Re-take live", which sounds like
  // the way back to Generated. RESTATED 2026-09-13 (user: "the lock/unlock,
  // written/generated functional distinction is confusing"): the faces said
  // Lock/Unlock while the state said Written/Generated, i.e. one axis named in
  // two languages. Same contract, the axis's own words — and now BOTH written
  // cases carry ONE face, where `made` used to split them three ways.
  const capFaces = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const cap = () => card().querySelector('.v2-capture');
    const face = () => ({ txt: cap().textContent.trim(), title: cap().title });
    L().part.kind = 'live'; E.getCfg(); window._v2.render(E);
    await wait(250); card().classList.remove('collapsed');
    const live = { ...face(), nt: { txt: card().querySelector('.v2-newtake').textContent.trim() } };
    L().part.kind = 'recorded'; L().part.notes = []; E.getCfg();
    window._v2.render(E); await wait(250); card().classList.remove('collapsed');
    const nt = () => card().querySelector('.v2-newtake');
    const ntFace = () => ({ txt: nt().textContent.trim(), title: nt().title });
    const emptyFixed = { cap: face(), nt: ntFace() };
    window.confirm = () => true;
    nt().click(); await wait(350);          // 🎲 fills it, still STATIC
    const filled = { cap: face(), nt: ntFace(), kind: L().part.kind };
    cap().click(); await wait(350);         // the SAME button hands it back
    const released = { cap: face(), kind: L().part.kind };
    return { live, emptyFixed, filled, released, made: L().part.made, n: (L().part.notes || []).length };
  });
  // RENAMED 2026-09-16 with the state's word: the axis is GENERATED ⟷ STATIC.
  // The ACTION on the face is untouched on purpose — ✎ Write it down is
  // transcribing, and the state it produces is what changed its name.
  ok('the take bar is 🎲 make + a STATIC⟷GENERATED toggle — each face with its own tooltip',
    /Write it down/.test(capFaces.live.txt) && /drawn above/.test(capFaces.live.title) &&
    /New take/.test(capFaces.live.nt.txt) &&
    /Generate instead/.test(capFaces.emptyFixed.cap.txt) && /Roll a take/.test(capFaces.emptyFixed.nt.txt) &&
    /Replace/.test(capFaces.filled.nt.txt) && /still STATIC/.test(capFaces.filled.nt.title) &&
    capFaces.filled.kind === 'recorded' &&
    /Write it down/.test(capFaces.released.cap.txt) && capFaces.released.kind === 'live' &&
    capFaces.live.title !== capFaces.emptyFixed.cap.title,
    JSON.stringify(capFaces).slice(0, 300));
  ok('nothing on the card offers to "re-take live" — the way back is the Source select',
    await page.evaluate(() => !/Re-take live/i.test(document.querySelector('.v2-layer').textContent)), '');
  // ── THE KEEP GATE (2026-09-18) ────────────────────────────────
  // 💾 Save this take used to be a button of its own beside the dice, which is
  // the right PLACE and the wrong SHAPE — whether a take was worth keeping is
  // only answerable at the moment it is about to be lost. So the button is gone
  // and 🎲 New take asks, with three answers: save it to the bank and then
  // roll, roll over it, or close and keep what is there. WHAT IS PINNED HERE is
  // that all three are on offer, that the head names the thing at risk in the
  // SAME words the old confirm used (`takeCost`, one vocabulary), and that
  // CLOSING IS A CANCEL — a gate that rolls anyway is worse than no gate.
  const capConfirm = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const cap = () => document.querySelector('.v2-layer .v2-newtake');
    window.confirm = () => true;
    // A GATE PRESUPPOSES SOMETHING TO LOSE — set up a locked part with notes
    // through the real button rather than inheriting whatever the last check left
    if (L().part.kind !== 'recorded' || !(L().part.notes || []).length) {
      document.querySelector('.v2-layer .v2-capture').click(); await wait(350);
    }
    const plain = window.__gatePeek(cap()); await wait(120);
    L().part.notes[0].vel = 40; E.getCfg();
    const edited = window.__gatePeek(cap()); await wait(120);
    // closing must change nothing
    L().part.notes[0].atk = 900; E.getCfg();
    const before = JSON.stringify(L().part.notes);
    const closed = await window.__gate(cap(), 'close'); await wait(350);
    return { plain, edited, closed, declineKeeps: JSON.stringify(L().part.notes) === before,
             made: L().part.made, leftOpen: !!document.querySelector('.ambient-addpop') };
  });
  ok('🎲 New take asks first — save it to the bank, roll over it, or close and keep it',
    !!capConfirm.plain && /keep this one/i.test(capConfirm.plain.title) &&
    capConfirm.plain.btns.some((b) => /Save it to the bank/.test(b)) &&
    capConfirm.plain.btns.some((b) => /this take is gone/.test(b)) &&
    capConfirm.closed === 'ok' && capConfirm.declineKeeps && !capConfirm.leftOpen,
    JSON.stringify(capConfirm).slice(0, 320));
  ok('the gate names what is at risk in the replace-confirm\u2019s own words',
    !!capConfirm.edited && /your edits to these notes/.test(capConfirm.edited.head) &&
    /cannot be undone/.test(capConfirm.edited.head),
    JSON.stringify(capConfirm.edited || null).slice(0, 240));
  // EMPTY IT FIRST, or this check measures nothing: with notes present the tap
  // opens the gate, and "there are notes afterwards" would pass without the
  // button doing anything. An empty part has nothing to keep, so no gate opens
  // — which is the other half of the contract.
  await page.evaluate(() => {
    const E = _masterEng, L = () => window.__Lv2(E);
    L().part.kind = 'recorded'; L().part.notes = []; E.getCfg();
    const h2 = document.getElementById('bloom-v2-layers'); if (h2) h2._sig = '';
    window._v2.render(E);
  });
  await zz(400);
  await page.evaluate(() => document.querySelector('.v2-layer').classList.remove('collapsed'));
  e = await tap('.v2-layer .v2-newtake');
  ok('rolling a take is reachable ON THE CARD', !e, e);
  await zz(350);
  const escaped = await page.evaluate(() => ({
    n: ((_masterEng.getCfg().layers || [])[0].part.notes || []).length,
    gate: !!document.querySelector('.ambient-addpop') }));
  ok('the card button fills an empty recorded part, and asks nothing — there was nothing to keep',
    escaped.n > 0 && !escaped.gate, JSON.stringify(escaped));

  // ---- MATERIAL FIRST, AND EACH ONE REMEMBERS ITSELF ----------------------
  // Material is what the part is MADE OF; Cycle, Bars, Plays and Transpose are
  // answers ABOUT a part you already made, and it sat eighth behind them. And
  // pressing a material button used to overwrite the live spec outright, so
  // tuning an arpeggio, trying a pad and coming back gave you the FACTORY
  // arpeggio and your work was gone.
  const matRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    L().part.kind = 'live'; E.getCfg(); window._v2.render(E);
    await wait(250);
    const c2 = document.querySelector('.v2-layer');
    c2.classList.remove('collapsed');
    window.__sec('Generate');
    await wait(300);
    // THE MAKING STEPS are the ✦ Make section's own tabs now (2026-09-13): the
    // family ROWS became section buttons, so `make` is a popover rather than a
    // family chip, and Bank is its own button rather than a chip at the right
    // end — still a different KIND of destination, one level out.
    { const mb = document.querySelector('.v2-gototab[data-goto="Generate"]'); if (mb) mb.click(); }
    await wait(300);
    const tabs = [...document.querySelectorAll('.v2-pop-tabs .v2-pop-tab')].map((t) => t.getAttribute('data-tab'));
    { const cb = document.querySelector('.v2-secpop-close'); if (cb) cb.click(); }
    await wait(200);
    // tune an arpeggio, go elsewhere, come back
    window._v2.makeArp(E, L()); E.getCfg();
    L().part.rhythm.n = 13; L().part.pitch.octaves = 4; E.getCfg();
    window._v2.makeSustain(E, L(), true); E.getCfg();
    const sus = { kind: L().part.rhythm.kind, n: L().part.rhythm.n };
    L().part.pitch.voices = 5; E.getCfg();
    window._v2.makeArp(E, L()); E.getCfg();
    const back = { n: L().part.rhythm.n, oct: L().part.pitch.octaves };
    window._v2.makeSustain(E, L(), true); E.getCfg();
    const backSus = { voices: L().part.pitch.voices, n: L().part.rhythm.n };
    // a roll must still ROLL — a material that restored itself would stop
    const b4 = JSON.stringify(L().part.rhythm);
    window._v2.rollRun(E, L()); E.getCfg();
    return { tabs, sus, back, backSus, rolled: JSON.stringify(L().part.rhythm) !== b4 };
  });
  ok('Method is the first thing ✦ Generate offers',
    matRun.tabs[0] === 'Method', JSON.stringify(matRun.tabs));
  ok('each material remembers its own settings across a switch',
    matRun.sus.n === 1 && matRun.back.n === 13 && matRun.back.oct === 4 && matRun.backSus.voices === 5,
    JSON.stringify(matRun));
  ok('…and a roll still rolls, because a re-roll is what it is for',
    matRun.rolled, String(matRun.rolled));

  // ---- SAVE A TAKE, INTO THE BANK THAT MAPS TO CHANGES --------------------
  // Keeping a take is the FIRST ANSWER the dice offers (2026-09-18) — the press
  // that would destroy it is the one that asks — and it goes into the SAME bank
  // `partSeqs` maps by name onto a part/pass/chord, not a private list.
  // BOTH DOORS ARE DRIVEN HERE: save through 🎲 New take's gate, and load back
  // through the Bank's own gate, which asks the same question in the other
  // direction (what is here now is what you are about to lose).
  const bankRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    // A DETERMINISTIC PART, not a rolled one. The first version stretched a
    // note of a random roll, and a rolled take's durations do not land cleanly
    // on the cell grid — so `round(dur * gridN)` differed by one after the trip
    // and the check FLAKED, which is worse than not having it. Known notes,
    // known grid, exact answer. (Diagnosed by round-tripping this same fixture
    // directly: onsets, pitches and durations all come back exact.)
    L().part.kind = 'recorded'; L().part.bars = 1;
    L().part.rhythm = { kind: 'pulse', n: 4, steps: 16 };
    L().part.notes = [{ t: 0, midi: 60, dur: 4 / 16 }, { t: 4 / 16, midi: 64, dur: 2 / 16 },
                      { t: 8 / 16, midi: 67, dur: 1 / 16 }, { t: 12 / 16, midi: 72, dur: 4 / 16 }];
    L().part.made = 'take';
    E.getCfg();
    window._v2.render(E); await wait(250); card().classList.remove('collapsed');
    const gridN = 16;
    const cells = (n) => Math.max(1, Math.round(n.dur * gridN));
    const before = JSON.stringify(L().part.notes.map((n) => [Math.round(n.t * 1000), n.midi, cells(n)]));
    const btn = card().querySelector('.v2-newtake');
    if (btn && card().querySelector('.v2-savetake')) return { err: 'the save button is back' };
    window.prompt = () => 'gate-take'; window.confirm = () => true;
    const saved = await window.__gate(btn, 'save'); await wait(420);
    card().classList.remove('collapsed');
    const inBank = savedSequences.some((s2) => s2 && s2.name === 'gate-take');
    // it must READ BACK as the same notes — a take that cannot be reloaded
    // exactly is a take you have lost. (The gate's Save ROLLS afterwards, which
    // is the point: what is on the part now is NOT what was banked.)
    window._v2.rollRun(E, L()); E.getCfg();
    const row = card().querySelector('.v2-bankit .v2-bkload');
    const bi = row ? row.getAttribute('data-bi') : null;
    const loaded = await window.__gate(row, 'roll');
    await wait(420); card().classList.remove('collapsed');
    const after = JSON.stringify(L().part.notes.map((n) => [Math.round(n.t * 1000), n.midi, cells(n)]));
    const names = () => savedSequences.map((s2) => s2.name).join(',');
    const order0 = names();
    const up = card().querySelector('.v2-bkup[data-bi="1"]');
    if (up) { up.click(); await wait(280); card().classList.remove('collapsed'); }
    const order1 = names();
    const out2 = { inBank, saved, loaded, roundTrip: after === before,
                   rows: card().querySelectorAll('.v2-bankit').length, order0, order1, bi };
    // PUT THE BANK BACK. These cases run in ONE page against ONE bank, so an
    // entry left behind is the next check's bug — "an empty bank says where
    // phrases come from" is two checks later and this one had filled it.
    for (let k = savedSequences.length - 1; k >= 0; k--) {
      if (savedSequences[k] && savedSequences[k].name === 'gate-take') savedSequences.splice(k, 1);
    }
    try { if (typeof persistSaved === 'function') persistSaved(); } catch (e) {}
    window._v2.render(_masterEng);
    return out2;
  });
  ok('a take saves into the bank through 🎲 New take’s gate, and reloads EXACTLY',
    bankRun.saved === 'ok' && bankRun.inBank && bankRun.loaded === 'ok' && bankRun.roundTrip,
    JSON.stringify(bankRun).slice(0, 260));
  ok('the Saved bank can be reordered',
    bankRun.rows >= 1 && (bankRun.rows < 2 || bankRun.order0 !== bankRun.order1),
    JSON.stringify({ rows: bankRun.rows, a: bankRun.order0, b: bankRun.order1 }));

  // ---- ℹ WHY THESE NOTES --------------------------------------------------
  // WHAT IT PINS: that the panel REPORTS THE PART, not a template. The easy way
  // to build this feature is a paragraph of prose about the settings, which
  // would pass any check that only looked for headings — so the assertions are
  // on numbers that came off the notes themselves (the note count, the pulse
  // count, the resolved Rests) and on the CONTROL NAMES, which are the half
  // that makes it actionable. A "why" that names no knob is a dead end.
  // It also pins the two ways OUT: a read-only panel with a live scrim that
  // will not close is a trapped card.
  const whyRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const show = async () => {
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(240);
      card().classList.remove('collapsed');
      const b = card().querySelector('.v2-whybtn');
      const g = b && b.closest && b.closest('.ambient-grp'); if (g) g.classList.add('open');
      await wait(120);
    };
    const press = async () => {
      const b = card().querySelector('.v2-whybtn'); if (!b) return 'no button';
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return 'zero-size';
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!(hit === b || b.contains(hit))) return 'covered';
      b.click(); await wait(260); return null;
    };
    const body = () => (card().querySelector('.v2-whybody') || {}).textContent || '';
    const open = () => card().classList.contains('v2-whyopen');

    // ONE PAGE, ONE STATE. This check rewrites the part's rhythm, pitch, shape,
    // kind, provenance and note list, and the first cut restored NONE of it —
    // 14 downstream checks failed on the fixture it left behind (the emitter,
    // the forms, Groundwork, per-part content). Snapshot the WHOLE layer, not
    // the fields worth remembering, and put it back in a `finally` so a throw
    // mid-check cannot poison the rest of the run either.
    const snap = JSON.parse(JSON.stringify(L()));
    const o = {};
    try {

    // A GENERATED part with a rhythm and a pitch rule that both have something
    // to say, and a REST so the recipe and the outcome must disagree by a
    // number the panel has to get right.
    L().part.kind = 'live'; L().part.made = 'take'; L().part.take = 2;
    L().part.bars = 1;
    L().part.rhythm = Object.assign(L().part.rhythm || {},
      { kind: 'euclid', pulses: 5, steps: 16, rotate: 2 });
    L().part.pitch = Object.assign(L().part.pitch || {}, { kind: 'walk', degree: 3, span: 5 });
    L().part.shape = Object.assign(L().part.shape || {}, { lenRatio: 80 });
    L().restProb = 20; L().proximity = 40;
    E.getCfg();
    await show();
    o.press = await press();
    o.opened = open();
    const txt = body();
    o.secs = [...card().querySelectorAll('.v2-whysec h4')].map((h) => h.textContent);
    // RESTATED 2026-09-15 — the panel was prose about the settings and is now
    // LABEL → VALUE rows (user: "too verbose, needs to be more clearly rooted
    // in parameter settings"). Same contract, read off the rows instead of out
    // of a paragraph: every number is the PART's, and the label is the card's
    // own control name. Asserting the pairs is strictly stronger than the old
    // regexes, which a sentence containing the right digits could satisfy.
    const rows = {};
    card().querySelectorAll('.v2-whyrow').forEach((rw) => {
      const k = rw.querySelector('.v2-whyk'), v = rw.querySelector('.v2-whyv');
      if (k && v) rows[k.textContent.trim()] = v.textContent.trim();
    });
    o.rows = rows;
    // 'Step count', not 'Steps' — restated 2026-09-15: a row labelled Steps sat
    // under a switch whose other mode is ▦ Steps, the third collision of that
    // shape on this card. Same contract, the euclid step count, said so it
    // cannot be read as the form.
    // 'Euclid', not 'Pattern' — restated 2026-09-15 when ▦ Steps became
    // ▦ Pattern (it always WAS the Pattern grid), which freed the word and made
    // the euclid rule take back the name the app already uses for it elsewhere.
    o.saysPulses = rows.Rhythm === 'Euclid' && rows.Pulses === '5' && rows.Steps === '16';
    // …and NOTHING from the form that is not playing. The fixture is a ⌗ Roll
    // part, so the grid's own rows must be absent entirely — listing a dead
    // parameter is what this scoping undid.
    o.noStepsRows = !('Lit' in rows);
    // THE PANEL STATES THE FORM, IN THE SWITCH'S OWN WORDS. Without this row the
    // only structural word here was the rhythm value 'Pattern', which was read
    // as an answer about the form ("Why still says it's a Pattern when it's a
    // Roll"). Asserting the exact string is the point: a THIRD wording for this
    // axis would be the same bug wearing a different word.
    o.saysForm = rows.Form === card().querySelector('.v2-formbtn .v2-formnow').textContent.trim();
    o.formIsRoll = rows.Form === '⌗ Roll';
    o.saysRotate = rows.Rotate === '2 steps';
    o.saysRests = rows.Rests === '20%';
    o.saysLength = rows.Length === '80% of each slot';
    o.saysWalk = rows.Pitch === 'Walk' && rows.Note === 'source tone 3' && rows.Span === '5 tones';
    o.saysTake = /take 2/.test(txt);
    // …and THE OUTCOME, measured off the notes rather than predicted
    const ns = window._v2.takeNotesNow(E, L()) || [];
    o.noteN = ns.length;
    o.outs = [...card().querySelectorAll('.v2-whyout')].map((e) => e.textContent.trim());
    o.saysCount = o.outs[0] === ns.length + (ns.length === 1 ? ' note' : ' notes') + ' · ' +
      new Set(ns.map((n) => Math.round(n.t * 10000))).size + ' onsets';
    // the row LABEL is the control — that is what makes the panel actionable,
    // and it replaced a separate chip saying the same word twice
    o.namesKnobs = ['Rests', 'Length', 'Register', 'Proximity'].every((k) => k in rows);
    // NO PROSE. Every <p> in the body is the lead or a section's measured tail;
    // an explanatory paragraph anywhere else is the regression this rewrite
    // undid, and nothing else in the panel can see it.
    o.strayP = [...card().querySelectorAll('.v2-whybody p')]
      .filter((e) => !e.classList.contains('v2-whylead') && !e.classList.contains('v2-whyout')).length;
    o.chars = txt.length;
    // the panel FITS and nothing runs out of it (UI rule 2 — this is the one
    // v2 popover made of sentences)
    const pop = card().querySelector('.v2-whypop');
    const pr = pop ? pop.getBoundingClientRect() : null;
    o.fits = !!pr && pr.left >= -1 && pr.right <= window.innerWidth + 1 && pr.height > 100;
    o.noSpill = [...card().querySelectorAll('.v2-whybody *')]
      .filter((e) => e.scrollWidth > e.clientWidth + 1).length === 0;
    // the ✕ is IN THE CORNER and is what a tap there actually hits
    const xb = card().querySelector('.v2-whyclose');
    const xr = xb ? xb.getBoundingClientRect() : null;
    o.closeCorner = !!xr && pr && (pr.right - xr.right) < 30 && (xr.top - pr.top) < 30;
    o.closeHits = !!xr && (() => { const h2 = document.elementFromPoint(
      xr.left + xr.width / 2, xr.top + xr.height / 2); return h2 === xb || xb.contains(h2); })();
    // ── BOTH WAYS OUT
    xb.click(); await wait(180); o.closedByX = !open();
    await press(); o.reopened = open();
    card().querySelector('.v2-whyscrim').click(); await wait(180); o.closedByScrim = !open();

    // ── A GENERATED TAKE THAT HAS BEEN WRITTEN DOWN STILL EXPLAINS ITSELF.
    // `part.made === 'take'` says the app made these, and that stays true once
    // they are stored — so the rules must still be here. A cut that read
    // `kind === 'recorded'` as "nothing to explain" answered "the notes, as
    // written" and dropped every rule, which is the whole feature.
    L().part.kind = 'recorded'; L().part.made = 'take';
    L().part.notes = Array.from({ length: 6 }, (_, i) => ({ t: i / 6, midi: 60 + i, dur: 0.1 }));
    E.getCfg();
    await show();
    o.wdPress = await press();
    const wd = {};
    card().querySelectorAll('.v2-whyrow').forEach((rw) => {
      const k = rw.querySelector('.v2-whyk'), v = rw.querySelector('.v2-whyv');
      if (k && v) wd[k.textContent.trim()] = v.textContent.trim();
    });
    o.wdRows = wd;
    // the SAME rule rows as when it was live — pulses, step count, length, walk
    o.wdKeepsRules = wd.Rhythm === 'Euclid' && wd.Pulses === '5' &&
      wd.Steps === '16' && wd.Length === '80% of each slot' &&
      wd.Pitch === 'Walk' && wd.Span === '5 tones';
    // …and it says it is GENERATED, not merely written
    const wdLead = (card().querySelector('.v2-whylead') || {}).textContent || '';
    o.wdSaysGenerated = /Generated/.test(wdLead) && /take 2/.test(wdLead);
    // …and names the one thing that DID change: the rules no longer move them
    // the caveat moved to the measured-line styling, so read the whole body
    o.wdSaysFixed = /written down/i.test(wdLead) && /fixed/i.test(body());
    // Follows switches to the control that is live for a stored take
    o.wdFollows = /Keep the written pitches|Follow the key|Lock to the chord/.test(wd.Follows || '');
    card().querySelector('.v2-whyscrim').click(); await wait(150);

    // ── HAND-MADE NOTES GET A DIFFERENT, SHORTER ANSWER, and the button is
    // still there to give it: a button that vanished would read as missing.
    L().part.kind = 'recorded'; L().part.made = '';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 64, dur: 0.2 }];
    E.getCfg();
    await show();
    o.handPress = await press();
    const ht = body();
    o.handSaysDrawn = /drawn by hand/i.test(ht) && /no rule/i.test(ht);
    o.handNoSections = card().querySelectorAll('.v2-whysec').length === 0;
    } finally {
      // the panel is a CLASS on the card, so closing it is part of the restore
      try { card().classList.remove('v2-whyopen'); } catch (e) {}
      const cur = L();
      Object.keys(cur).forEach((k) => { if (!(k in snap)) delete cur[k]; });
      Object.keys(snap).forEach((k) => { cur[k] = snap[k]; });
      E.getCfg();
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(240);
    }
    return o;
  });
  ok('ℹ Why? is a PARAMETER readout — the part’s own values, labelled with the card’s own controls',
    !whyRun.press && whyRun.opened &&
    JSON.stringify(whyRun.secs) ===
      JSON.stringify(['Where they are', 'How long they are', 'What pitch they are']) &&
    whyRun.saysTake && whyRun.saysPulses && whyRun.saysRotate && whyRun.saysRests &&
    whyRun.saysLength && whyRun.saysWalk && whyRun.saysCount && whyRun.namesKnobs &&
    whyRun.saysForm && whyRun.formIsRoll && whyRun.noStepsRows,
    JSON.stringify({ rows: whyRun.rows, outs: whyRun.outs, n: whyRun.noteN }).slice(0, 400));
  // A WATCHDOG, not a target: the first cut was 1100+ characters of explanation
  // and read as a wall. Rows are terse by construction, so a large number here
  // means sentences have crept back in.
  ok('…and it says it in VALUES, not prose',
    whyRun.strayP === 0 && whyRun.chars < 520,
    JSON.stringify({ strayP: whyRun.strayP, chars: whyRun.chars }));
  ok('…the panel fits, nothing spills, and both ways out work',
    whyRun.fits && whyRun.noSpill && whyRun.closeCorner && whyRun.closeHits &&
    whyRun.closedByX && whyRun.reopened && whyRun.closedByScrim,
    JSON.stringify(whyRun).slice(0, 300));
  ok('…a GENERATED take still explains itself after ✎ Write it down',
    !whyRun.wdPress && whyRun.wdKeepsRules && whyRun.wdSaysGenerated &&
    whyRun.wdSaysFixed && whyRun.wdFollows,
    JSON.stringify({ rows: whyRun.wdRows, gen: whyRun.wdSaysGenerated,
      fixed: whyRun.wdSaysFixed, follows: whyRun.wdFollows }).slice(0, 320));
  ok('…and hand-made notes get the short answer, from the same button',
    !whyRun.handPress && whyRun.handSaysDrawn && whyRun.handNoSections,
    JSON.stringify({ p: whyRun.handPress, d: whyRun.handSaysDrawn, s: whyRun.handNoSections }));

  // ---- PER-BAR RE-ROLL ----------------------------------------------------
  // Tap a bar in the drawing to pick it; Replace then rolls ONLY those bars —
  // everything else keeps exactly what it has, per-note edits included. With
  // nothing picked, Replace re-rolls everything, and that press must actually
  // CHANGE the notes: the pinned take meant a "replace" that rolled the same
  // take again returned identical notes, and the old verification compared
  // `made`, never the notes.
  const barRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    window._v2.rollRun(E, L()); L().part.bars = 4; L().part.rhythm.steps = 16; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();
    window._v2.render(E); await wait(250); card().classList.remove('collapsed');
    const cv = () => card().querySelector('.v2-vizcv');
    // a hand edit OUTSIDE the selection must survive the re-roll untouched
    const b0note = L().part.notes.find((n) => Math.floor(n.t * 4) === 0);
    if (b0note) b0note.vel = 33;
    E.getCfg();
    const snap = () => L().part.notes.map((n) => [Math.round(n.t * 1000), n.midi, n.vel || 0])
      .sort((x, y) => x[0] - y[0]);
    const byBar = (list) => { const m = {}; list.forEach((r2) => {
      (m[Math.floor(r2[0] / 250)] = m[Math.floor(r2[0] / 250)] || []).push(r2); }); return m; };
    // THE TAP POINT IS FOUND, NOT GUESSED. A fixed y=16 sometimes lands on a
    // top-of-range note (its padded hit box reaches y=14), which opens the
    // editor instead of selecting — chance-dependent on the roll, and it
    // RESTATED 2026-09-08: bar select moved to the RULER STRIP only (a tap in
    // the open plot used to toggle bars, and every stray tap edited which
    // bars re-roll) — so the tap lands mid-bar in the ruler, where no note
    // box can ever claim the point.
    const tapBar = (bar) => {
      const r = cv().getBoundingClientRect(); const geo = cv()._barsGeo;
      const gx = geo.x0 || 0;
      const fx = gx + ((bar + 0.5) / geo.barsF) * geo.w;
      cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: r.left + fx, clientY: r.top + 8 }));
    };
    const before = snap();
    let asked = null; window.confirm = (m) => { asked = m; return true; };
    // pick a NON-EMPTY bar (never 0 — the hand edit lives there): an empty
    // bar's rhythm is deterministic across takes, so it can never "move"
    const bPick = byBar(before);
    const SB = +((['1', '2', '3'].find((k) => (bPick[k] || []).length)) || '1');
    tapBar(SB); await wait(250);
    const face = card().querySelector('.v2-newtake').textContent.trim();
    // UP TO THREE PRESSES. "The bar changed" after ONE press is a
    // chance-dependent assertion — a sparse bar can roll to the same content
    // once (this check flaked on exactly that). The selection survives a press
    // by design and every press bumps the take, so three identical rolls in a
    // row is a broken mechanism, never bad luck — while the OTHER bars must
    // hold on every press, which is the deterministic half.
    const bB = byBar(before);
    let after = before, othersHeld = true, selMoved = false, selFilled = false;
    // MOVED 2026-09-12: with bars tapped, 🎲 now OPENS that bar's generated
    // settings instead of rolling behind your back ("it should open a popover
    // showing the current generated settings"), and 🎲 Roll again inside it is
    // the throw. Same contract — the tapped bar re-rolls alone — driven
    // through the only door there is.
    const rollBar = async () => {
      if (!card().classList.contains('v2-baropen')) {
        card().querySelector('.v2-newtake').click(); await wait(300);
      }
      const rb2 = card().querySelector('.v2-barroll'); if (rb2) rb2.click();
    };
    for (let k2 = 0; k2 < 6 && !(selMoved && selFilled); k2++) {
      await rollBar(); await wait(350);
      after = snap();
      const bA2 = byBar(after);
      ['0', '1', '2', '3'].filter((kk) => +kk !== SB).forEach((kk) => {
        if (JSON.stringify(bB[kk] || []) !== JSON.stringify(bA2[kk] || [])) othersHeld = false;
      });
      if (JSON.stringify(bB[String(SB)] || []) !== JSON.stringify(bA2[String(SB)] || [])) selMoved = true;
      // …and FRESH MATERIAL must actually arrive: a splice that only ever
      // EMPTIES the bar still reads as "changed" (poison-verified — filtering
      // every fresh note out passed the changed-alone version of this check).
      if ((bA2[String(SB)] || []).length) selFilled = true;
    }
    const confirmScoped = asked;                 // edit is in bar 0, roll is bar 1
    const bA = byBar(after);
    const same = (k) => JSON.stringify(bB[k] || []) === JSON.stringify(bA[k] || []);
    // shut the settings panel before touching the drawing — its scrim covers
    // the canvas, which is the point of a modal
    const bc = card().querySelector('.v2-barclose'); if (bc) bc.click(); await wait(220);
    // deselect, then a FULL replace must change the notes
    tapBar(SB); await wait(250);
    const faceBack = card().querySelector('.v2-newtake').textContent.trim();
    const b4 = snap();
    await window.__gate(card().querySelector('.v2-newtake'), 'roll'); await wait(350);
    const fullChangedNow = JSON.stringify(snap()) !== JSON.stringify(b4);
    // CLEAN UP DETERMINISTICALLY — the selection keys on [kind, bars, clock],
    // so bouncing the kind clears it without a second chance-dependent tap.
    L().part.kind = 'live'; E.getCfg(); L().part.kind = 'recorded'; E.getCfg();
    window._v2.render(E); await wait(200); card().classList.remove('collapsed');
    return { face, faceBack, confirmScoped, fullChangedNow,
             othersKept: othersHeld, selChanged: selMoved && selFilled,
             editKept: (L().part.notes || []).length >= 0 && JSON.stringify(bB[0] || []) === JSON.stringify(bA[0] || []),
             fullChanged: fullChangedNow };
  });
  // RESTATED 2026-09-12 with the reason: the face ends in an ELLIPSIS now,
  // because with bars tapped the press OPENS that bar's settings rather than
  // rolling. The claim the check makes — the tapped bar re-rolls alone — is
  // unchanged; it is driven through the panel, which is the only door.
  ok('a tapped bar re-rolls ALONE — every other bar, edits included, is untouched',
    /Re-roll bar \d\u2026/.test(barRun.face) && barRun.othersKept && barRun.selChanged &&
    barRun.confirmScoped === null,     // the bar-0 edit is out of scope, so no confirm
    JSON.stringify(barRun).slice(0, 260));
  ok('deselecting restores full replace, and a full replace actually changes the notes',
    /Replace with a new take/.test(barRun.faceBack) && barRun.fullChanged, JSON.stringify(barRun).slice(0, 200));

  // ---- NEW TAKE REWRITES, SILENTLY — AND RETAKES SELECTED BARS ------------
  // 🎲 used to audition the new roll, which on the phone's ~1 s broadcast read
  // as "it just played the current content" — the press's outcome is the
  // DRAWING now, and ▶ Preview stays the only thing that makes sound. And a
  // LIVE part selects bars exactly as a recorded one does: with bars tapped,
  // 🎲 retakes just those (a per-bar pin, `part.takeb`), the rest of the
  // drawing holding still.
  const ntRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    L().part.kind = 'live'; delete L().part.takeb; E.getCfg();
    window._v2.rollRun(E, L()); L().part.bars = 4; E.getCfg();
    window._v2.render(E); await wait(250); card().classList.remove('collapsed');
    const cv = () => card().querySelector('.v2-vizcv');
    const barsOf = () => { const m = {}; (cv()._hits || []).forEach((h) => {
      const b2 = Math.floor(h.t * 4); (m[b2] = m[b2] || []).push(Math.round(h.x) + ':' + Math.round(h.midi)); }); return m; };
    // RESTATED 2026-09-08: bar select moved to the RULER STRIP only (a tap in
    // the open plot used to toggle bars, and every stray tap edited which
    // bars re-roll) — so the tap lands mid-bar in the ruler, where no note
    // box can ever claim the point.
    const tapBar = (bar) => {
      const r = cv().getBoundingClientRect(); const geo = cv()._barsGeo;
      const gx = geo.x0 || 0;
      const fx = gx + ((bar + 0.5) / geo.barsF) * geo.w;
      cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: r.left + fx, clientY: r.top + 8 }));
    };
    // 1. SILENT, and the whole drawing moves
    const orig = window.playNote; let played = 0;
    window.playNote = function () { played++; return orig.apply(this, arguments); };
    const b4 = JSON.stringify(barsOf());
    card().querySelector('.v2-newtake').click(); await wait(450);
    window.playNote = orig;
    const silent = (played === 0), whole = JSON.stringify(barsOf()) !== b4;
    // 2. a selected bar retakes ALONE — a NON-EMPTY one (an empty bar's
    // rhythm is deterministic across takes and can never move; the flake)
    const bAll = barsOf();
    const SB = +((['1', '2', '3'].find((k) => (bAll[k] || []).length)) || '1');
    tapBar(SB); await wait(250);
    const face = card().querySelector('.v2-newtake').textContent.trim();
    const b0 = barsOf();
    let moved = false, held = true;
    // MOVED 2026-09-12: 🎲 with bars tapped OPENS that bar's settings; the
    // throw is 🎲 Roll again inside. Same claim, driven through the door.
    const rollBar = async () => {
      if (!card().classList.contains('v2-baropen')) {
        card().querySelector('.v2-newtake').click(); await wait(300);
      }
      const rb2 = card().querySelector('.v2-barroll'); if (rb2) rb2.click();
    };
    for (let k2 = 0; k2 < 6 && !moved; k2++) {
      await rollBar(); await wait(300);
      const b1 = barsOf();
      ['0', '1', '2', '3'].filter((kk) => +kk !== SB).forEach((kk) => {
        if (JSON.stringify(b0[kk] || []) !== JSON.stringify(b1[kk] || [])) held = false; });
      if (JSON.stringify(b0[String(SB)] || []) !== JSON.stringify(b1[String(SB)] || []) && (b1[String(SB)] || []).length) moved = true;
    }
    const takeb = JSON.stringify(L().part.takeb || null);
    // shut the panel — its scrim covers the card, including 🔒 below
    const bc2 = card().querySelector('.v2-barclose'); if (bc2) bc2.click(); await wait(220);
    // 3. LOCK freezes the composite exactly as drawn, and consumes the map
    const drawn = (cv()._hits || []).map((h) => Math.round(h.midi)).sort().join(',');
    window.confirm = () => true;
    card().querySelector('.v2-capture').click(); await wait(350);
    const locked = { kind: L().part.kind, mapGone: !L().part.takeb,
      match: (L().part.notes || []).map((n) => n.midi).sort().join(',') === drawn };
    // cleanup: back to live, selection cleared by a real deselect next render
    L().part.kind = 'live'; delete L().part.takeb; E.getCfg();
    window._v2.render(E); await wait(200); card().classList.remove('collapsed');
    return { silent, whole, face, moved, held, takeb, locked, SB,
             wantKey: (SB * 48) + ':' + ((SB + 1) * 48) };
  });
  ok('🎲 New take REWRITES silently — no audition, and the drawing moves',
    ntRun.silent && ntRun.whole, JSON.stringify(ntRun).slice(0, 160));
  // RESTATED 2026-09-12 with the reason: the face ends in an ELLIPSIS (the
  // press opens the bar's settings), and the roll is the panel's own button.
  ok('a selected bar RETAKES alone on a live part, pinned in part.takeb',
    /Retake bar \d\u2026/.test(ntRun.face) && ntRun.moved && ntRun.held &&
    // RESTATED 2026-09-12: the pin is keyed by REGION (`"<a>:<b>"` on the
    // 1/48-bar grid) rather than by bar index, because a change need not fill
    // a bar. A whole bar is `[N·48, (N+1)·48)`, so a BAR tap must still pin
    // exactly one bar — asserted against the bar this run actually picked,
    // never a literal: the fixture chooses the first NON-EMPTY bar, so a
    // hardcoded "48:96" pins the roll rather than the behaviour and fails the
    // day the dice land elsewhere (it did).
    new RegExp('"' + ntRun.wantKey + '":\\d').test(ntRun.takeb),
    JSON.stringify(ntRun).slice(0, 220));
  ok('locking a bar-retaken part freezes the composite exactly as drawn',
    ntRun.locked.kind === 'recorded' && ntRun.locked.match && ntRun.locked.mapGone,
    JSON.stringify(ntRun.locked));

  // ---- PROVENANCE IS AN ACTIVE MODE ---------------------------------------
  // Five Material doors and nothing said which one produced the content you
  // are looking at — both stores existed (`part.made`, `part.mat`) and neither
  // showed. The door that made the content lights up, and the hint names the
  // provenance AND the rules shaping the material (rhythm × pitch × take).
  const provRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    const face = (b) => ((b && b.childNodes[0] && b.childNodes[0].nodeValue) || '').trim();
    const st2 = () => ({
      on: [...card().querySelectorAll('.v2-genshapes .ambient-seg.on')]
        .map((x) => face(x).slice(0, 14)).join('|'),
      // …and what the CARD says without the panel open — the door names the
      // shape in force, which is what consolidating four buttons must not cost
      door: (card().querySelector('.v2-genface') || {}).textContent || '',
      hint: card().querySelector('.v2-notecount').textContent });
    // the shapes live behind ⚙ Shape… now; the panel stays open across a
    // choice, so this opens it once
    // RESTATED 2026-09-16: the panel is STAGED — the card's door and hint
    // name the layer, so they follow a press once ✓ Done writes it
    const done = async () => { const d = card().querySelector('.v2-shapepop .v2-gendone'); if (d) d.click();
      await wait(260); card().classList.remove('collapsed'); };
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(280); card().classList.remove('collapsed');
    card().querySelector('.v2-shapepop .v2-rollrun').click(); await wait(350); card().classList.remove('collapsed');
    await done();
    const roll = st2();
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(280); card().classList.remove('collapsed');
    card().querySelector('.v2-shapepop .v2-mkpart[data-mk="sustain"]').click(); await wait(400); card().classList.remove('collapsed');
    await done();
    const sus = st2();
    window.confirm = () => true;
    card().querySelector('.v2-capture').click(); await wait(400); card().classList.remove('collapsed');
    const locked = st2();
    // back to a plain live state for whoever runs next
    L().part.kind = 'live'; delete L().part.mat; delete L().part.mem; E.getCfg();
    window._v2.render(E); await wait(200); card().classList.remove('collapsed');
    return { roll, sus, locked };
  });
  // RESTATED: it pinned the JARGON hint (`euclid 5 of 8 · walk · take 1`),
  // which was every term correct and no answer to "what will this generate" —
  // reported as the whole thing being opaque. Same contract (the hint NAMES
  // THE RULES, and the take), now asserted on the words a reader gets.
  ok('the Method door that made the content is LIT, and the hint names the rules',
    /Roll/.test(provRun.roll.on) && /Roll/.test(provRun.roll.door) &&
    /Sustain a chord/.test(provRun.sus.door) &&
    /hits spread evenly over \d+ steps/.test(provRun.roll.hint) &&
    // RESTATED (recovered after a splice reverted it to HEAD): the rules line
    // does NOT carry the take tail — a take is not a rule; the Every-cycle
    // toggle and the drawing's readout own that fact (the prose-cut change).
    !/Plays take|New take rolls|Re-rolled every cycle/.test(provRun.roll.hint) &&
    /Sustain a ch/.test(provRun.sus.on) && !/Roll/.test(provRun.sus.on) &&
    // RESTATED 2026-09-13: the count of notes-in-the-chord is said ONCE, by
    // the shape phrase, where the line used to read "one held chord of 5
    // notes — one onset, held, 5 notes of the chord" — the same fact three
    // times, which is most of what "noisy and overly complicated" meant.
    /one held chord of \d+ notes/.test(provRun.sus.hint) &&
    !/notes? of the chord/.test(provRun.sus.hint),
    JSON.stringify(provRun).slice(0, 700));
  ok('a locked take still says what it was a take OF',
    /Sustain a ch/.test(provRun.locked.on) &&
    // RESTATED with the vocabulary: one pair of words for the axis, so a
    // written-down take says WRITTEN (it was "LOCKED", which named the action
    // rather than the state and left "Fixed" naming the same state elsewhere).
    // The contract is unchanged — it still says it plays these notes — and
    // the RULES half is dropped, because `shapeOf` answers "the notes below"
    // on a written part, so the line read "…not the rules it was made from:
    // the notes below". What it was a take OF is the material NAME, leading.
    // RESTATED 2026-09-15: the line finishes the thought. "…not its rules" was
    // true and half an answer — a written take's rules are editable again (they
    // roll the next take), so a flat denial beside enabled Rhythm/Pattern/Feel
    // tabs reads as a contradiction. Same contract, both halves said.
    // RESTATED 2026-09-16 — the state's word is STATIC. The negative clause
    // follows it: it used to bar "WRITTEN DOWN" (the action wearing the state's
    // name), and now it bars WRITTEN outright, because the only place that word
    // survives on this card is the by-hand heading and a provenance line
    // reaching for it again would be the collision this rename undid.
    /STATIC/.test(provRun.locked.hint) && !/WRITTEN/.test(provRun.locked.hint) &&
    /plays these notes/.test(provRun.locked.hint) &&
    /rules roll the next take/.test(provRun.locked.hint),
    JSON.stringify(provRun).slice(0, 240));
  // NO STAMP IS NOT NO MATERIAL — a part made before provenance existed (or
  // assembled by hand on the knobs) still IS one of the materials, and the
  // rules' shape says which: series = an arpeggiator, one held chord = a
  // sustain, a walked line = the run. The reported case exactly: a locked
  // take, no `mat`, euclid + walk — and no door lit.
  const inferRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const face = (b) => ((b && b.childNodes[0] && b.childNodes[0].nodeValue) || '').trim();
    // the shapes are inside ⚙ Shape… now, so the lit one is read there; the
    // card's own answer is the door face, which is asserted too
    const st2 = () => ({ on: [...card().querySelectorAll('.v2-genshapes .ambient-seg.on')]
      .map((x) => face(x)).join('|'),
      door: (card().querySelector('.v2-genface') || {}).textContent || '',
      hint: card().querySelector('.v2-notecount').textContent });
    window._v2.rollRun(E, L()); window._v2.capture(E, L());
    delete L().part.mat; delete L().part.mem; E.getCfg();
    window._v2.render(E); await wait(250); card().classList.remove('collapsed');
    // NO STATUS GLYPH ON A MODE BUTTON — the fill is the active-mode signal,
    // and locked/live is said by the hint and the 🔒/🔓 button
    const markOf = () => { const c2 = card().querySelector('.v2-genshapes .ambient-seg.on');
      return c2 ? getComputedStyle(c2, '::before').content : ''; };
    const capOf = () => { const c3 = card().querySelector('.v2-capture');
      return c3 ? c3.textContent.trim() : ''; };
    const lockMark = markOf(), lockCap = capOf();
    const legacy = st2();
    L().part.kind = 'live'; delete L().part.mat;
    L().part.rhythm = { kind: 'pulse', n: 8, steps: 16 };
    L().part.pitch = { kind: 'series', dir: 'up', octaves: 2, degree: 1 };
    E.getCfg(); window._v2.render(E); await wait(250); card().classList.remove('collapsed');
    const liveMark = markOf(), liveCap = capOf();
    const hand = st2();
    // cleanup for the next case
    L().part.kind = 'live'; delete L().part.mat; delete L().part.mem; E.getCfg();
    return { legacy, hand, lockMark, liveMark, lockCap, liveCap };
  });
  // THE VARIANCE GAP — v1's Roam / Pitch vary / Rate var exist on a v2 part
  // now (pitch.roam, pitch.drift, rhythm.rateVar). Each must MOVE the notes,
  // replay deterministically (seeded, so a take reproduces), and spend NOTHING
  // at 0 (byte-identical output — the harness doctrine).
  const varRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), L = (cfg.layers || [])[0];
    const sv = JSON.stringify(L.part);
    const roll = () => window._v2.notesFor(L, { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: 4 })
      .map(n => Math.round(n.at * 1000) + ':' + Math.round(n.freq)).join(' ');
    L.part.kind = 'live'; L.part.pitch.kind = 'fixed'; L.part.pitch.degree = 1;
    L.part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 }; E.getCfg();
    const base = roll();
    const test = (mut, undo) => {
      mut(); E.getCfg();
      const a = roll(), b2 = roll();
      undo(); E.getCfg();
      return { moved: a !== base, det: a === b2, zero: roll() === base };
    };
    const roam = test(() => { L.part.pitch.roam = 80; }, () => { delete L.part.pitch.roam; });
    const drift = test(() => { L.part.pitch.drift = 100; }, () => { delete L.part.pitch.drift; });
    const rate = test(() => { L.part.rhythm.rateVar = 100; }, () => { delete L.part.rhythm.rateVar; });
    // rate var must hold the downbeat: first onset identical to base's
    L.part.rhythm.rateVar = 100; E.getCfg();
    const firstHeld = roll().split(' ')[0].split(':')[0] === base.split(' ')[0].split(':')[0];
    try { L.part = JSON.parse(sv); } catch (e) {}
    delete L.part.mat; delete L.part.mem; E.getCfg();
    return { roam, drift, rate, firstHeld };
  });
  ok('Roam, Pitch vary and Rate var each move the notes, replay, and cost nothing at 0',
    varRun.roam.moved && varRun.roam.det && varRun.roam.zero &&
    varRun.drift.moved && varRun.drift.det && varRun.drift.zero &&
    varRun.rate.moved && varRun.rate.det && varRun.rate.zero && varRun.firstHeld,
    JSON.stringify(varRun));
  // ⇄ SYNC TO PART — the Content sheet head's door: a 5-chord part against a
  // 4-bar layer, synced with Fill + Follow, lands bars 5 and harmony diatonic.
  const syncRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, cfg = E.getCfg(), L = () => window.__Lv2(E);
    const svProg = cfg.prog ? JSON.parse(JSON.stringify(cfg.prog)) : null;
    cfg.prog = { on: true, name: 'SY', chords: [0, 5, 7, 2, 9].map(rt => ({ root: rt, intervals: [0, 4, 7] })) };
    L().part.kind = 'live'; L().part.bars = 4; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    const gb = (window.__toContent(), null);
    if (gb) gb.click(); await wait(250);
    const btn = document.querySelector('.v2-pop-sync');
    const rect = btn ? btn.getBoundingClientRect() : { width: 0, height: 0 };
    if (btn) btn.click(); await wait(150);
    const modal = document.querySelector('.v2-sync-modal');
    const nowTxt = modal ? (modal.querySelector('.v2-sync-now') || {}).textContent : '';
    if (modal) {
      const f = [...modal.querySelectorAll('.v2-syncopt')];
      (f.find(x => x.dataset.v === 'fill') || {}).click && f.find(x => x.dataset.v === 'fill').click();
      (f.find(x => x.dataset.v === 'follow') || {}).click && f.find(x => x.dataset.v === 'follow').click();
      modal.querySelector('.v2-syncgo').click(); await wait(250);
    }
    const L2 = L();
    const res = { rect: rect.width > 40 && rect.height > 28, nowTxt,
      bars: L2.part.bars, harmony: L2.harmony || '',
      modalGone: !document.querySelector('.v2-sync-modal') };
    // cleanup — one page, one state
    delete L2.harmony; L2.part.kind = 'live'; L2.part.bars = 2;
    delete L2.part.mat; delete L2.part.mem;
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    E.getCfg(); window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return res;
  });
  // RESTATED: it pinned the literal 'diatonic', which was the only following
  // mode a Sync could produce while a capture always left `harmony` absent. A
  // capture made under a progression now defaults to 'chordlock', and the
  // modal's documented rule is that "follow" must NOT DOWNGRADE an explicit
  // chordlock — so on such a part the answer is correctly a no-op and the mode
  // stays chordlock. The contract is "it FOLLOWS the changes", which is what
  // this asserts; pinning one of the two modes was pinning the fixture.
  const FOLLOWS = (h) => h === 'diatonic' || h === 'chordlock';
  ok('⇄ Sync to Part: a real button in the Content head, and Fill + Follow lands bars 5 · following',
    syncRun.rect && /5 bars/.test(syncRun.nowTxt) && syncRun.bars === 5 &&
    FOLLOWS(syncRun.harmony) && syncRun.modalGone,
    JSON.stringify(syncRun).slice(0, 240));
  // PER-PART CONTENT — `L.part` is the record being edited, `L.partFor` names
  // which arrangement part it is for, `L.parts` files the others, and the
  // emitter swaps in the sounding part's record by TIME. The head pair
  // ([which part][⇄ Sync]) is the door and must read as ONE control.
  const ppRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, cfg = E.getCfg();
    const L = () => window.__Lv2(E);
    const svProg = cfg.prog ? JSON.parse(JSON.stringify(cfg.prog)) : null;
    const svPart = JSON.stringify(L().part);   // restore WHOLE, or the leaked
    // fixed/degree-1 pitch makes every later retake check unable to move
    cfg.prog = { on: true, name: 'PP', chords: [0, 7, 5, 9].map(rt => ({ root: rt, intervals: [0, 4, 7] })),
                 parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }] };
    L().part.kind = 'live'; E.getCfg();
    window._v2.render(E); await wait(250);
    // THE STRIP IS THE ONLY PART CHOOSER NOW, so this check needs it PAINTED —
    // `_v2.render` builds the cards and never touches it (it is v1 panel
    // chrome, drawn by `_ambSyncFxVis`). Without this every `pick()` below
    // clicks nothing and the round trip silently measures one record twice.
    try { _ambSyncFxVis(E); } catch (e) {}
    await wait(200);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    window.__toContent();
    await wait(250);
    const ppb = () => document.querySelector('.v2-pop-pp');
    const rp = ppb().getBoundingClientRect(),
          rb = document.querySelector('.v2-pop-sync').getBoundingClientRect();
    const o = { joined: Math.abs(rp.right - rb.left) < 2 && rp.width > 40,
      modeOff: ppb().textContent.trim(),
      // RESTATED 2026-09-10: the head was a joined TRIO — [mode][which
      // part][Sync] — and the middle chooser is GONE. The ⇶ Part strip above
      // the layers is the one place a part is made current, so the head asks
      // the MODE and states which part it landed on. `noSel` pins the removal:
      // "we took it away" is exactly the claim that regresses quietly.
      noSel: !document.querySelector('.v2-pop-part'),
      label: document.querySelector('.v2-pop-sync').textContent.trim() };
    // enable per-part with the TOGGLE, then pick with the STRIP — which is
    // now the only door, so this drives the real one rather than a copy
    ppb().click(); await wait(300);
    o.modeOn = ppb() && ppb().classList.contains('on');
    const pick = async (v) => {
      try { _ambSyncFxVis(E); } catch (e) {}          // the strip repaints on part edits
      await wait(120);
      // ONE DROPDOWN since 2026-09-18 — and it is a CHOICE only in ✎ Edit,
      // so the driver states the mode it needs rather than assuming it.
      const md0 = document.querySelector('#mix-bloom-curpart .ambient-curpart-mode');
      if (md0 && md0.value !== 'edit') { md0.value = 'edit'; md0.dispatchEvent(new Event('change', { bubbles: true })); await wait(250); }
      const c2 = document.querySelector('#mix-bloom-curpart .ambient-curpart-sel');
      if (!c2 || ![...c2.options].some((o2) => o2.value === String(v))) { o.pickMissing = (o.pickMissing || '') + v; return; }
      c2.value = String(v); c2.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
    };
    // the two records differ in NOTE COUNT (pulse ×2 vs ×7) — a fixed-pitch
    // difference is CONFOUNDED: the chords differ between the windows, so the
    // pitch sets differ with the swap poisoned too (the poison caught it).
    await pick('0'); L().part.bars = 3; L().part.rhythm = { kind: 'pulse', n: 2, steps: 16 };
    L().part.pitch.kind = 'fixed'; L().part.pitch.degree = 1; E.getCfg();
    await pick('1'); L().part.bars = 2; L().part.rhythm = { kind: 'pulse', n: 7, steps: 16 };
    L().part.pitch.kind = 'fixed'; L().part.pitch.degree = 3; E.getCfg();
    await pick('0');
    const Lb = L();
    // RESTATED: it pinned the hand-set BARS through the round trip, and a
    // per-part record's length is no longer its own — it is reconciled to the
    // part it is filed under on every normalize (a 1-bar cycle under a 5-bar
    // part, repeating five times, was the reported bug). What round-trips is
    // everything the record still OWNS; the length is asserted against the
    // PART instead, which is the stronger claim now.
    const partBars = (pi) => { try { return +_ambLenPartBars(E.getCfg(), pi); } catch (e) { return -1; } };
    o.roundTrip = Lb.partFor === 0 && (Lb.part.pitch.degree | 0) === 1 &&
      Lb.parts && Lb.parts['1'] && (Lb.parts['1'].pitch.degree | 0) === 3 &&
      (Lb.part.rhythm.n | 0) === 2 && (Lb.parts['1'].rhythm.n | 0) === 7;
    o.barsFollowPart = Math.abs(Lb.part.bars - partBars(0)) < 1e-6 &&
      Math.abs(Lb.parts['1'].bars - partBars(1)) < 1e-6;
    // the head STATES the part it is on (the selector that used to say so is
    // gone), and the strip's lit chip is the same answer
    o.readsAfter = ppb().textContent.trim();
    try { _ambSyncFxVis(E); } catch (e) {}
    await wait(150);
    const litC = document.querySelector('#mix-bloom-curpart .ambient-curpart-sel');
    o.stripLit = litC ? litC.value : null;
    // EMIT BY TIME — the Verse window plays the edited record (2 onsets), the
    // Chorus window the filed one (7). COUNTS, not pitches: the chords differ
    // between the windows, so pitch sets differ even with the swap broken.
    const barSec = (60 / (+document.getElementById('tempo-input').value || 120)) * 4;
    const nf = (at) => window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: at, cycleSec: 2 * barSec }).length;
    o.verse = nf(0.1); o.chorus = nf(2 * barSec + 0.1);
    o.emitDiffers = o.verse === 2 && o.chorus === 7;
    o.emitStable = nf(0.1) === o.verse;
    // BACK TO ONE-EVERYWHERE via the toggle — with the confirm answered yes
    const svC = window.confirm; window.confirm = () => true;
    ppb().click(); await wait(300); window.confirm = svC;
    o.cleared = !Number.isFinite(L().partFor) && !L().parts;
    // cleanup — one page, one state: the WHOLE part record back
    delete L().harmony;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem;
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    E.getCfg(); window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('the Content head is a joined PAIR — [mode · which part][⇄ Sync] — and asks WHICH part nowhere',
    ppRun.joined && /Everywhere/.test(ppRun.modeOff) && ppRun.noSel &&
    ppRun.modeOn && ppRun.label === '\u21c4 Sync' &&
    // RESTATED 2026-09-10: the head no longer CHOOSES a part, so what it pins
    // is that it still SAYS which one — the part is numbered, so the answer
    // survives the ellipsis at 390px — and that the strip agrees with it.
    /Per part/.test(ppRun.readsAfter) && /1 \u00b7 Verse/.test(ppRun.readsAfter) &&
    ppRun.stripLit === '0',
    JSON.stringify(ppRun).slice(0, 300));
  ok('choosing a part files the old record and restores its own — bars, pitch, everything',
    ppRun.roundTrip && ppRun.barsFollowPart, JSON.stringify(ppRun).slice(0, 240));
  ok('the EMITTER plays each arrangement part its own content, resolved by time (2 vs 7 onsets)',
    ppRun.emitDiffers && ppRun.emitStable,
    JSON.stringify({ verse: ppRun.verse, chorus: ppRun.chorus }));
  ok('the mode toggle (confirmed) returns to one-everywhere and drops the filed records',
    ppRun.cleared, JSON.stringify(ppRun).slice(0, 200));

  // ↻ LOOP — the ⇶ Part strip's own hold (2026-09-10). "Repeat the part I am
  // editing so I hear an edit next time round" is the same gesture as choosing
  // that part, so it sits with the parts rather than in a sheet. It names a
  // PART, not a moment, which is what lets it be armed while STOPPED — the
  // existing ↻ Hold pass can only hold whatever is sounding when pressed.
  // Measured at the AUDIO, not at the chord clock: `_ambPassLockSync` moves the
  // anchor on the HORIZON, so `_ambPartChordAt(audibleNow)` legitimately names
  // the pass before the one being heard for ~1.4 s per repetition (the strip's
  // green mark reads the LOCK for exactly that reason). Two records that
  // differ by an OCTAVE, so which one is sounding is unmistakable.
  const loopRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const sv = { prog: JSON.stringify(c0.prog || null), bpm: c0.bpm,
      part: JSON.stringify(L().part), pf: L().partFor,
      parts: L().parts ? JSON.stringify(L().parts) : null,
      all: L().partAll ? JSON.stringify(L().partAll) : null, cur: E._curPart };
    c0.prog = { on: true, parts: [{ name: 'Verse', len: 4 }, { name: 'Chorus', len: 4 }],
      chords: [0, 5, 7, 9, 0, 3, 5, 7].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    c0.bpm = 120;
    L().on = true; L().present = true;
    L().part.kind = 'recorded'; L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 62, dur: 0.2 }];
    L().partFor = 0; L().parts = {}; delete L().partAll;
    E.getCfg();
    L().parts['1'].notes = [{ t: 0, midi: 84, dur: 0.2 }, { t: 0.5, midi: 86, dur: 0.2 }];
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(250);
    _ambSyncFxVis(E); await wait(200);
    const o = {};
    const strip = document.getElementById('mix-bloom-curpart');
    const lb = () => strip.querySelector('.ambient-curpart-loop');
    o.present = !!lb();
    // …ARMED WHILE STOPPED, which is the whole reason it names a part
    (() => { const md1 = strip.querySelector('.ambient-curpart-mode');
      if (md1 && md1.value !== 'edit') { md1.value = 'edit'; md1.dispatchEvent(new Event('change', { bubbles: true })); } })();
    await wait(250);
    (() => { const s1 = strip.querySelector('.ambient-curpart-sel');
      s1.value = '1'; s1.dispatchEvent(new Event('change', { bubbles: true })); })();
    await wait(250);
    lb().click(); await wait(200);
    o.armedStopped = (E._partLoop | 0) === 1 && !E.timer && lb().classList.contains('on');
    // the notes each part plays, so the audio can be read without a clock
    window.__lp = [];
    const oP = window.playNote;
    window.playNote = function (f, p2, d, at) {
      try { if (window._ambEmitKey && /^v2:/.test(window._ambEmitKey))
        window.__lp.push(Math.round(69 + 12 * Math.log2(f / 440))); } catch (e) {}
      return oP.apply(this, arguments);
    };
    try { await Tone.start(); } catch (e) {}
    _ambStartGenerator(E);
    // …and read the repetition count WHILE PLAYING: a stop clears `_passLock`
    // (a held pass names "what is playing now"), so reading it after would
    // always be -1 — the state under test destroyed by the act of ending the
    // measurement.
    o.reps = -1;
    for (let k = 0; k < 60; k++) {
      await new Promise((r) => setTimeout(r, 500));   // an AUDIO settle — never scaled
      if (E._passLock) o.reps = Math.max(o.reps, E._passLock.reps | 0);
    }
    _ambStopGenerator(E);
    window.playNote = oP;
    const ser = window.__lp.map((m) => (m >= 70 ? 'C' : 'v')).join('');
    o.ser = ser;
    const first = ser.indexOf('C');
    // once the arrangement reaches the looped part it never leaves it
    o.holds = first >= 0 && ser.slice(first).indexOf('v') < 0 && ser.slice(first).length >= 4;
    o.survivedStop = (E._partLoop | 0) === 1;
    // release
    lb().click(); await wait(200);
    o.released = !Number.isFinite(E._partLoop) && !E._passLock && !lb().classList.contains('on');
    try {
      const c9 = E.getCfg();
      if (sv.prog === 'null') delete c9.prog; else c9.prog = JSON.parse(sv.prog);
      c9.bpm = sv.bpm;
      L().part = JSON.parse(sv.part);
      if (Number.isFinite(sv.pf)) L().partFor = sv.pf; else delete L().partFor;
      if (sv.parts) L().parts = JSON.parse(sv.parts); else delete L().parts;
      if (sv.all) L().partAll = JSON.parse(sv.all); else delete L().partAll;
      E._curPart = sv.cur; E._partLoop = null; E._passLock = null;
      E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
      E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
      _ambSyncFxVis(E); await wait(150);
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('\u21bb Loop repeats the current part \u2014 armable while stopped, and the AUDIO never leaves it',
    loopRun && !loopRun.err && loopRun.present && loopRun.armedStopped &&
    loopRun.holds && loopRun.reps >= 1 && loopRun.survivedStop && loopRun.released,
    JSON.stringify(loopRun));

  // ⌗ ROLL ⟷ ▦ STEPS — the material's FORM (2026-09-10). One layer's content is
  // authored and shown one of two ways, and they are different instruments
  // rather than two pictures of one thing: notes with their own time/pitch/
  // length, or a fixed grid of on/off cells. ORTHOGONAL to written/generated.
  // Absent = 'roll', so every project made before this is byte-identical — the
  // check starts by pinning exactly that.
  const formRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const card = () => document.querySelector('.v2-layer');
    const sv = { part: JSON.stringify(L().part), voice: L().instrument.voice };
    const o = {};
    const toContent = async () => {
      if (h) h._sig = ''; window._v2.render(E); await wait(300);
      card().classList.remove('collapsed');
      const g = (window.__toContent(), null);
      if (g) { g.click(); await wait(280); }
    };
    L().on = true; L().present = true; L().instrument.voice = 'synth';
    delete L().part.form; L().part.kind = 'recorded'; L().part.bars = 2; L().part.grid = 8;
    L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.3, midi: 64, dur: 0.2 },
                      { t: 0.7, midi: 67, dur: 0.2 }];
    E.getCfg();
    await toContent();
    // (1) ABSENT = ROLL, and the switch is reachable from the roll's own footer
    o.rollDefault = !L().part.form && !!card().querySelector('.v2-vizcv') &&
      !card().querySelector('.v2-partsteps') &&
      // ONE button now, carrying BOTH names with the current one LIT — restated
      // twice on 2026-09-15: first when the segmented pair became a cycle, then
      // again when that cycle showed only the DESTINATION and was reported as
      // "it says I'm in Steps mode when I'm clearly in Roll". THE LIT HALF IS
      // THE ASSERTION. A check for "Steps appears on the face" passed the buggy
      // version and the fixed one alike — it could not see the bug at all, which
      // is the whole reason this line is now about `.v2-formnow`.
      [...card().querySelectorAll('.v2-formbtn')].length === 1 &&
      card().querySelector('.v2-formbtn .v2-formnow').textContent.indexOf('Roll') >= 0 &&
      // 'Pattern', not 'Steps' — the form and the Pattern grid were one mode
      // under two names, and the grid's name is the one that survived.
      card().querySelector('.v2-formbtn .v2-formalt').textContent.indexOf('Pattern') >= 0;
    // (2) THE TWO FORMS ARE PARALLEL — switching PRESERVES both, so it asks
    // nothing and destroys nothing. RESTATED 2026-09-10: this pinned the
    // opposite (a confirm naming what would be discarded), and the contract
    // inverted — each form keeps its own material and the other one waits.
    // A confirm firing at all is now itself the failure.
    L().part.rhythm.kind = 'drawn';
    L().part.rhythm.cells = Array.from({ length: 32 }, (_, i) => (i % 4 === 0 ? 1 : 0));
    E.getCfg();
    let asked = null;
    const svC = window.confirm;
    window.confirm = (m) => { asked = m; return true; };
    card().querySelector('.v2-formbtn').click(); await wait(420);   // in ⌗ Roll → one press reaches ▦ Steps
    o.asked = String(asked || '');
    o.noConfirm = asked === null;
    o.switched = L().part.form === 'steps' && (L().part.notes || []).length === 3;
    // …AND THE FACE FOLLOWS. The lit half must now say Steps and the set-back
    // half Roll — the mirror of the assertion before the press, so a button
    // that lights the wrong side is caught in BOTH directions rather than only
    // in the one the fixture happens to start in.
    o.litFollows = card().querySelector('.v2-formbtn .v2-formnow').textContent.indexOf('Pattern') >= 0 &&
                   card().querySelector('.v2-formbtn .v2-formalt').textContent.indexOf('Roll') >= 0;
    o.keptNotes = (L().part.notes || []).map((n) => n.midi).join(',') === '60,64,67';
    o.keptKind = L().part.kind === 'recorded';       // the roll's own kind survives
    // …and the EMIT follows the FORM, not `kind`: in ▦ Steps the grid is the
    // material whatever the roll happens to hold.
    const emitN = (n2) => window._v2.notesFor(L(), { E, cfg: E.getCfg(),
      key: 'v2:' + L().id, cycleStart: 0, cycleSec: 4 }).length;
    o.stepsEmits = emitN() > 3;
    // (3) THE SURFACE SWAPS — and ✦ Method's `form:roll` rows (Drawn steps, the
    // kit lanes) are gated OFF, or the card would carry two live editors over
    // one store. The euclid PREVIEW that used to sit there is gone outright
    // (2026-09-15); what is pinned here is that nothing it left behind shows.
    o.surfaceSwapped = !card().querySelector('.v2-vizcv') && !!card().querySelector('.v2-partsteps');
    o.noDuplicateGrid = [...card().querySelectorAll('.v2-cellrow')]
      .every((r) => getComputedStyle(r).display === 'none');
    // (4) ONE GRID STANDARD, PER BAR: the cell count IS bars × grid, and the
    // readout says the same thing the store does. Before this the sequencer
    // contradicted itself ("5 of 16 · 2 bars · 1/16" — 2 bars at 1/16 is 32).
    const cells = () => card().querySelectorAll('.v2-partsteps .v2-cell').length;
    o.gridIsStandard = cells() === 16 && (L().part.rhythm.steps | 0) === 16;   // 2 bars x 1/8
    const gp = card().querySelector('.v2-partsteps .v2-gridpick');
    gp.value = '16'; gp.dispatchEvent(new Event('input', { bubbles: true })); await wait(420);
    o.gridRefits = cells() === 32 && (L().part.rhythm.steps | 0) === 32;       // 2 bars x 1/16
    o.lab = (card().querySelector('.v2-stepslab') || {}).textContent || '';
    o.labAgrees = /of 32/.test(o.lab) && /2 bars/.test(o.lab) && /1\/16/.test(o.lab);
    // (5) A TAP AUTHORS — the generated pattern is snapshotted and becomes yours
    const c3 = card().querySelectorAll('.v2-partsteps .v2-cell')[2];
    const was = c3.classList.contains('on');
    c3.click(); await wait(320);
    o.tapAuthors = L().part.rhythm.kind === 'drawn' &&
      !!(L().part.rhythm.cells || [])[2] !== was;
    // (6) THE EMITTER PLAYS THE CELLS, on the grid. 2 bars at 120bpm = 4s, so a
    // 32-cell grid steps every 0.125s — onsets must land on it exactly.
    L().part.rhythm.cells = Array.from({ length: 32 }, (_, i) => (i % 8 === 0 ? 1 : 0));
    E.getCfg();
    const ns = window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
      cycleStart: 0, cycleSec: 4 });
    o.onsets = ns.length;
    o.onGrid = ns.length === 4 && ns.every((n) => Math.abs(n.at / 0.125 - Math.round(n.at / 0.125)) < 1e-6) &&
      ns.map((n) => +n.at.toFixed(3)).join(',') === '0,1,2,3';
    // (6b) A STEP WEARS ITS PART. The roll's note events carry their part's hue
    // and a step IS this form's note event. Read the COMPUTED colour, not the
    // variable: `.ambient-euclid-cell.on` (0,2,0) sets background AND border
    // and sits earlier in the file, so the rule has to be compounded past it
    // (the documented cascade trap). And the NOTE ROW's labels are <button>s
    // with no background declared, so they took the UA's near-white — measured
    // 2.44:1 against the part hue, on the one row whose job is to be read.
    // Set `partFor` DIRECTLY rather than through `V2.partSelect`: that files
    // records and mints `parts`/`partAll`, and leaving them behind broke FOUR
    // downstream per-part checks (the one-page-one-state trap — a probe must
    // restore everything its fixture writes, not the fields it happens to
    // read). Everything read here needs only the attribute.
    const svPP = { pf: L().partFor,
      parts: L().parts ? JSON.stringify(L().parts) : null,
      all: L().partAll ? JSON.stringify(L().partAll) : null,
      pk: L().part.pitch.kind };
    L().part.pitch.kind = 'drawn';          // …so there IS a note row to read
    const cellCol = () => { const c2 = card().querySelector('.v2-partsteps .ambient-euclid-cell.on');
      return c2 ? getComputedStyle(c2).backgroundColor : null; };
    const lblCon = () => {
      const n2 = card().querySelector('.v2-partsteps .ambient-euclid-notelbl.set');
      if (!n2) return 0;
      const px = (v) => { const m = /rgba?\(([^)]+)\)/.exec(v);
        return m ? m[1].split(',').slice(0, 3).map(Number) : [0, 0, 0]; };
      const lum = (rgb) => { const f = rgb.map((v) => { v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
      // against the grid's own dark ground — the label is transparent now
      const a = lum(px(getComputedStyle(n2).color)), b2 = lum([13, 13, 24]);
      return (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
    };
    L().partFor = 0; E.getCfg(); await toContent();
    o.hue0 = cellCol(); o.con0 = +lblCon().toFixed(2);
    L().partFor = 1; E.getCfg(); await toContent();
    o.hue1 = cellCol(); o.con1 = +lblCon().toFixed(2);
    // the hue INVERTS with the part — a hardcoded fill passes a one-part check
    o.hueFollows = !!o.hue0 && !!o.hue1 && o.hue0 !== o.hue1;
    o.lblReadable = o.con0 >= 4.5 && o.con1 >= 4.5;
    // …and a layer with NO part identity keeps the grid's own default
    delete L().partFor; E.getCfg(); await toContent();
    o.hueNone = cellCol();
    o.sharedKeepsDefault = !!o.hueNone && o.hueNone !== o.hue0 && o.hueNone !== o.hue1;
    L().part.pitch.kind = svPP.pk;
    if (Number.isFinite(svPP.pf)) L().partFor = svPP.pf; else delete L().partFor;
    if (svPP.parts) L().parts = JSON.parse(svPP.parts); else delete L().parts;
    if (svPP.all) L().partAll = JSON.parse(svPP.all); else delete L().partAll;
    E.getCfg();
    // (7) A KIT SHOWS LANES, not the single row — the voice decides, as it
    // already does in the Pattern tab.
    L().instrument.voice = 'kit'; E.getCfg(); await toContent();
    o.kitLanes = card().querySelectorAll('.v2-partsteps .ambient-euclid-kitrow').length === 8 &&
      card().querySelectorAll('.v2-partsteps .v2-cell').length === 0;
    // (8) …AND BACK, WITH BOTH HALVES INTACT. The roll returns to its own note
    // list and the steps pattern is still there to come back to.
    L().instrument.voice = 'synth'; E.getCfg(); await toContent();
    const cellsWas = (L().part.rhythm.cells || []).join('');
    card().querySelector('.v2-formbtn').click(); await wait(420);   // in ▦ Steps → one press comes back to ⌗ Roll
    o.backToRoll = !L().part.form && !!card().querySelector('.v2-vizcv') &&
      (L().part.notes || []).map((n) => n.midi).join(',') === '60,64,67' &&
      (L().part.rhythm.cells || []).join('') === cellsWas;
    o.rollEmits = emitN() === 3;                     // the note list, not the grid
    // …AND THE ROLL'S OWN Steps KNOB CANNOT TRUNCATE THE OTHER FORM'S PATTERN.
    // `cells` is one array serving two length authorities; sized to `r.steps`
    // alone, a trip through ⌗ Roll with Steps turned down came back with a
    // 32-cell grid of 8 hits reduced to 2 (measured).
    L().part.rhythm.steps = 8; E.getCfg();
    L().part.form = 'steps'; E.getCfg();
    o.knobCannotTruncate = (L().part.rhythm.cells || []).join('') === cellsWas;
    delete L().part.form; E.getCfg();
    window.confirm = svC;
    try {
      L().part = JSON.parse(sv.part); L().instrument.voice = sv.voice;
      E.getCfg(); await toContent();
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('the material has a FORM \u2014 \u2317 Roll or \u25a6 Steps \u2014 and only one surface is ever live',
    formRun && !formRun.err && formRun.rollDefault && formRun.switched && formRun.litFollows &&
    formRun.surfaceSwapped && formRun.noDuplicateGrid && formRun.kitLanes && formRun.backToRoll,
    JSON.stringify(formRun).slice(0, 300));
  ok('the two forms are PARALLEL \u2014 each keeps its own material across a round trip, and nothing asks',
    formRun && !formRun.err && formRun.noConfirm && formRun.keptNotes && formRun.keptKind &&
    formRun.backToRoll && formRun.knobCannotTruncate,
    JSON.stringify(formRun && { asked: formRun.asked, notes: formRun.keptNotes,
      kind: formRun.keptKind, back: formRun.backToRoll, knob: formRun.knobCannotTruncate }));
  ok('\u2026and the EMIT follows the FORM, not `kind` \u2014 \u25a6 Steps plays the grid over a recorded roll',
    formRun && !formRun.err && formRun.stepsEmits && formRun.rollEmits,
    JSON.stringify(formRun && { steps: formRun.stepsEmits, roll: formRun.rollEmits }));
  ok('ONE grid standard, per BAR \u2014 cells are bars \u00d7 grid, and the readout agrees with the store',
    formRun && !formRun.err && formRun.gridIsStandard && formRun.gridRefits && formRun.labAgrees,
    JSON.stringify(formRun && { lab: formRun.lab, std: formRun.gridIsStandard, refit: formRun.gridRefits }));
  ok('a step tap authors the pattern, and the EMITTER plays the cells on the grid',
    formRun && !formRun.err && formRun.tapAuthors && formRun.onGrid,
    JSON.stringify(formRun && { tap: formRun.tapAuthors, onsets: formRun.onsets, onGrid: formRun.onGrid }));

  // ▦ STEPS PLAYS THE GRID FROM THE MOMENT YOU ARRIVE (2026-09-13, user: "Steps
  // doesn't seem to be wired up to playback… it sounds like the Roll part is
  // playing"). The existing check above taps a cell first, which stamps
  // `kind = 'drawn'` — so it covered the EDITED case and the reported one, an
  // untouched grid, went straight past it: `onsetsOf` asked `kind`, the form
  // said nothing, and the layer played the roll's euclid pattern while the grid
  // drew something else. Three claims: the switch is INAUDIBLE (the grid is
  // seeded from the rules), the PICTURE equals the EAR, and the ROLL is left
  // exactly as it was.
  const stepPlay = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    const onsets = () => { const st = L().part.rhythm.steps;
      return [...new Set(window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
        cycleStart: 0, cycleSec: 4 }).map((n) => Math.round(n.at / 4 * st)))].sort((a, b) => a - b).join(','); };
    const lit = () => [...card().querySelectorAll('.v2-cell')]
      .filter((x) => x.getBoundingClientRect().width > 0 && x.classList.contains('on'))
      .map((x) => +x.getAttribute('data-ci')).sort((a, b) => a - b).join(',');
    const o = {};
    // start from a plain euclid ROLL
    L().part.form && delete L().part.form; L().part.rhythm.kind = 'euclid';
    delete L().part.rhythm.cells;
    // …over 1.5 bars, so the grid WRAPS (24 cells = 16 + 8). At one block the
    // broken and the fixed sizing are identical and the poison passes.
    L().part.bars = 1.5; E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(260); card().classList.remove('collapsed');
    o.rollOnsets = onsets();
    // …press ▦ Steps through the real control
    const sb = card().querySelector('.v2-formbtn');   // in ⌗ Roll → the cycle's one stop is ▦ Steps
    if (sb) sb.click(); await wait(500); card().classList.remove('collapsed');
    o.inSteps = window._v2.formOf(L()) === 'steps';
    o.seeded = onsets() === o.rollOnsets;          // the switch changed nothing you can hear
    o.drawMatches = lit() === onsets();            // the picture IS what plays
    o.rollUntouched = L().part.rhythm.kind === 'euclid';
    // …and a tap moves BOTH, still without reaching across to the roll
    const off = [...card().querySelectorAll('.v2-cell')]
      .filter((x) => x.getBoundingClientRect().width > 0 && !x.classList.contains('on'))[0];
    const oi = off ? +off.getAttribute('data-ci') : -1;
    if (off) off.click(); await wait(350);
    o.tapAdds = oi >= 0 && onsets().split(',').indexOf(String(oi)) >= 0;
    o.tapDrawMatches = lit() === onsets();
    o.tapRollUntouched = L().part.rhythm.kind === 'euclid';
    // EVERY CHIP THE SAME SIZE — a short last row used to stretch its cells
    // ("step chips should all be same size"), because each block sized its grid
    // to its own count instead of to the full row.
    const w = [...card().querySelectorAll('.v2-cell')]
      .filter((x) => x.getBoundingClientRect().width > 0)
      .map((x) => Math.round(x.getBoundingClientRect().width));
    o.widths = [...new Set(w)].join(',');
    o.blocks = card().querySelectorAll('.v2-cells').length;
    o.sameSize = w.length > 16 && o.blocks > 1 && new Set(w).size === 1;
    try { L().part = JSON.parse(sv); } catch (e) {}
    E.getCfg(); if (h) h._sig = ''; window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('\u25a6 Steps plays the GRID from the moment you arrive — seeded from the rules, and the roll is untouched',
    stepPlay.inSteps && stepPlay.seeded && stepPlay.drawMatches && stepPlay.rollUntouched &&
    stepPlay.tapAdds && stepPlay.tapDrawMatches && stepPlay.tapRollUntouched,
    JSON.stringify(stepPlay));
  ok('\u2026and every step chip is the same size, whatever the last row holds',
    stepPlay.sameSize, 'widths=' + stepPlay.widths + ' blocks=' + stepPlay.blocks);

  // …AND A STEP LIGHTS AS IT SOUNDS. The roll sweeps a line across its canvas;
  // ▦ Steps has no canvas, so the viz rAF returned at its `!cv || !ph` guard and
  // nothing followed playback at all ("no playhead follows play across the
  // sequence"). Measured as a WALK — several distinct steps in order — because
  // one lit cell could be a class that never moves; and it must CLEAR on stop,
  // or the last frame goes on claiming a step is sounding.
  const stepPh = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part), svOn = L().on, svPr = L().present;
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    L().part.form = 'steps'; L().part.bars = 1.5; L().on = true; L().present = true; E.getCfg();
    const r = L().part.rhythm;
    r.cells = new Array(r.steps).fill(0); [0, 8, 16].forEach((i) => { r.cells[i] = 1; });
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(300); card().classList.remove('collapsed');
    _ambStartGenerator(E);
    const seen = new Set(); let lit = 0;
    for (let i = 0; i < 22; i++) {
      await wait(110);
      const a2 = [...card().querySelectorAll('.v2-cell.playing')].map((x) => x.getAttribute('data-ci'));
      if (a2.length) { lit++; seen.add(a2.join(',')); }
    }
    _ambStopGenerator(E);
    await wait(400);
    const after = card().querySelectorAll('.v2-cell.playing').length;
    // a probe that plays must put the clocks back, or the next check inherits them
    E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
    try { L().part = JSON.parse(sv); } catch (e) {}
    L().on = svOn; L().present = svPr; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(220);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return { walked: seen.size, litFrames: lit, after };
  });
  ok('\u2026and a step LIGHTS as it sounds, walking the grid, and clears on stop',
    stepPh.walked >= 4 && stepPh.litFrames >= 10 && stepPh.after === 0,
    JSON.stringify(stepPh));

  // A STEP CAN SAY WHAT IT PLAYS (2026-09-13, user: "user needs to be able to
  // define what plays at each step (note, chord, etc)"). It could not: the note
  // row showed only under `pitch.kind === 'drawn'` — one rule in nine — and its
  // only control was a TAP-TO-CYCLE through 24 degrees, which is the documented
  // mistake (unreadable, unreversible, and one axis where the question has two).
  // `pitch.stepFx[i] = {deg, voices}` is a per-step say applied at the ONE place
  // every pitch kind funnels through, so it works over any rule; absent = the
  // rule decides, and a say that says nothing is PRUNED back to absent.
  const stepFx = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const midi = () => window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
      cycleStart: 0, cycleSec: 4 }).map((n) => Math.round(12 * Math.log2(n.freq / 440) + 69)).join(',');
    card().classList.remove('collapsed');
    // a KEY, so "thirds of the source" is a scale rather than bare semitones
    E.getCfg().keyOn = true; E.getCfg().keyFollow = false;
    E.getCfg().keyRoot = 0; E.getCfg().keyScale = 'major';
    const svKey = { on: E.getCfg().keyOn, follow: E.getCfg().keyFollow,
                    root: E.getCfg().keyRoot, scale: E.getCfg().keyScale };
    L().part.form = 'steps'; L().part.rhythm.kind = 'pulse'; L().part.rhythm.n = 3;
    L().part.pitch.kind = 'fixed'; E.getCfg();
    // in ▦ Steps the CELLS are the rhythm, so the grid has to have something on
    // it — an empty grid is silence, and silence has no step to edit
    { const r2 = L().part.rhythm; r2.cells = new Array(r2.steps).fill(0);
      [0, 8, 16].forEach((i) => { r2.cells[i] = 1; }); E.getCfg(); }
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(320); card().classList.remove('collapsed');
    const o = {};
    o.plain = midi();
    // THE ROW IS THERE whatever the pitch rule is — it was 'drawn'-only
    o.notesShown = [...card().querySelectorAll('.v2-note')].filter((x) => x.getBoundingClientRect().width > 0).length;
    // …and tapping one opens an EDITOR rather than cycling a number
    const nb = [...card().querySelectorAll('.v2-note')]
      .filter((x) => x.getBoundingClientRect().width > 0 && !x.disabled)[0];
    o.notesLive = [...card().querySelectorAll('.v2-note')]
      .filter((x) => x.getBoundingClientRect().width > 0 && !x.disabled).length;
    if (nb) nb.click(); await wait(300);
    const pop = card().querySelector('.v2-steppop');
    o.opened = !!pop;
    o.saysRule = !!pop && /pitch rule/.test(pop.querySelector('.v2-stepsays').textContent || '');
    o.faceNamesIt = !!pop && (pop.querySelector('.v2-sfdeg') || {}).value === 'the rule';
    // a DEGREE — three presses of + on Note
    // GUARDED — a probe that throws takes the whole run with it and tells you
    // less than one red line (documented).
    const up = (cls) => { const el2 = card().querySelector('.' + cls);
      const st2 = el2 && el2.closest('.ambient-stepper');
      const b2 = st2 && st2.querySelector('.ambient-step-up'); if (b2) b2.click(); };
    for (let i = 0; i < 3; i++) { up('v2-sfdeg'); await wait(150); }
    o.deg = midi();
    o.stored = JSON.stringify(L().part.pitch.stepFx || null);
    // …and a CHORD on it — two presses of + on Tones
    for (let i = 0; i < 2; i++) { up('v2-sfvox'); await wait(150); }
    o.chord = midi();
    o.storedChord = JSON.stringify(L().part.pitch.stepFx || null);
    // ↺ Follow the rule takes the say away, and the store goes back to absent
    const fb = card().querySelector('.v2-stepfollow'); if (fb) fb.click(); await wait(450);
    card().classList.remove('collapsed');
    o.back = midi();
    o.pruned = L().part.pitch.stepFx === undefined;
    try { L().part = JSON.parse(sv); } catch (e) {}
    E.getCfg().keyOn = svKey.on; E.getCfg().keyFollow = svKey.follow;
    E.getCfg().keyRoot = svKey.root; E.getCfg().keyScale = svKey.scale; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(220);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  // ASSERTED AS RELATIONSHIPS, not absolute MIDI — the register decides the
  // digits, so pinning them pins the fixture (the documented lesson).
  ok('a STEP can say what it plays — a note, or a chord on it — over any pitch rule',
    stepFx.notesShown > 0 && stepFx.notesLive > 0 && stepFx.opened &&
    stepFx.saysRule && stepFx.faceNamesIt &&
    (() => {
      const p0 = stepFx.plain.split(',').map(Number);
      const d0 = stepFx.deg.split(',').map(Number);
      const c0 = stepFx.chord.split(',').map(Number);
      // ONLY the step that was told moved, and it moved UP the scale
      const movedOne = d0.length === p0.length && d0[0] > p0[0] &&
        d0.slice(1).join(',') === p0.slice(1).join(',');
      // …and asking for tones stacks a CHORD on that same note, in thirds of
      // the scale (3 or 4 semitones a step — never a cluster)
      const stacked = c0.length === p0.length + 2 && c0[0] === d0[0];
      const iv = [c0[1] - c0[0], c0[2] - c0[1]];
      const thirds = iv.every((x) => x === 3 || x === 4);
      return movedOne && stacked && thirds;
    })() &&
    /"deg":3/.test(stepFx.stored) && /"voices":3/.test(stepFx.storedChord) &&
    stepFx.back === stepFx.plain && stepFx.pruned,
    JSON.stringify(stepFx));

  // LIVE vs SAME EVERY PASS (2026-09-10, user: "Generated is just a special
  // case of the Written case… introduce the unifying concept of Static
  // Content… once PLAYED it can become Live at the user's discretion").
  // THE WORD MOVED ON 2026-09-16: this axis gave up "Static" to the STATE
  // (what makes the notes: GENERATED or STATIC) and says SAME EVERY PASS, so
  // one word has one job. Renaming one pole without moving the other would
  // only have relocated the collision — the readout is the surface that had
  // both axes on it at once.
  // Liveness is a PROPERTY of the settings, not a stored mode — so the check
  // that matters is that the predicate AGREES WITH REALITY: for every setting,
  // compare what the card claims against six consecutive cycles of the actual
  // note stream. A predicate that merely lists fields would drift from the
  // engine the first time a seed moved.
  const liveRun = await page.evaluate(async () => { try {
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = { part: JSON.stringify(L().part), rest: L().restProb,
      gh: L().ghosts, lv: L().lenVary, hu: L().humanize, vv: L().velVar };
    L().on = true; L().present = true; L().part.bars = 2;
    // a fixture that CAN vary — a default pulse x chord part has no seeded draw
    // at all, so every row below would measure "identical" whatever the code
    // did (the asserting-on-something-that-works-regardless trap)
    L().part.rhythm = { kind: 'euclid', steps: 16, pulses: 7, rotate: 0 };
    L().part.pitch = { kind: 'walk', degree: 1, span: 5 };
    delete L().part.vary; delete L().restProb; delete L().ghosts;
    delete L().lenVary; delete L().humanize; delete L().velVar;
    E.getCfg();
    // DISTINCT note sets over six cycles: 1 = static by measurement
    const cycles = () => { const out = [];
      for (let c = 0; c < 6; c++) {
        const ns = window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
          cycleStart: c * 4, cycleSec: 4 });
        out.push(ns.map((n) => Math.round((n.at - c * 4) * 100) + ':' +
          Math.round(69 + 12 * Math.log2(n.freq / 440))).join(','));
      }
      return new Set(out).size; };
    const says = () => { const lv = window._v2.liveness(L(), E.getCfg()); return !!lv.live; };
    const o = { rows: [] };
    const probe = (name, mut, undo, contentLevel) => {
      mut(L()); E.getCfg();
      const n = cycles(), claim = says();
      o.rows.push({ name, cycles: n, live: claim });
      undo(L()); E.getCfg();
      // the predicate must MATCH the measurement for the content tier; the
      // performance tier (Humanize, Vel var) is applied downstream of the note
      // list, so `notesFor` cannot see it and only the claim is checked
      return contentLevel ? (claim === (n > 1)) : claim;
    };
    o.ok = [
      probe('default', () => {}, () => {}, true) === true,
      probe('Rests 40', (x) => { x.restProb = 40; }, (x) => { delete x.restProb; }, true),
      probe('Ghosts 40', (x) => { x.ghosts = 40; }, (x) => { delete x.ghosts; }, true),
      probe('Len vary 50', (x) => { x.lenVary = 50; }, (x) => { delete x.lenVary; }, true),
      probe('rhythm Vary 60', (x) => { x.part.rhythm.vary = 60; }, (x) => { delete x.part.rhythm.vary; }, true),
      probe('part.vary', (x) => { x.part.vary = 1; }, (x) => { delete x.part.vary; }, true),
      probe('Humanize 40', (x) => { x.humanize = 40; }, (x) => { delete x.humanize; }, false),
      probe('Vel var 40', (x) => { x.velVar = 40; }, (x) => { delete x.velVar; }, false),
    ].every(Boolean);
    // …and the WORDS. The first token of the content readout answers "does this
    // change on iterations", and names WHY rather than hiding it in a title.
    const card2 = document.querySelector('.v2-layer');
    const labTxt = async () => { window._v2.render(E); await new Promise((r) => setTimeout(r, 200));
      document.querySelector('.v2-layer').classList.remove('collapsed');
      const g2 = (window.__toContent(), null);
      if (g2) { g2.click(); await new Promise((r) => setTimeout(r, 200)); }
      return ((document.querySelector('.v2-vizlab') || {}).textContent || '').split(' \u00b7 ')[0]; };
    o.saysSame = await labTxt();
    L().part.vary = 1; E.getCfg();
    o.saysLive = await labTxt();
    delete L().part.vary; E.getCfg();
    try {
      L().part = JSON.parse(sv.part);
      L().restProb = sv.rest; L().ghosts = sv.gh; L().lenVary = sv.lv;
      L().humanize = sv.hu; L().velVar = sv.vv;
      E.getCfg(); window._v2.render(E);
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  // ── AND THE CHANGES THEMSELVES CAN BE LIVE ──────────────────────────────
  // Salt was the only area-level source the predicate knew, and it is one of
  // several: the harmony moving pass to pass means a layer FOLLOWING it plays
  // different notes, which is the same fact wearing another hat. Measured
  // against the floor a STATIC figure sets by simply moving through the
  // changes — that floor is why this needs its own probe: a "distinct note
  // sets > 1" test scores an unvarying figure over four chords as live.
  const liveProgRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = { rows: [] };
    const L = () => window.__Lv2(E);
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const keep = JSON.parse(JSON.stringify({ part: L().part, harmony: L().harmony || null }));
    const clk = [E._progAnchor, E._playStartAt, E._barGridAnchor];
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
      { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }];
    delete cfg.prog.parts; E.getCfg();
    L().part.kind = 'live'; L().part.bars = 1;
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 4 };
    L().part.pitch = { kind: 'walk', span: 3 };
    delete L().part.vary; delete L().harmony;
    E.getCfg();
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = window._v2.cycleSec(L(), E.getCfg());
    // SIX FULL TRIPS of the 4-chord cycle — one trip cannot tell a per-pass
    // die from the chords simply coming round.
    const sets = () => { const out = new Set();
      for (let c = 0; c < 24; c++) {
        const ns = window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
          cycleStart: c * cyc, cycleSec: cyc }) || [];
        out.add(ns.map((n) => Math.round(n.freq) + '@' + Math.round((n.at - c * cyc) * 1000)).join(','));
      }
      return out.size; };
    const floor = sets();
    const probe = (name, set, unset, wantLive) => {
      set(); E.getCfg();
      const d = sets(), live = window._v2.liveness(L(), E.getCfg()).live;
      unset(); E.getCfg();
      const agrees = (d > floor) === live && live === wantLive;
      o.rows.push(name + ' ' + d + (agrees ? '' : ' MISMATCH(card ' + (live ? 'live' : 'static') + ')'));
      return agrees;
    };
    o.floor = floor;
    o.ok = [
      probe('alts-random', () => { cfg.prog.chords[1].alts = [{ root: 2, intervals: [0, 3, 7] }];
        cfg.prog.chords[1].altMode = 'random'; },
        () => { delete cfg.prog.chords[1].alts; delete cfg.prog.chords[1].altMode; }, true),
      probe('alts-cycle', () => { cfg.prog.chords[1].alts = [{ root: 2, intervals: [0, 3, 7] }];
        cfg.prog.chords[1].altMode = 'cycle'; },
        () => { delete cfg.prog.chords[1].alts; delete cfg.prog.chords[1].altMode; }, true),
      probe('prog.vary', () => { cfg.prog.vary = 70; }, () => { delete cfg.prog.vary; }, true),
      probe('salt', () => { cfg.prog.salt = { colors: 80, scatter: 0 }; },
        () => { delete cfg.prog.salt; }, true),
      // …and these land exactly ON the floor, because each is seeded once per
      // TAKE or per SLOT rather than per pass. Saying so is half the model.
      probe('tension', () => { cfg.prog.tension = 70; }, () => { delete cfg.prog.tension; }, false),
      probe('take-reroll', () => { cfg.prog.reroll = 100; }, () => { delete cfg.prog.reroll; }, false),
      probe('order-grid', () => { cfg.prog.order = { cols: 2, seq: { 1: [3, 2, 1, 0] } }; },
        () => { delete cfg.prog.order; }, false),
      // A WRITTEN part with fixed pitches does NOT follow the changes, so the
      // harmony moving under it changes nothing it plays — 1 set, not 13.
      probe('written-fixed under salt', () => { cfg.prog.salt = { colors: 80, scatter: 0 };
        L().part.kind = 'recorded';
        L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 64, dur: 0.2 }];
        delete L().harmony; },
        () => { delete cfg.prog.salt; L().part.kind = 'live'; L().part.notes = []; }, false),
      probe('written-chordlock under salt', () => { cfg.prog.salt = { colors: 80, scatter: 0 };
        L().part.kind = 'recorded';
        L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 64, dur: 0.2 }];
        L().harmony = 'chordlock'; },
        () => { delete cfg.prog.salt; L().part.kind = 'live'; L().part.notes = []; delete L().harmony; }, true),
    ].every(Boolean);
    L().part = JSON.parse(JSON.stringify(keep.part));
    if (keep.harmony) L().harmony = keep.harmony; else delete L().harmony;
    cfg.prog = P0; E.getCfg();
    E._progAnchor = clk[0]; E._playStartAt = clk[1]; E._barGridAnchor = clk[2];
    const host = document.getElementById('bloom-v2-layers'); if (host) host._sig = '';
    window._v2.render(E);
    return o;
  });
  ok('…and the CHANGES can be live too — measured against the floor an unvarying figure sets',
    liveProgRun && liveProgRun.ok && liveProgRun.floor > 1,
    JSON.stringify(liveProgRun));

  ok('LIVE vs FIXED is a property of the settings, and the card AGREES WITH THE NOTES',
    liveRun && !liveRun.err && liveRun.ok,
    JSON.stringify(liveRun && liveRun.rows));
  // RESTATED 2026-09-16: the quiet pole is 'Same every pass', not 'Static'.
  // The word it gave up now names the STATE (GENERATED ⟷ STATIC), and this
  // readout is exactly where the two axes are read in one glance — so it is the
  // surface that could not keep sharing a word. BOTH poles asserted, or a
  // readout stuck on one of them passes.
  ok('\u2026and it SAYS which \u2014 leading the readout, naming what makes it live',
    // RESTATED 2026-09-16 (later): the poles are the badge words LIVE ⟷ FIXED,
    // with the reasons as one word each in brackets.
    liveRun && !liveRun.err && liveRun.saysSame === 'FIXED' &&
    /^LIVE \(/.test(liveRun.saysLive || '') && /dice/.test(liveRun.saysLive || ''),
    JSON.stringify(liveRun && { same: liveRun.saysSame, live: liveRun.saysLive }));

  ok('a STEP wears its part \u2014 the hue inverts with the part, and the note row stays readable on it',
    formRun && !formRun.err && formRun.hueFollows && formRun.lblReadable &&
    formRun.sharedKeepsDefault,
    JSON.stringify(formRun && { hue0: formRun.hue0, hue1: formRun.hue1,
      none: formRun.hueNone, contrast: [formRun.con0, formRun.con1] }));
  // THE CURRENT-PART STRIP — between the tab section and the layers: a readout
  // of the part being EDITED, and tapping one switches every v2 layer's
  // content record to it. Playback must be untouched (the clocks never move).
  const cpRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, cfg = E.getCfg();
    const L = () => window.__Lv2(E);
    const svProg = cfg.prog ? JSON.parse(JSON.stringify(cfg.prog)) : null;
    const svPart = JSON.stringify(L().part);
    const svPF = L().partFor;
    const strip = () => document.getElementById('mix-bloom-curpart');
    // bare — no changes, no strip
    delete cfg.prog; E.getCfg(); if (strip()) strip()._sig = '';
    _ambSyncControls(E); await wait(200);
    const o = { hiddenBare: !!strip() && strip().style.display === 'none' };
    E.getCfg().prog = { on: true, name: 'CP', chords: [0, 7, 5, 9].map(rt => ({ root: rt, intervals: [0, 4, 7] })),
                        parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }] };
    E.getCfg(); strip()._sig = ''; _ambSyncControls(E); await wait(250);
    const psel = () => strip().querySelector('.ambient-curpart-sel');
    o.shown = strip().style.display !== 'none';
    // the parts ARE the options now; the chosen one is the select's value
    o.chips = [...(psel() ? psel().options : [])]
      .map((c) => c.textContent + (c.selected ? '*' : '')).join(' ');
    const kids = [...strip().parentElement.children];
    o.placed = kids.indexOf(strip()) === kids.findIndex(k => k.classList.contains('ambient-tabsec')) + 1 &&
      kids.indexOf(strip()) < kids.findIndex(k => k.classList.contains('ambient-layer'));
    const clock0 = { prog: E._progAnchor, grid: E._barGridAnchor, timer: !!E.timer };
    // a SHARED layer must not follow — per-part is its own explicit control
    (() => { const md2 = strip().querySelector('.ambient-curpart-mode');
      if (md2 && md2.value !== 'edit') { md2.value = 'edit'; md2.dispatchEvent(new Event('change', { bubbles: true })); } })();
    await wait(250);
    (() => { const s2 = psel(); s2.value = s2.options[1].value;
      s2.dispatchEvent(new Event('change', { bubbles: true })); })();
    await wait(300);
    o.sharedUntouched = !Number.isFinite(L().partFor);
    window._v2.partSelect(E, L(), 0); E.getCfg();     // now per-part → it follows
    chips()[0].click(); await wait(200); chips()[1].click(); await wait(300);
    o.tapped = { lit: chips()[1].classList.contains('on'), partFor: L().partFor,
      clocks: E._progAnchor === clock0.prog && E._barGridAnchor === clock0.grid && !!E.timer === clock0.timer };
    // cleanup
    delete E._curPart;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    if (Number.isFinite(svPF)) L().partFor = svPF; else { delete L().partFor; delete L().parts; delete L().partAll; }
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    E.getCfg(); if (strip()) strip()._sig = ''; _ambSyncControls(E); await wait(200);
    return o;
  });
  ok('the current-part strip sits between the tabs and the layers, and reads the parts',
    cpRun.hiddenBare && cpRun.shown && cpRun.placed && /Verse\*/.test(cpRun.chips),
    JSON.stringify(cpRun));
  ok('tapping a part makes it current for EDITING — per-part layers follow, shared ones and the clocks are untouched',
    cpRun.sharedUntouched && cpRun.tapped.lit && cpRun.tapped.partFor === 1 && cpRun.tapped.clocks,
    JSON.stringify({ shared: cpRun.sharedUntouched, tapped: cpRun.tapped }));
  // GREY, NOT GONE — a row whose only failing gate is `kind:live` stays VISIBLE
  // rather than hiding: losing the rhythm rows read as "where did the rhythm
  // params go". An ALTERNATIVE gate (wrong rhythm kind, wrong voice) still hides.
  //
  // RESTATED 2026-09-15 — WHICH parts grey. It used to be every written part,
  // and that contradicted the card itself: ℹ Why? names those rules as the
  // reason the notes are where they are, while the card greyed them out. Both
  // cannot be true (user: "if they are defining the static content generation,
  // the user should be able to access them"). They ARE — 🎲 New take re-rolls a
  // written part in place — so a take's rules are LIVE, and greying now means
  // what it always claimed to: this part has no generated provenance, so these
  // rules would only apply to a future generate. Both halves are asserted here.
  const greyRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    L().part.kind = 'live'; L().part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 }; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();
    // …AND THE GRID ROW IS THE `drawn` ONE NOW (2026-09-15). ✦ Method's cell
    // grid used to render a euclid PREVIEW and is gone with the duplication;
    // what survives is gated `rhythm:drawn`, where the cells are the only
    // Roll-form editor of a grid the emitter plays. Captured FIRST (a drawn
    // part with no cells emits nothing, so a capture from it would bank an
    // empty take and `made` would never say 'take'), then handed the cells the
    // rules just drew — same pattern, now owned by the grid.
    L().part.rhythm.cells = window._v2.euclidCells(5, 16, 0);
    L().part.rhythm.kind = 'drawn'; E.getCfg();
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    // THE RHYTHM ROWS LIVE BEHIND ✦ MAKE now (2026-09-13) — the Content group's
    // families became section buttons, so the body holds the drawing and these
    // rows are in a popover.
    const openSec = async (nm) => { const cb = document.querySelector('.v2-secpop-close'); if (cb) cb.click(); await wait(120); const b0 = document.querySelector('.v2-gototab[data-goto="' + nm + '"]'); if (b0) b0.click(); await wait(250); };
    await openSec('Generate');
    const pop = document.querySelector('.v2-secpop');
    const open = async (nm) => { const t = [...pop.querySelectorAll('.v2-pop-tabs [data-tab]')]
      .find(x => x.getAttribute('data-tab') === nm); if (t) { t.click(); await wait(200); } return !!t; };
    // RESTATED 2026-09-15 — ✦ METHOD ALWAYS OPENS. The rhythm tabs used to
    // refuse on a part with no generated provenance, and that refusal died with
    // the merge: Method now holds ⚙ Generate · ✨ Auto · ⌫ Clear, the doors that
    // UNDO the state being refused, so a tab that would not open would be
    // locking the way out behind the lock (this file's own "names a rule as the
    // reason, and the rule is unreachable" trap). The grey moved down a rung,
    // where it always belonged: the rhythm ROWS grey, and the `kind:recorded`
    // explainer row above them says why. Both halves, both directions, below.
    const o = { patternTab: !!pop.querySelector('.v2-pop-tabs [data-tab="Pattern"]'),
                rhythmTab: !!pop.querySelector('.v2-pop-tabs [data-tab="Rhythm"]') };
    // ── A WRITTEN TAKE: the rules that made it are EDITABLE (they decide the
    // next roll), so nothing here is inert.
    //
    // RESTATED 2026-09-15 — WHERE THE RULES ARE. ✦ Method's knobs were a strict
    // SUBSET of the ⚙ Generated panel's, writing the same fields under four
    // different words, and they are gone: the panel is the one home. The claim
    // is unchanged and the path is longer, so the probe walks it — Method, then
    // the ⚙ door that tab holds, then the knob in the panel it opens.
    const openTab = async (nm) => { const t = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === nm); if (t) { t.click(); await wait(200); } return !!t; };
    const openGen = async () => {
      await openTab('Method');
      window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
      await wait(300);
      return !!document.querySelector('.v2-layer.v2-genopen');
    };
    const closeGen = async () => { const gc = document.querySelector('.v2-layer .v2-genwrap .v2-gendone');
      if (gc) gc.click(); await wait(220); };
    const pulsesRow = () => { const el = document.querySelector('.v2-layer .v2-genrows [data-f="part.rhythm.pulses"]');
      return el ? el.closest('.ambient-ctrl') : null; };
    // THE GRID ROW IS "Drawn steps" — `.v2-cellrow:not(.v2-lanerow)`, the one
    // the Drums lanes row shares a class with (the documented duplicate-class
    // trap: a bare `.v2-cellrow` answers for whichever comes first). It is one
    // of the two HAND-EDIT surfaces the Method tab still owns: the ⚙ panel
    // generates, and a grid you edit by finger has nowhere else to live.
    const gridRow = () => document.querySelector('.v2-secpop .v2-cellrow:not(.v2-lanerow)');
    o.madeIsTake = L().part.made === 'take';
    // …measured ON SCREEN, in the panel the press opened — a class read off a
    // row nobody can see would pass with the door nailed shut.
    o.takeGenOpens = await openGen();
    o.takeRulesLive = !!pulsesRow() && pulsesRow().style.display !== 'none' &&
      !pulsesRow().classList.contains('v2-rowna') &&
      pulsesRow().getBoundingClientRect().height > 10;
    await closeGen();
    o.takeGridLive = !!gridRow() && !gridRow().classList.contains('v2-rowna');
    // …AND THE DOOR OPENS. The rows and the tab holding them are ONE claim:
    // fixing only the rows left every parameter editable behind a tab that
    // refused to open, which is worse than either state on its own.
    const tabOff = (nm) => { const t = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
        .find((x) => x.getAttribute('data-tab') === nm);
      if (!t) return 'missing';
      const cs = getComputedStyle(t);
      return (t.classList.contains('v2-tabna') || cs.pointerEvents === 'none') ? 'off' : 'on'; };
    // ✦ METHOD is the tab this claim is about now — Rhythm's rows merged into
    // it (2026-09-15) and Feel left Make for Shape before that, so it is the
    // one door to every rhythm rule. It must be OPEN on a written take…
    o.takeTabs = ['Method'].map(tabOff).join(',');
    o.takeTabsOpen = o.takeTabs === 'on';
    // GREY IS FOR PARAMETER ROWS ONLY — a gated BUTTON still hides: 🎲 New
    // take is the LIVE re-roll and "Replace with a new take" its recorded
    // twin; greying leaked both dice onto one recorded take bar (reported).
    o.noGreyButtons = ![...card.querySelectorAll('button')].some(x => x.classList.contains('v2-rowna'));
    // ── …AND A PART WITH NO GENERATED PROVENANCE STILL GREYS. Same notes, same
    // rules; only `made` differs, which is the whole claim.
    delete L().part.made; E.getCfg();
    window._v2.render(E); await wait(250);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    await openSec('Generate');
    o.handGridNa = !!gridRow() && gridRow().classList.contains('v2-rowna') &&
      gridRow().style.display !== 'none';
    o.handGenOpens = await openGen();
    o.handPulsesNa = !!pulsesRow() && pulsesRow().style.display !== 'none' &&
      pulsesRow().classList.contains('v2-rowna') &&
      pulsesRow().getBoundingClientRect().height > 10;
    // an ALTERNATIVE gate still HIDES rather than greying, in the same panel:
    // `n` is `rhythm:pulse` and this part is drawn. Read while the panel is
    // open, so "hidden" means hidden from a user rather than from the DOM.
    const onsets = [...document.querySelectorAll('.v2-layer .v2-genrows [data-f="part.rhythm.n"]')]
      .map((x) => x.closest('.ambient-ctrl'))[0];
    o.altStillHidden = !!onsets && onsets.style.display === 'none';
    await closeGen();
    // …AND OPEN ON A PART WITH NO PROVENANCE TOO — the fork this restates.
    // The old contract dimmed the tab and refused the press; Method holds
    // ⚙ Generate · ✨ Auto · ⌫ Clear, so refusing it would put the way out of
    // the refused state behind the refusal. The grey is stated one rung down
    // instead: the ROWS are inert and the explainer row says why, which is a
    // claim about the thing that is actually dead rather than about its door.
    o.handTabs = ['Method'].map(tabOff).join(',');
    o.handTabsOpen = o.handTabs === 'on';
    // …and the door still WORKS: pressing it navigates rather than refusing.
    const mt = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (mt) mt.click();
    await wait(200);
    o.handMethodOpens = !!mt && mt.classList.contains('on');
    // …and the generator doors behind it are LIVE, not greyed — they are what
    // hands this part back to the rules.
    const genDoor = document.querySelector('.v2-secpop .v2-genbtn') ||
      document.querySelector('.v2-layer .v2-genbtn');
    o.genDoorLive = !!genDoor && !genDoor.classList.contains('v2-rowna') &&
      getComputedStyle(genDoor).pointerEvents !== 'none';
    // VISIBLE, INERT, and readable — on a tab that opens
    await wait(150);
    await openSec('Shape');
    const sp = document.querySelector('.v2-secpop');
    // the row of the ACTIVE tab — every other tab's rows are `v2-rowoff` and
    // measure 0, so an unscoped find picks one that is merely not showing
    const st2 = [...sp.querySelectorAll('.ambient-ctrl.v2-rowna')]
      .find(r => !r.classList.contains('v2-rowoff') && r.getBoundingClientRect().height > 10);
    o.greyVisible = !!st2 && getComputedStyle(st2).pointerEvents === 'none' &&
      parseFloat(getComputedStyle(st2.querySelector('label') || st2).opacity) < 0.6;
    await wait(150);
    await openSec('Generate');
    // back to Generated: the grey lifts
    L().part.kind = 'live'; E.getCfg();
    window._v2.render(E); await wait(250);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    await openSec('Generate');
    const p2 = [...document.querySelectorAll('[data-f="part.rhythm.pulses"]')].map(x => x.closest('.ambient-ctrl'))[0];
    o.liveClear = p2 && !p2.classList.contains('v2-rowna');
    // THE WRITTEN EXPLAINER IS GONE (2026-09-15) and is no longer asserted: it
    // said "these are greyed because the part is written" about knobs that have
    // left this tab, so with nothing left in it to grey it was answering a
    // question the tab no longer raises. The greying it explained is still
    // pinned — one rung down, in the ⚙ panel, above.
    o.noStaleWhy = ![...document.querySelectorAll('.v2-layer .ambient-ctrl')]
      .some((r) => /These shape a/.test(r.textContent || ''));
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  // RESTATED 2026-09-15 — the rules are one door FURTHER now. ✦ Method's knob
  // rows were a subset of the ⚙ Generated panel's, and the duplicates went; the
  // tab keeps the DOOR. So the claim is walked rather than read off the tab:
  // Method opens, ⚙ Generate opens from inside it, and the rule is editable
  // there. Same contract, and it now pins the PATH as well as the state.
  ok('a WRITTEN TAKE keeps its rules EDITABLE, behind tabs that OPEN — they decide the next roll',
    greyRun.madeIsTake && greyRun.takeGenOpens && greyRun.takeRulesLive &&
    greyRun.takeGridLive && greyRun.takeTabsOpen,
    JSON.stringify(greyRun));
  // RESTATED 2026-09-15 (the old-CONTRACT fork): the refusal this used to pin
  // was `handTabsOff`, and it cannot be true of ✦ Method — the tab holds the
  // doors that undo the state it would be refusing. The claim it stood for is
  // stronger stated where the inertness lives: the rule ROWS grey (in the
  // ⚙ panel, the one place they exist now), an alternative gate still hides,
  // and the two hand-edit surfaces the tab keeps grey with them.
  ok('…and with no generated provenance they GREY instead of hiding — alternatives hide, no BUTTON greys',
    greyRun.handGridNa && greyRun.handGenOpens && greyRun.handPulsesNa && greyRun.greyVisible &&
    greyRun.altStillHidden && greyRun.liveClear && greyRun.noGreyButtons,
    JSON.stringify(greyRun));
  // RESTATED AGAIN 2026-09-15, NARROWER, with the knobs: the explainer row and
  // the greyed rule rows it explained have both left this tab, so the clauses
  // about them are gone rather than reworded — and the stale explainer is
  // pinned by ABSENCE so it cannot drift back in beside nothing. What is left
  // is the claim that made the tab openable in the first place: it opens, it is
  // not dressed as refusable, and the ⚙ door inside it is live.
  ok('…and ✦ Method still OPENS on an inert part — the doors out are inside it',
    greyRun.handTabsOpen && greyRun.handMethodOpens && greyRun.genDoorLive &&
    greyRun.noStaleWhy && !greyRun.rhythmTab && !greyRun.patternTab,
    JSON.stringify(greyRun));
  // TAB FAMILIES — Content's thirteen tabs were an undifferentiated wall; the
  // strip is labelled, tinted family rows now (make · rhythm · time · pitch),
  // with a trailing unlabelled row so a NEW tab can never vanish from it.
  const famRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svKind = L().part.kind;
    L().part.kind = 'recorded'; E.getCfg();       // the fullest tab set
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    await wait(250);
    // RESTATED 2026-09-13 with the reason (the old-CONTRACT fork): Content's
    // FAMILIES became section buttons, so there is no two-level strip left to
    // assert. The guarantee it stood for — no Content tab can go missing, and
    // rhythm is a no-op on a Fixed part that says so — is restated on the
    // surface that exists: three section buttons, each owning its own tabs.
    const tabsOf = (nm) => { window.__sec(nm); return new Promise(r => setTimeout(() => {
      const st2 = document.querySelector('.v2-pop-tabs');
      r(st2 ? [...st2.querySelectorAll('[data-tab]')] : []); }, 260)); };
    const mkT = await tabsOf('Generate'), tiT = await tabsOf('Time'), bkT = await tabsOf('Bank');
    const names = (a) => a.map(x => x.getAttribute('data-tab'));
    const fams = ['Generate:' + names(mkT).join('/'), 'Time:' + names(tiT).join('/'),
                  'Bank:' + names(bkT).join('/')].join(' ');
    // EVERY Content tab is behind exactly one of the three
    const covered = new Set([...names(mkT), ...names(tiT), ...names(bkT)]);
    // 'Rhythm' IS GONE — its rows merged into Method (2026-09-15), so the tab
    // must not be in the roster at all; a name that survives its rows is a door
    // to an empty room. Asserted by ABSENCE, alongside the two that left before.
    const allInFams = covered.has('Method') && !covered.has('Rhythm') &&
      // FEEL IS A SHAPE TAB NOW, not a Content one — restated 2026-09-15 with
      // the move. The claim is unchanged: every tab is behind exactly one
      // section, and Feel is behind ▨ Shape.
      // Pattern and Feel both left Content on 2026-09-15 — Pattern because the
      // form IS it, Feel for ▨ Shape. The claim is unchanged: every tab sits
      // behind exactly one section.
      !covered.has('Pattern') && !covered.has('Feel') && covered.has('Bars') &&
      covered.has('Bank') && covered.size >= 8;
    // RESTATED 2026-09-15 — THE TAB NO LONGER REFUSES. Rhythm's rows are
    // Method's rows now, and Method also holds ⚙ Generate · ✨ Auto · ⌫ Clear:
    // a door that will not open while holding the doors OUT of the state it is
    // refusing is this file's own documented contradiction. So the tint and the
    // `tabNa` dim both went with the merge, and what is pinned here is the
    // opposite claim — on a part with NO generated provenance (the fixture that
    // used to see the refusal) ✦ Method is plain, opens, and shows the greyed
    // rows with their explainer behind it.
    delete L().part.made; E.getCfg();
    const h9 = document.getElementById('bloom-v2-layers'); if (h9) h9._sig = '';
    window._v2.render(E); await wait(260);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    await tabsOf('Generate');
    const strip = document.querySelector('.v2-pop-tabs');
    const mkTabs = [...strip.querySelectorAll('[data-tab]')];
    const rhy = mkTabs.find(x => x.getAttribute('data-tab') === 'Rhythm');
    const mth = mkTabs.find(x => x.getAttribute('data-tab') === 'Method');
    // ONE TAB, NOT TWO — and it wears no rhythm tint, because the tint was the
    // mark of a tab `tabNa` could refuse and nothing refuses this one.
    const methodOnly = !rhy && !!mth && !/tint-fam-rhythm/.test(mth.className) &&
      !mth.classList.contains('v2-tabna') && mth.getAttribute('aria-disabled') !== 'true' &&
      parseFloat(getComputedStyle(mth).opacity) >= 0.6;
    // …AND THE PRESS NAVIGATES. The old claim was that it refused and explained;
    // the explanation moved into the pane, so the door has to open to reach it.
    if (mth) mth.click();
    await wait(220);
    const methodOpens = !!mth && mth.classList.contains('on');
    // WHAT IT OPENS ONTO — restated 2026-09-15 with the consolidation. It used
    // to be the greyed rhythm rows and the row explaining them; those knobs are
    // the ⚙ Generated panel's now and the explainer went with them. What the
    // tab holds is the DOORS, so that is what a press has to land on — an open
    // tab showing nothing actionable is the empty room this whole pass is about.
    // SCOPED TO THE SECTION POPOVER — the card carries a second `.v2-pop-pane`
    // (its own embedded Content editor), and an unscoped query answers for
    // whichever comes first (the documented duplicate-class trap).
    const pane0 = document.querySelector('.v2-secpop .v2-pop-pane');
    const doorRow = pane0 && [...pane0.querySelectorAll('.ambient-ctrl')]
      .find((r) => r.querySelector('.v2-genbtn') && r.getBoundingClientRect().height > 10 &&
        !r.classList.contains('v2-rowoff'));
    const gen0 = doorRow && doorRow.querySelector('.v2-genbtn');
    const methodDoors = !!gen0 && !gen0.classList.contains('v2-rowna') &&
      gen0.getBoundingClientRect().height >= 32 &&
      // …and no rhythm knob came with them: the tab is doors and hand-edit
      // surfaces, and every `part.rhythm.*` field lives one door further in.
      !pane0.querySelector('[data-f^="part.rhythm."]');
    // a row label that repeats the active tab is hidden — EXCEPT one carrying
    // a control (Pattern's ↻ regen button lives inside its label)
    const labOf = (nm) => { const t2 = mkTabs.find(x => x.getAttribute('data-tab') === nm);
      if (t2) t2.click();
      const r2 = [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')].find(x =>
        x.getBoundingClientRect().height > 0 && !x.classList.contains('v2-rowoff'));
      const lb = r2 && r2.querySelector(':scope > label');
      return lb ? getComputedStyle(lb).display : 'none'; };
    const dupHidden = labOf('Method') === 'none';
    const withCtrl = [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')]
      .filter(r => r.querySelector(':scope > label button, :scope > label input, :scope > label select'));
    // VACUOUS-SAFE since 2026-09-15: the only Content row whose LABEL carried a
    // control was Pattern's (its ↻ regen sat inside the label), and that row
    // left with the grid for ▦ Pattern. The rule still stands — a label holding
    // a control is never hidden as a duplicate — so it is kept armed for the
    // next one rather than deleted; it simply has nothing to judge today, and
    // `withCtrl.length` is reported so that stays visible rather than passing
    // silently as if it had.
    const ctrlLabKept = withCtrl.every(r => !r.classList.contains('v2-labdup'));
    // PHONE HEAD: the section buttons own the top rows outright and WRAP, with
    // the per-part trio below them — measured on the BODY's head, which is the
    // only head the card itself has.
    window.__toContent(); await wait(200);
    const head = document.querySelector('.v2-pop-head');
    const tabsH = [...head.querySelectorAll('.v2-gototab')];
    const rT = tabsH[0].getBoundingClientRect();
    const rL = tabsH[tabsH.length - 1].getBoundingClientRect();
    const rP = head.querySelector('.v2-pop-pair').getBoundingClientRect();
    // …and the summary rides in the head with the pair. On a PHONE the pair
    // takes the whole row so the summary wraps below it (that is what is
    // measured here); at desktop widths it shares the pair's row and
    // right-aligns into the ~296px that was dead space. This gate is
    // single-viewport, so only the phone half of that is asserted.
    const sum = head.querySelector('.v2-grpsum');
    const rS = sum ? sum.getBoundingClientRect() : null;
    const phoneHead = rL.top >= rT.bottom - 4 &&
      tabsH.every((t2) => t2.getBoundingClientRect().height >= 36) &&
      rP.top >= rL.bottom - 4 &&
      !!rS && rS.height > 0 && rS.top >= rP.bottom - 4 &&
      head.scrollWidth - head.clientWidth === 0;
    // …and ⏱ Time lands on its own tabs, the pane wearing that family's hue
    await tabsOf('Time');
    const famNav = names([...document.querySelectorAll('.v2-pop-tabs [data-tab]')]).join(',');
    const t = [...document.querySelectorAll('.v2-pop-tabs [data-tab]')]
      .find(x => x.getAttribute('data-tab') === 'Bars');
    if (t) t.click(); await wait(200);
    const pane = document.querySelector('.v2-pop-pane');
    const lab = [...pane.querySelectorAll('.ambient-ctrl')].find(r =>
      r.style.display !== 'none' && !r.classList.contains('v2-rowoff'));
    const o = { fams, allInFams,
      navWorks: !!t && t.classList.contains('on'), phoneHead, famNav,
      dupHidden, ctrlLabKept, ctrlLabN: withCtrl.length, methodOnly, methodOpens, methodDoors,
      secBtns: tabsH.length,
      labHue: lab ? getComputedStyle(lab.querySelector('label')).color : null };
    window.__toContent();
    await wait(150);
    L().part.kind = svKind; delete L().part.mat; delete L().part.mem; E.getCfg();
    window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  // RESTATED with the regroup: the bar is make · time · pitch · SAVED (rhythm
  // folded into make, tinted), and the height pin moves 120 → 160 because the
  // make row legitimately wraps to two lines at six chips. The contract is
  // "two levels, not four stacked rows" — it was ~250px before the fold.
  ok('Content is three sections — ✦ Generate (with rhythm) · ⏱ Time · Bank — and every tab is behind one',
    /Generate:/.test(famRun.fams) && /Time:/.test(famRun.fams) && /Bank:/.test(famRun.fams) &&
    famRun.allInFams && famRun.navWorks && famRun.secBtns === 8 &&
    famRun.methodOnly && famRun.methodOpens && famRun.methodDoors &&
    famRun.phoneHead && /Bars/.test(famRun.famNav) && famRun.dupHidden && famRun.ctrlLabKept,
    JSON.stringify(famRun));
  // THE ICE MODEL — the Everywhere record survives per-part mode intact, every
  // part (added whenever) starts from a FITTED copy of it, an un-diverged
  // part's playback never depends on which part is selected, and part deletion
  // re-indexes the records (the clamped-index trap).
  const iceRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    const L = () => window.__Lv2(E);
    const svProg = cfg.prog ? JSON.parse(JSON.stringify(cfg.prog)) : null;
    const svPart = JSON.stringify(L().part);
    const mk = (rt) => ({ root: rt, intervals: [0, 4, 7] });
    cfg.prog = { on: true, name: 'ICE', chords: [0, 7, 5, 9, 2].map(mk),
                 parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 3 }] };
    L().part.kind = 'live'; L().part.bars = 2;
    L().part.rhythm = { kind: 'pulse', n: 3, steps: 16 }; E.getCfg();
    const o = {};
    // ENGAGE on Verse: the Everywhere record is iced; Chorus materialises as a
    // fitted copy of it (bars = its 3-chord pass, rules = the Everywhere rules)
    window._v2.partSelect(E, L(), 0); E.getCfg();
    const Lb = L();
    o.iced = !!(Lb.partAll && (Lb.partAll.rhythm.n | 0) === 3 && Lb.partAll.bars === 2);
    const ch = Lb.parts && Lb.parts['1'];
    o.chorusCopy = !!(ch && (ch.rhythm.n | 0) === 3 && ch.bars === 3);
    // STABILITY: editing the bench (Verse) must not change what Chorus plays
    Lb.part.rhythm = { kind: 'pulse', n: 8, steps: 16 }; E.getCfg();
    const barSec = (60 / (+document.getElementById('tempo-input').value || 120)) * 4;
    const nf = (at) => window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: at, cycleSec: 2 * barSec }).length;
    o.verseN = nf(0.1); o.chorusN = nf(2 * barSec + 0.1);
    // A PART ADDED LATER gets a fitted copy of the ICE, not of the edited bench
    const c2 = E.getCfg();
    c2.prog.chords.push(mk(4), mk(11));
    c2.prog.parts.push({ name: 'Bridge', len: 2 });
    E.getCfg();
    const br = L().parts && L().parts['2'];
    o.bridgeCopy = !!(br && (br.rhythm.n | 0) === 3 && br.bars === 2);
    // DELETING the middle part shifts the records with the parts
    try { _ambProgDeletePart(E, 1); } catch (e) {}
    E.getCfg();
    const L3 = L();
    o.afterDelete = { partFor: L3.partFor,
      shifted: !!(L3.parts && L3.parts['1'] && (L3.parts['1'].rhythm.n | 0) === 3 && L3.parts['1'].bars === 2),
      chorusGone: !(L3.parts && L3.parts['2']) };
    // DISENGAGE restores the ICED Everywhere record, edits and all dropped
    window._v2.partSelect(E, L(), null); E.getCfg();
    o.back = { n: L().part.rhythm.n | 0, bars: L().part.bars,
      clean: !L().partAll && !L().parts && !Number.isFinite(L().partFor) };
    // cleanup
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem;
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    E.getCfg();
    return o;
  });
  ok('per-part ices the Everywhere record, and every part starts from a FITTED copy of it',
    iceRun.iced && iceRun.chorusCopy && iceRun.bridgeCopy,
    JSON.stringify(iceRun).slice(0, 240));
  ok('an un-diverged part plays its own copy — editing the bench moves only the selected part',
    iceRun.verseN === 8 && iceRun.chorusN === 3, JSON.stringify({ v: iceRun.verseN, c: iceRun.chorusN }));
  ok('deleting a part shifts the records with the parts, and Everywhere comes BACK on disengage',
    iceRun.afterDelete.partFor === 0 && iceRun.afterDelete.shifted && iceRun.afterDelete.chorusGone &&
    iceRun.back.n === 3 && iceRun.back.bars === 2 && iceRun.back.clean,
    JSON.stringify(iceRun).slice(0, 280));
  // TONE CHANGES APPLY NOW — the commit is v1's cancel + re-anchor pair, so a
  // Tone/kit change while playing retracts the un-started old-tone notes and
  // the next tick re-emits with the new one (reported: "changing Instrument
  // tone does not update the content"). Wall-time stamps, because a playNote
  // wrapper logs at SCHEDULE time and cannot see the cancel (documented).
  const toneRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part); const svTone = L().instrument.tone;
    L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 2;
    L().part.rhythm = { kind: 'pulse', n: 8, steps: 16 };
    L().instrument.voice = 'synth'; L().instrument.tone = 'sawtooth'; E.getCfg();
    window._v2.render(E); await wait(250);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    const log = [];
    const oP = window.playNote;
    window.playNote = function (f, p2, d, at) {
      const r = oP.apply(this, arguments);
      if (window._ambEmitKey === 'v2:' + L().id) log.push({ w: Tone.now(), ty: (p2 && p2.type) || '?' });
      return r;
    };
    _ambStartGenerator(E); await wait(1500);
    const sel = [...document.querySelectorAll('.v2-layer [data-f="instrument.tone"]')][0];
    const tChange = Tone.now();
    sel.value = 'square'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(1300);
    _ambStopGenerator(E); window.playNote = oP;
    const after = log.filter(n => n.w > tChange + 0.05);
    const o = { oldAfter: after.filter(n => n.ty === 'sawtooth').length,
      newAfter: after.filter(n => n.ty === 'square').length };
    try { L().part = JSON.parse(svPart); } catch (e) {}
    L().instrument.tone = svTone; delete L().part.mat; delete L().part.mem; E.getCfg();
    // THIS IS THE FIRST CHECK THAT PLAYS THE REAL TRANSPORT, and `_playStartAt`
    // survives the stop — every later direct notesFor call then resolves its
    // chords against a stale wall-clock anchor and clamps to chord 0 (four
    // downstream harmony checks failed exactly that way). Null the anchors.
    try { E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null; E._pressAt = null; } catch (e) {}
    window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('a Tone change mid-play cancels the old-tone schedule and re-emits with the new one',
    toneRun.oldAfter === 0 && toneRun.newAfter > 3, JSON.stringify(toneRun));
  // THE RULE'S KNOBS — WHERE THEY ARE, AND THAT THEY STILL COMMIT.
  // RESTATED 2026-09-15 (the old-GEOMETRY fork, twice over). This began as "the
  // grid leads and its five knobs are one micro row", measured against five full
  // rows in a ~170px pane. The grid went to ▦ Pattern, and now the `.v2-microrow`
  // itself is gone: every one of its five steppers was a DUPLICATE of a knob in
  // the ⚙ Generated panel, writing the same field — and four said a different
  // word for it (Onsets/Pulses were both the panel's "How many", Rotate its
  // "Push", Voices its "Rows"). The properties this check exists for — reachable
  // from ✦ Method, 16px, hit-testable, committing, no sideways scroll — are
  // asserted on the surface that kept the knobs.
  const patRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    L().part.kind = 'live'; L().part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 }; E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(250);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    // ✦ Method holds the DOOR; ⚙ Generate holds the knobs. Two presses, and
    // the second is the one a user makes to reach a rule at all.
    const openPat = async () => {
      window.__sec('Generate');
      await wait(240);
      const t = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
        .find((x) => x.getAttribute('data-tab') === 'Method');
      if (t) t.click(); await wait(200);
      if (!card().classList.contains('v2-genopen')) {
        window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(300);
      }
      return card().classList.contains('v2-genopen');
    };
    const o = { opened: await openPat() };
    const pop = () => card().querySelector('.v2-shapepop');
    // RESTATED 2026-09-17 (the Deep reorganisation): Steps · Push are on
    // Fine-tune's Rhythm TAB, and the Rhythm recipe is inside ⚠ Advanced:
    // recipe — press the tab and the fold's own button, as a user does
    { const tb = pop().querySelector('.v2-fttab[data-ft="rhythm"]');
      if (tb && !card().classList.contains('v2-ftt-rhythm')) { tb.click(); await wait(200); }
      const fb = pop().querySelector('.v2-discbtn[data-disc="recipe"]');
      if (fb && !card().classList.contains('v2-so-recipe')) { fb.click(); await wait(220); } }
    const rowsOf = () => [...pop().querySelectorAll('.v2-genrows .ambient-ctrl')]
      .filter((x) => x.getBoundingClientRect().height > 0);
    const rowFor = (f) => rowsOf().find((x) => x.querySelector('[data-f="' + f + '"]'));
    // THE TOP TIER, in the panel's own words. Vary and Rows are real knobs too
    // and live behind ▸ More, which has its own check — a fold is not a
    // duplicate, it is an order.
    o.labs = ['part.rhythm.kind', 'part.rhythm.pulses', 'part.rhythm.steps', 'part.rhythm.rotate']
      .map((f) => { const r = rowFor(f); return r ? ((r.querySelector('label') || {}).textContent || '?').trim() : 'MISSING'; })
      .join(',');
    const stepsRow = rowFor('part.rhythm.steps');
    const inp = stepsRow && stepsRow.querySelector('.ambient-step-inp');
    const up = stepsRow && stepsRow.querySelector('.ambient-step-up');
    // iOS zooms a focused field under 16px and never zooms back
    o.font = inp ? getComputedStyle(inp).fontSize : 'none';
    o.hitOK = (() => { if (!up) return false;
      up.scrollIntoView({ block: 'center' });
      const q1 = up.getBoundingClientRect();
      if (q1.width < 1 || q1.height < 1) return false;
      return document.elementFromPoint(q1.left + q1.width / 2, q1.top + q1.height / 2) === up; })();
    o.overflow = pop().scrollWidth - pop().clientWidth;
    // …AND THE PRESS COMMITS, by exactly one (the document-level ± delegation
    // and the card's `.v2-f` handler, neither of which this panel rewires)
    const s0 = +(L().part.rhythm.steps);
    if (up) up.click();
    await wait(300);
    o.steps = (+(L().part.rhythm.steps)) - s0;
    // …and the panel is still standing after the commit. NOT the button: a
    // `part.rhythm.steps` commit rebuilds the whole card on purpose (the lane
    // grid is built from `steps`), which is exactly why this knob is a STEPPER
    // and not a slider — a tap survives a rebuild, a drag would not. So what is
    // pinned is that the control COMES BACK holding the committed value and a
    // SECOND press moves it by exactly one more: re-queried between presses,
    // which is the anti-double-fire claim this check has always carried.
    o.stillOpen = card().classList.contains('v2-genopen');
    const up2 = (() => { const r2 = rowFor('part.rhythm.steps');
      return r2 ? r2.querySelector('.ambient-step-up') : null; })();
    const inp2 = (() => { const r2 = rowFor('part.rhythm.steps');
      return r2 ? r2.querySelector('.ambient-step-inp') : null; })();
    o.knobReturns = !!up2 && !!inp2 && (+inp2.value | 0) === (+(L().part.rhythm.steps) | 0);
    if (up2) up2.click();
    await wait(300);
    o.steps2 = (+(L().part.rhythm.steps)) - s0;
    // THE SECOND TIER IS GONE FROM ✦ METHOD. Measured through the pane the tab
    // actually shows, with the panel closed so nothing overlaps it.
    // …and the fold is STILL OPEN after both rebuilds (a fold that shut under
    // the finger read as the knob vanishing)
    o.foldHeld = card().classList.contains('v2-so-recipe') && card().classList.contains('v2-ftt-rhythm');
    { const fb = pop().querySelector('.v2-discbtn[data-disc="recipe"]'); if (fb && card().classList.contains('v2-so-recipe')) fb.click(); }
    const gc = card().querySelector('.v2-shapepop .v2-gendone'); if (gc) gc.click();
    await wait(240);
    window.__sec('Generate'); await wait(240);
    const t2 = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (t2) t2.click(); await wait(220);
    const pane = document.querySelector('.v2-secpop .v2-pop-pane');
    o.paneKnobs = pane ? pane.querySelectorAll('[data-f^="part.rhythm."]').length : -1;
    o.microRows = document.querySelectorAll('.v2-microrow').length;
    await wait(150);
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('the rule’s knobs are one press from ✦ Method, at touch size, and they commit',
    patRun.opened && patRun.labs === 'Rhythm,How many,Steps,Push' &&
    patRun.font === '16px' && patRun.hitOK && patRun.overflow === 0 &&
    patRun.steps === 1 && patRun.stillOpen && patRun.knobReturns && patRun.steps2 === 2 &&
    patRun.foldHeld,
    JSON.stringify(patRun));
  // …AND THERE IS ONLY ONE TIER OF THEM (2026-09-15, user: "now we have two
  // tiers of controls for the Generated method, we need to consolidate and
  // streamline"). Pinned by ABSENCE on both sides, because a duplicate control
  // is exactly the kind of thing that grows back one row at a time: no
  // `.v2-microrow` anywhere in the app, no `part.rhythm.*` knob in the Method
  // pane at all, and no field on the whole card offered by two controls — while
  // the ⚙ panel still offers the four the tab used to shadow. ONE FIELD WITH
  // TWO NAMES READS AS TWO MECHANISMS, which is what this prevents.
  ok('the Generated method is ONE tier — ✦ Method offers no knob the ⚙ panel owns',
    patRun.microRows === 0 && patRun.paneKnobs === 0 &&
    patRun.labs === 'Rhythm,How many,Steps,Push',
    JSON.stringify(patRun));
  // CHOOSING THE MODE YOU ARE ALREADY IN IS A NO-OP. These name what the part
  // IS, so the lit one restates a fact — and pressing 🎲 Roll used to REPLACE
  // your take (it re-rolled), which is 🎲-above-the-drawing's job.
  const noopRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svPart = JSON.stringify(L().part);
    window.confirm = () => true;
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    // the shapes moved into the ⚙ Shape… popover; it stays open across a
    // choice, so one press gets in and one gets out at the end
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(280);
    card().classList.remove('collapsed');
    card().querySelector('.v2-shapepop .v2-rollrun').click(); await wait(420);
    card().classList.remove('collapsed');
    const lit = card().querySelector('.v2-genshapes .ambient-seg.on');
    const face = (b) => ((b && b.childNodes[0] && b.childNodes[0].nodeValue) || '').trim();
    const o = { label: face(lit), mark: getComputedStyle(lit, '::before').content };
    const sig = JSON.stringify(L().part);
    card().querySelector('.v2-shapepop .v2-rollrun').click(); await wait(400);
    card().classList.remove('collapsed');
    o.rollNoop = JSON.stringify(L().part) === sig;
    card().querySelector('.v2-shapepop .v2-mkpart[data-mk="sustain"]').click(); await wait(420);
    card().classList.remove('collapsed');
    const sig2 = JSON.stringify(L().part);
    card().querySelector('.v2-shapepop .v2-mkpart[data-mk="sustain"]').click(); await wait(400);
    card().classList.remove('collapsed');
    o.modeNoop = JSON.stringify(L().part) === sig2;
    o.stillLit = face(card().querySelector('.v2-genshapes .ambient-seg.on'));
    o.doorNames = (card().querySelector('.v2-genface') || {}).textContent || '';
    const gc2 = card().querySelector('.v2-shapepop .v2-gendone'); if (gc2) gc2.click();
    await wait(200); card().classList.remove('collapsed');
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    card().classList.remove('collapsed');
    return o;
  });
  ok('a Method button is a MODE, not a status or an action — the lit one is a no-op',
    // the shape names are the panel's imperative faces since 2026-09-16
    noopRun.label === '\ud83c\udfb2 Roll a line' && noopRun.mark === 'none' &&
    noopRun.rollNoop && noopRun.modeNoop && /Sustain a chord/.test(noopRun.stillLit),
    JSON.stringify(noopRun));
  // THREE THINGS THE MATERIAL ROW OWES THE USER: choosing a mode is SILENT
  // (an audition while clicking through the row reads as a stray note from
  // nowhere — the same rule 🎲 New take already follows), the row says WHICH
  // KIND each option is ("what's the difference between Composed and
  // Sustained?" — one writes notes, the other is a rule), and on a phone the
  // pattern grid has finger-sized cells (16 steps across a 333px pane is 18px).
  const matKindRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svPart = JSON.stringify(L().part);
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    let notes = 0; const oP = window.playNote;
    window.playNote = function () { notes++; return oP.apply(this, arguments); };
    for (const s2 of ['.v2-mkpart[data-mk="sustain"]', '.v2-mkpart[data-mk="arp"]', '.v2-rollrun']) {
      card().querySelector(s2).click(); await wait(420); card().classList.remove('collapsed');
    }
    window.playNote = oP;
    const o = { silent: notes === 0,
      groups: [...card().querySelectorAll('.v2-matgrp')].map(g =>
        ((g.querySelector('.v2-matlab') || {}).textContent || '') + ':' +
        [...g.querySelectorAll('.ambient-seg')].length).join(' ') };
    // the grid, at the width the phone actually has
    L().part.kind = 'live'; L().part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 }; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    // MEASURED ON THE BODY'S ▦ PATTERN GRID — the one the phone actually has
    // (RESTATED 2026-09-15, the old-GEOMETRY fork). The copy this measured sat
    // in the Rhythm tab and was a euclid PREVIEW over `r.steps`, drawn beside a
    // body grid of bars × grid cells: two lengths, two sources, one label, and
    // the reason the duplicate is gone. The touch floor was the ONE thing that
    // copy did better, and that is fixed at the source now — `stepBlocksHtml`
    // chunks 8-per-row under 540px and the cells carry a 34px floor — so the
    // claim is made where the finger lands.
    window.__toContent(); await wait(200);
    const fb = card().querySelector('.v2-formbtn');
    if (fb) fb.click(); await wait(420);           // ⌗ Roll → ▦ Pattern
    card().classList.remove('collapsed');
    o.inSteps = L().part.form === 'steps';
    const wrap = card().querySelector('.v2-partsteps');
    const cells = [...(wrap ? wrap.querySelectorAll('.v2-stepsgrid .v2-cell') : [])]
      .filter(c => c.getBoundingClientRect().height > 0);
    o.nCells = cells.length;
    const c0 = cells[0].getBoundingClientRect();
    o.cell = Math.round(c0.width) + 'x' + Math.round(c0.height);
    o.cellBig = c0.width >= 32 && c0.height >= 32;
    cells[0].scrollIntoView({ block: 'center' });
    const c0b = cells[0].getBoundingClientRect();
    o.hit = document.elementFromPoint(c0b.left + c0b.width / 2, c0b.top + c0b.height / 2) === cells[0];
    // …and it still edits
    const was = cells[3].classList.contains('on');
    cells[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(250);
    const now = [...card().querySelectorAll('.v2-partsteps .v2-stepsgrid .v2-cell')]
      .filter(c => c.getBoundingClientRect().height > 0);
    o.toggles = !!now[3] && now[3].classList.contains('on') !== was;
    // UI rule 1 — no sideways scroll, measured on the scroller the grid is in
    const body = card().querySelector('.ambient-layer-body');
    o.overflow = body ? (body.scrollWidth - body.clientWidth) : -1;
    await wait(150);
    const fb2 = card().querySelector('.v2-formbtn');
    if (fb2) fb2.click(); await wait(380);          // …and back to ⌗ Roll
    card().classList.remove('collapsed');
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    card().classList.remove('collapsed');
    return o;
  });
  ok('choosing a Method is SILENT, the row says which KIND each option is, and the phone grid is finger-sized',
    // Generated is FOUR doors since ⚇ Mixed — the other three each commit to
    // one texture, so chords-and-single-notes had no door. The contract is the
    // two labelled clusters, not the count, but the count is worth pinning so
    // a door cannot vanish unnoticed.
    // ONE Generated door now — the four shapes moved behind ⚙ Shape…, which
    // is where their knobs are. The contract is the two labelled clusters.
    // TWO Generated doors: ⚙ Shape… (the figure on top) and ⛰ Groundwork
    // (playing the changes themselves). The contract is the two labelled
    // clusters; the count is pinned so a door cannot vanish unnoticed.
    // RESTATED: Written is ONE door. ♪ Phrase was the second and it was a
    // signpost to the Bank tab — one list wearing two words, and filed under a
    // cluster it does not belong to (a GENERATED take banks just as readily).
    // RESTATED 2026-09-09: Groundwork moved into the Generated panel, so the
    // Generated cluster is ONE door.
    // RESTATED 2026-09-10: the clusters are "By hand" and "By rule". They were
    // "Written" and "Generated", which named the two doors as if they made
    // different KINDS of thing — measurably not so: both make static content,
    // and the words now say how it is AUTHORED. Same contract, one door each.
    // RESTATED 2026-09-16: ⌫ Clear moved to the drawing's head, so the
    // cluster is ⚙ Generate · ✨ Auto — two doors.
    matKindRun.silent && /:2$/.test(matKindRun.groups) && matKindRun.inSteps &&
    matKindRun.cellBig && matKindRun.hit && matKindRun.toggles && matKindRun.overflow === 0,
    JSON.stringify(matKindRun));
  // COMPOSING TAKES THE SHEET. The docked Grid editor is a full instrument
  // (~464px) and the sheet's pane is ~230px on a phone — it could not fit, and
  // ✓ Done / ⬇ To bank / ✕ Cancel sat below the fold (measured at y=1183 in an
  // 800px window). While a session is open the drawing, the tab strip and
  // ▶ Preview step aside, the actions PIN to the bottom, and on a phone the
  // sheet fills the screen.
  const compRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    // the per-chord strip only has blocks to draw when there ARE changes
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    E.getCfg().prog = { on: true, name: 'CMP', chords: [0, 2, 4, 5, 7].map(rt => ({ root: rt, intervals: [0, 4, 7] })) };
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    // ✎ Written lives in ✦ Make — the compose dock is Content's, and Content's
    // rows are behind the section buttons now.
    await wait(250);
    document.querySelector('.v2-gridbtn').click(); await wait(300);
    const gpb = null;
    if (gpb) gpb.click();
    await wait(700);
    // RESTATED 2026-09-13: ✦ Make CLOSES when a door hands off to the card
    // ("grid doesn't show"). The dock lives on the card body, and Make is
    // modal over it — measured, the dock opened 333×464 entirely behind the
    // scrim. So the sheet under test is the BODY's, and Make being gone is
    // part of the contract now rather than an accident.
    const pop = document.querySelector('.v2-pop');
    const bodyPop = pop;
    const acts = document.querySelector('.v2-gacts');
    const o = { composing: card().classList.contains('v2-composing'), started: !!acts,
      secClosed: !document.querySelector('.v2-secpop-wrap') };
    if (pop && acts) {
      const r = pop.getBoundingClientRect(), ra = acts.getBoundingClientRect();
      const done = acts.querySelector('.v2-gdone');
      const rd = done.getBoundingClientRect();
      // RESTATED with the embed: the editor is the card's body now, so
      // "takes the whole screen" is no longer a thing it can do — it simply
      // grows in the flow and the panel scrolls to it. What still has to hold
      // is that the dock gets real room and the actions are REACHABLE.
      o.fullScreen = r.width > 200 && r.height > 300;
      o.actsPinned = ra.height > 0 && ra.width > 0;
      done.scrollIntoView({ block: 'center' });
      const rd2 = done.getBoundingClientRect();
      o.doneHit = document.elementFromPoint(rd2.left + rd2.width / 2, rd2.top + rd2.height / 2) === done;
      // RESTATED: the drawing and ▶ Preview still step aside (the tick skips a
      // composing layer, so a preview there previews nothing you are editing),
      // but THE TAB STRIP STAYS — hiding it read as the card being gutted
      // ("what happened to the Material buttons"). It is inert and says so:
      // dimmed, with a banner, and a press refuses rather than navigating
      // (switching section moves the group body, and the dock is inside it).
      // RESTATED with the close: there is no popover tab strip to keep, so the
      // "stays and reads inert" half is asserted where it now lives — the
      // body head's SECTION ROW, which `composeBlocks` still refuses and the
      // composing CSS still dims. Same contract: the card is not gutted, and
      // what you cannot use says so rather than vanishing.
      o.stepsAside = getComputedStyle(bodyPop.querySelector('.v2-partviz')).display === 'none' &&
        getComputedStyle(bodyPop.querySelector('.v2-pop-foot')).display === 'none' &&
        (() => { const bn = bodyPop.querySelector('.v2-compbanner');
          return !!bn && getComputedStyle(bn).display !== 'none' &&
                 bn.getBoundingClientRect().height > 10; })() &&
        (() => { const gt = bodyPop.querySelector('.v2-pop-head .v2-gototab');
          return !!gt && gt.getBoundingClientRect().height > 0 &&
                 +getComputedStyle(gt).opacity < 0.6; })();
      // A PRESS REFUSES AND EXPLAINS — it used to be hidden, and the Material
      // doors silently did nothing ("clicking the other options does nothing")
      // …driven on the SECTION ROW now: pressing one must neither open a
      // section popover over the dock nor silently do nothing.
      const other = bodyPop.querySelector('.v2-pop-head .v2-gototab');
      if (other) other.click(); await wait(240);
      const tst2 = document.querySelector('.bloops-toast');
      o.refuses = !!other && !document.querySelector('.v2-secpop-wrap') &&
        !!tst2 && /composing/i.test(tst2.textContent);
      o.editorDocked = (() => { const ex = document.getElementById('lane-expander');
        return !!ex && !!ex.closest('.v2-dock') && ex.getBoundingClientRect().height > 200; })();
      // THE COMPOSITION SURFACE LEADS — the per-chord strip is what you write
      // INTO, and it used to sit a whole keyboard (464px) below the fold
      const dk = document.querySelector('.v2-dock');
      const ch = dk && dk.querySelector('.ambient-seedgrid-chords');
      const ky = dk && dk.querySelector('.ambient-seedgrid-dockhost');
      const row0 = ch && ch.querySelector('.sglane-row');
      // THE GRID LEADS, THEN THE SEQUENCE. The strip was put above the keyboard
      // when the dock lived in a ~230px sheet pane, where anything under it was
      // off screen; embedded, the editor is in the page flow and the panel
      // scrolls, so the order is the one Make uses ("why is the sequencer above
      // the grid").
      o.stripLeads = !!ch && !!ky && ky.getBoundingClientRect().top < ch.getBoundingClientRect().top;
      // RESTATED 2026-09-13: the dock lives in ✦ Make, whose pane is clamped to
      // the visible band and SCROLLS — so "already inside the pane's rect" is a
      // claim the design no longer makes. What it was protecting against was a
      // strip that could not be got to at all (464px below the fold in a 230px
      // pane); the claim is REACHABLE, so scroll to it and check it arrives.
      // …and the band is the VIEWPORT's now: the body sheet has no `.v2-pop-pane`
      // (that is the section popover's), because the body holds the drawing and
      // the dock and nothing else. Scroll to it and check it arrives on screen.
      if (row0) row0.scrollIntoView({ block: 'center' });
      const rr = row0 ? row0.getBoundingClientRect() : null;
      o.stripInView = !!rr && rr.height > 10 &&
        rr.bottom > 0 && rr.top < (window.innerHeight || 780);
      acts.querySelector('.v2-gcancel').click(); await wait(600);
    }
    o.exited = !document.querySelector('.v2-layer.v2-composing');
    o.vizBack = (() => { const v = document.querySelector('.v2-pop .v2-partviz');
      return !!v && getComputedStyle(v).display !== 'none'; })();
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    card().classList.remove('collapsed');
    return o;
  });
  // …AND THERE IS ALWAYS A SEQUENCER TO WRITE INTO. The real lane row is
  // parked off-screen while composing, because the per-chord strip mirrors its
  // chips a few pixels above — but that strip is `hidden` with NO progression,
  // which left the dock as a keyboard, four buttons and nothing showing the
  // sequence ("where is the sequencer for the run being composed?"). Parked
  // only while the thing that mirrors it is there.
  const seqRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const open = async () => {
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(260);
      card().classList.remove('collapsed');
      // ▦ Compose is one press in the row above the drawing (2026-09-14)
      card().querySelector('.v2-gridbtn').click();
      await wait(800);
    };
    const meas = () => {
      const q = (sel) => { const e = card().querySelector(sel);
        return e ? Math.round(e.getBoundingClientRect().height) : -1; };
      const chips = card().querySelectorAll('.ambient-seedgrid-striphost .lane-chips .seq-step').length;
      const ch = card().querySelector('.ambient-seedgrid-striphost .lane-chips');
      return { strip: q('.ambient-seedgrid-striphost'), chords: q('.ambient-seedgrid-chords'),
               chips, op: ch ? +getComputedStyle(ch).opacity : -1 };
    };
    // NO PROGRESSION — the lane strip IS the sequencer
    delete E.getCfg().prog; E.getCfg();
    await open();
    const bare = meas();
    const gc = card().querySelector('.v2-gacts .v2-gcancel'); if (gc) gc.click(); await wait(600);
    // WITH a progression — the per-chord strip takes over and the row parks,
    // so the chips are never drawn twice
    E.getCfg().prog = { on: true, name: 'SQ',
      chords: [0, 5, 7].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    E.getCfg();
    await open();
    const withProg = meas();
    const gc2 = card().querySelector('.v2-gacts .v2-gcancel'); if (gc2) gc2.click(); await wait(600);
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(220);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return { bare, withProg };
  });
  ok('composing always shows the sequence — the lane strip when there are no changes, the per-chord strip when there are',
    seqRun.bare.strip > 40 && seqRun.bare.chips > 0 && seqRun.bare.op === 1 &&
    seqRun.withProg.chords > 40 && seqRun.withProg.strip === 0,
    JSON.stringify(seqRun));

  ok('composing takes the editor — grid first, tabs inert but present, actions reachable, restores on exit',
    compRun.composing && compRun.started && compRun.fullScreen && compRun.actsPinned &&
    compRun.doneHit && compRun.stepsAside && compRun.refuses && compRun.editorDocked &&
    compRun.exited && compRun.vizBack && compRun.stripLeads && compRun.stripInView,
    JSON.stringify(compRun));
  // A SECTION IS MODAL, SO WHAT IT OPENS MUST BE REACHABLE (2026-09-13, user:
  // "major bugs with Make popover; z-index issue when clicking Written,
  // nothing works right, grid doesn't show, roll doesn't show"). Three
  // symptoms, one structural fact: the Material doors live INSIDE ✦ Make and
  // every surface they act on lives OUTSIDE it. Measured — the ✎ Written menu
  // is an `.sm-overlay` (10300) and the section wrap sat at 10310, so the
  // menu's first button hit-tested to `.v2-pop-tab`; and `.v2-partviz` stays
  // in the card body, so the roll hit-tested to `.v2-secpop-scrim` while the
  // dock opened 333×464 entirely behind the modal.
  // ASSERTED BY HIT-TEST, NEVER BY THE Z NUMBER — a bigger number proves
  // nothing about what is under the finger (the documented `.ctx-menu` rule).
  const secDoorRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    // SNAPSHOT THE WHOLE LAYER, not the fields I remember touching — ✎ Written
    // captures the take (kind flips to recorded) and `openRoll` also sets the
    // DRAW mode, which lives in a module Map and is not in `part` at all. The
    // first cut restored `part` alone and took out three downstream checks
    // (the documented one-page-one-state trap).
    const svLayer = JSON.stringify(L());
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const o = {};
    const hits = (el) => { if (!el) return false;
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return t === el || el.contains(t); };
    const fresh = async () => {
      L().part.kind = 'live'; E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(260);
      card().classList.remove('collapsed');
      const gt = [...card().querySelectorAll('.v2-gototab')].find((x) => /^Generate$/i.test(x.textContent));
      if (gt) gt.click(); await wait(320);
      return !!card().querySelector('.v2-secpop-wrap');
    };
    // ── a door pressed from inside ✦ Make must hand off to the CARD
    o.makeOpen = await fresh();
    const wb = card().querySelector('.v2-gridbtn');
    o.doorOnCard = !!(wb && !(card().querySelector('.v2-secpop-wrap') || { contains: () => false }).contains(wb));
    // ── …and it lands you ON the dock, not behind the modal
    if (wb) wb.click(); await wait(800);
    const dk = card().querySelector('.v2-dock');
    o.grid = { session: (typeof _bloomGridEdit !== 'undefined' && _bloomGridEdit) ? _bloomGridEdit.key : null,
      secClosed: !card().querySelector('.v2-secpop-wrap'),
      // the dock is on the always-visible surface, not in a group nobody opened
      onBody: !!(dk && dk.closest('.v2-pop-wrap')),
      h: dk ? Math.round(dk.getBoundingClientRect().height) : 0 };
    const ex = document.getElementById('lane-expander');
    if (ex) { const r = ex.getBoundingClientRect();
      o.grid.top = Math.round(r.top);
      o.grid.inBand = r.top > -1 && r.top < (window.innerHeight || 780) * 0.5;
      o.grid.reach = [0.2, 0.5, 0.8].every((f) => {
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
        return !!t && ex.contains(t); }); }
    try { if (typeof _ambGridEditStop === 'function') _ambGridEditStop(true); } catch (e) {}
    await wait(350);
    // ── and ✎ Draw, which is a MODE in the same row, leaves the drawing reachable
    await fresh();
    const mp0 = card().querySelector('.v2-modepick');
    if (mp0) { mp0.value = 'draw';
      mp0.dispatchEvent(new Event('input', { bubbles: true }));
      mp0.dispatchEvent(new Event('change', { bubbles: true })); }
    await wait(380);
    const sx = card().querySelector('.v2-secpop-close'); if (sx) sx.click();
    await wait(400);
    const cv = card().querySelector('.v2-partviz .v2-vizcv');
    o.roll = { secClosed: !card().querySelector('.v2-secpop-wrap'), canvasHit: hits(cv) };
    try {
      const cur = L(), was = JSON.parse(svLayer);
      Object.keys(cur).forEach((k) => { if (!(k in was)) delete cur[k]; });
      Object.keys(was).forEach((k) => { cur[k] = was[k]; });
      E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      card().classList.remove('collapsed');
      // …and the view MODE back to the default, through its own control —
      // it is module state, so no config restore can reach it
      const mp = card().querySelector('.v2-modepick');
      if (mp && mp.value !== 'view') { mp.value = 'view';
        mp.dispatchEvent(new Event('input', { bubbles: true }));
        mp.dispatchEvent(new Event('change', { bubbles: true })); await wait(220); }
      o.restored = { kind: L().part.kind, mode: (card().querySelector('.v2-modepick') || {}).value };
    } catch (e) { o.restoreErr = String(e && e.message); }
    return o;
  });
  // THE DRAWING FOLDS AWAY (2026-09-13, user: "visualizer should be able to be
  // shown/hidden"). It is the tallest thing on the card — measured 315px of a
  // 729px card at 390px — and is in the way while you are turning knobs.
  // WHAT MUST SURVIVE THE FOLD is the whole point: 🎲 New take, ✎ Write it
  // down, 💾 Save and ✨ Transform live on the take bar and NOWHERE else, so
  // folding them away would make four actions unreachable (rule 6 in reverse);
  // and the readout is the only place the card answers the LIVE ⟷ SAME EVERY
  // PASS question. What must NOT survive is a hint telling you to tap a picture
  // that is not there.
  const vizFoldRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const hits = (sel) => { const e = card().querySelector(sel); if (!e) return 'missing';
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return 'zero';
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return (t === e || e.contains(t)) ? 'ok' : 'covered'; };
    const vis = (sel) => { const e = card().querySelector(sel);
      return !!e && e.getBoundingClientRect().height > 0; };
    const tog = () => card().querySelector('.v2-viztog');
    const snap = () => ({ face: tog() ? tog().textContent.trim() : null,
      title: tog() ? tog().title : '',
      vizH: Math.round((card().querySelector('.v2-partviz') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
      cardH: Math.round(card().getBoundingClientRect().height),
      canvas: vis('.v2-vizcv'), nav: vis('.v2-vnav'), mode: vis('.v2-modesel'), grid: vis('.v2-gridsel'),
      readout: vis('.v2-vizlab'), tail: ((card().querySelector('.v2-vizlab') || {}).textContent || ''),
      newtake: hits('.v2-newtake'), capture: hits('.v2-capture'), togHit: hits('.v2-viztog') });
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    card().classList.remove('collapsed'); await wait(180);
    const o = { door: !!tog() };
    o.shown = snap();
    tog().click(); await wait(320);
    o.hidden = snap();
    // a card REBUILD must not lose it — the state is a module Map, and every
    // commit on this card rebuilds
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    card().classList.remove('collapsed'); await wait(150);
    o.rebuilt = snap();
    card().querySelector('.v2-viztog').click(); await wait(320);
    o.back = snap();
    return o;
  });
  // THE CHROME SITS ABOVE THE PICTURE, IN ONE ROW (2026-09-13, user: "move all
  // of these controls above the visualization… reduce white space and text,
  // make buttons/dropdowns orderly and logically grouped"). It was FOUR stacked
  // lines UNDERNEATH the drawing — nav, fold toggle, readout, then Mode · Grid ·
  // form — measured 153px of chrome against a 79px canvas, nearly twice the
  // picture. One wrapping row now, in a left-to-right progression: WHETHER you
  // see it → WHICH picture → WHAT A TAP DOES → WHAT EDITS SNAP TO → WHERE YOU
  // ARE LOOKING. The clause with teeth is the ORDER and the position: a control
  // drifting back under the canvas is exactly what regresses quietly.
  const vizHeadRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng;
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    card().classList.remove('collapsed'); await wait(180);
    const viz = card().querySelector('.v2-partviz');
    const hd = viz.querySelector('.v2-vizhead');
    const cv = viz.querySelector('.v2-vizcv');
    const lab = viz.querySelector('.v2-vizlab');
    const R = (e) => e ? e.getBoundingClientRect() : null;
    const o = { head: !!hd, order: [...hd.children]
      .map((e) => (e.className || e.tagName).toString().split(' ')
        .filter((c) => c.indexOf('v2-') === 0 || c === 'ambient-regen')[0] || e.tagName) };
    // ABOVE the picture, and so is the readout
    o.headAboveCanvas = R(hd).bottom <= R(cv).top + 1;
    o.labAboveCanvas = R(lab).bottom <= R(cv).top + 1;
    // …and NOTHING that used to live under it is still under it
    o.nothingBelow = ['.v2-vnav', '.v2-modesel', '.v2-gridsel', '.v2-formseg']
      .every((sel) => { const e = viz.querySelector(sel);
        return !e || R(e).top < R(cv).top + 1; });
    o.headH = Math.round(R(hd).height);
    o.chromeH = Math.round(R(hd).height + R(lab).height);
    o.canvasH = Math.round(R(cv).height);
    // the word labels are gone — the Mode option carries its own icon
    o.noWordLabels = !/\bMode\b/.test(hd.textContent) && !/\bGrid\b/.test(hd.textContent);
    // every control in the row is reachable and nothing spills
    const ctl = [...hd.querySelectorAll('button,select')]
      .filter((e) => getComputedStyle(e).display !== 'none');
    o.shown = ctl.length;
    o.bad = ctl.map((e) => { e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return 'zero';
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return (t === e || e.contains(t)) ? null : 'covered'; }).filter(Boolean);
    const vr = R(viz);
    o.spill = [...viz.querySelectorAll('*')].filter((e) => { const r = R(e);
      return r.height > 0 && (r.right > vr.right + 1 || r.left < vr.left - 1); }).length;
    return o;
  });
  ok('the drawing’s chrome is ONE row above the picture, in order, with no word labels',
    vizHeadRun.head && vizHeadRun.headAboveCanvas && vizHeadRun.labAboveCanvas &&
    vizHeadRun.nothingBelow &&
    // whether → which → what a tap does → what edits snap to → where you look
    JSON.stringify(vizHeadRun.order) ===
      // ⌫ Clear right of the 👁 View picker since 2026-09-16 — what a tap does,
      // then the way to an empty part to tap into
      JSON.stringify(['v2-viztog', 'v2-formseg', 'v2-gridbtn', 'v2-modesel', 'v2-clearpart', 'v2-gridsel', 'v2-vnav']) &&
    vizHeadRun.noWordLabels &&
    // it was 153px of chrome against a 79px canvas — a watchdog, not a target
    vizHeadRun.chromeH < vizHeadRun.canvasH * 1.6 &&
    vizHeadRun.shown >= 6 && vizHeadRun.bad.length === 0 && vizHeadRun.spill === 0,
    JSON.stringify(vizHeadRun));

  ok('the drawing folds away — the picture and its navigation go, the take bar and the readout stay',
    vizFoldRun.door &&
    // RESTATED: the face names the ACTION the press performs — Hide while the
    // drawing is showing, Show while it is hidden. The card's usual rule (put
    // the FEATURE'S name on the face) is deliberately carved out for a
    // disclosure toggle attached to the thing it hides; what still has to hold
    // is that the two states are DISTINGUISHABLE and each says what a press does.
    /Hide/.test(vizFoldRun.shown.face) && /Show/.test(vizFoldRun.hidden.face) &&
    vizFoldRun.shown.face !== vizFoldRun.hidden.face &&
    // …and the title still names WHAT is shown, for the state where the face cannot
    /drawing/i.test(vizFoldRun.shown.title) && /drawing/i.test(vizFoldRun.hidden.title) &&
    // it actually saves the card's tallest block
    vizFoldRun.hidden.vizH < vizFoldRun.shown.vizH * 0.6 &&
    vizFoldRun.hidden.cardH < vizFoldRun.shown.cardH - 100 &&
    // the picture and everything that only makes sense beside it
    vizFoldRun.shown.canvas && !vizFoldRun.hidden.canvas &&
    vizFoldRun.shown.nav && !vizFoldRun.hidden.nav &&
    vizFoldRun.shown.mode && !vizFoldRun.hidden.mode &&
    vizFoldRun.shown.grid && !vizFoldRun.hidden.grid &&
    // …and NOT the four actions that live nowhere else, nor the one readout
    // that answers LIVE ⟷ SAME EVERY PASS ('Static' until 2026-09-16, when
    // that word went to the STATE and this axis took its own)
    vizFoldRun.hidden.newtake === 'ok' && vizFoldRun.hidden.capture === 'ok' &&
    vizFoldRun.hidden.togHit === 'ok' && vizFoldRun.hidden.readout &&
    /^(FIXED|LIVE)\b/.test(vizFoldRun.hidden.tail) &&
    // a hint may not name a surface that is off screen
    /tap a/.test(vizFoldRun.shown.tail) && !/tap a/.test(vizFoldRun.hidden.tail) &&
    // survives a rebuild, and comes back exactly
    !vizFoldRun.rebuilt.canvas && vizFoldRun.rebuilt.cardH === vizFoldRun.hidden.cardH &&
    vizFoldRun.back.canvas && vizFoldRun.back.cardH === vizFoldRun.shown.cardH,
    JSON.stringify(vizFoldRun));

  ok('a door inside ✦ Generate reaches its surface — ▦ Compose lands on the dock, not behind the modal',
    secDoorRun.makeOpen && secDoorRun.doorOnCard &&
    secDoorRun.grid.session === 'v2:1' && secDoorRun.grid.secClosed &&
    secDoorRun.grid.onBody && secDoorRun.grid.h > 200 &&
    secDoorRun.grid.inBand && secDoorRun.grid.reach &&
    secDoorRun.roll.secClosed && secDoorRun.roll.canvasHit,
    JSON.stringify(secDoorRun));
  // A DERIVED PART NAME IS RECOMPUTED, NEVER REMEMBERED. A part picked from
  // the catalogue is named by its numerals, which is a DESCRIPTION of chords —
  // so the moment one is added or removed the stored string lies (reported: a
  // 5-chord part named with 4 numerals). An AUTHORED name is never touched.
  const nameRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, cfg = E.getCfg();
    const svProg = cfg.prog ? JSON.parse(JSON.stringify(cfg.prog)) : null;
    const svKey = { on: cfg.keyOn, root: cfg.keyRoot, scale: cfg.keyScale };
    const mk = (rt, iv) => ({ root: rt, intervals: iv || [0, 4, 7] });
    cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'major';
    cfg.prog = { on: true, name: 'x',
      chords: [mk(0), mk(2, [0, 3, 7]), mk(4, [0, 3, 7]), mk(5), mk(7),
               mk(0, [0, 4, 7, 11]), mk(9, [0, 3, 7, 10]), mk(2, [0, 3, 7, 10]), mk(7, [0, 4, 7, 10])],
      // both names are one numeral SHORT of their chords — the reported state
      parts: [{ name: 'I — II — III — I', len: 5 }, { name: 'Imaj7 — VI7 — II', len: 4 }] };
    E.getCfg();
    const cnt = (pi) => { const r = (_ambGridRanges(E.getCfg()) || []).find(x => x.pi === pi);
      return r ? (r.len | 0) : 0; };
    const nm = (pi) => _ambPartLabel(E.getCfg(), pi);
    const o = { p0: nm(0), p1: nm(1), c0: cnt(0), c1: cnt(1) };
    // RESTATED 2026-09-09: every label LEADS WITH ITS PART NUMBER ("1 · …"), so
    // the body is what this check has always been about — strip the ordinal
    // rather than splitting through it (which passed by accident, the prefix
    // riding along as the first numeral).
    const body = (t) => String(t).replace(/^\d+ \u00b7 /, '');
    o.b0 = body(o.p0); o.b1 = body(o.p1);
    o.numbered = /^1 \u00b7 /.test(o.p0) && /^2 \u00b7 /.test(o.p1);
    o.matches = o.b0.split(' — ').length === o.c0 && o.b1.split(' — ').length === o.c1;
    // an AUTHORED name is returned verbatim, after its number
    E.getCfg().prog.parts[0].name = 'Verse'; E.getCfg();
    o.authored = nm(0) === '1 \u00b7 Verse';
    // …and a derived one FOLLOWS an edit
    E.getCfg().prog.parts[0].name = 'I — II — III — I';
    const c2 = E.getCfg(); c2.prog.chords.splice(5, 0, mk(9, [0, 3, 7])); c2.prog.parts[0].len = 6;
    E.getCfg();
    o.after = nm(0);
    o.grew = body(o.after).split(' — ').length === cnt(0);
    // ── EVERY PART LEADS WITH ITS NUMBER ────────────────────────────────
    // The ordinal is the identifier: a part's name is usually the DERIVED
    // numerals of its chords, which describes the harmony and identifies
    // nothing, and in the Content head's selector it is ellipsed to a few
    // glyphs — so the number goes FIRST or it is the first thing cut. One
    // labeller, ~26 display consumers, so all four cases are pinned here.
    const cf = E.getCfg();
    cf.prog.parts[0].name = 'Verse';
    cf.prog.parts[1].name = 'Changes 2';        // the auto-name nobody renamed
    E.getCfg();
    o.numAuthored = nm(0) === '1 \u00b7 Verse';
    // …and the auto-name drops its own digit rather than saying it twice
    o.numGeneric = nm(1) === '2 \u00b7 Changes';
    cf.prog.parts[1].name = 'I — IV — V'; E.getCfg();
    o.numDerived = /^2 \u00b7 /.test(nm(1)) && / — /.test(nm(1));
    // a PART-LESS progression: its own title numbered, or the bare "Part 1"
    const svParts = JSON.stringify(cf.prog.parts);
    delete cf.prog.parts;
    const svPName = cf.prog.name; delete cf.prog.name;   // an authored prog title would be numbered
    E.getCfg();
    o.bareGot = nm(0);
    o.numPartlessBare = nm(0) === 'Part 1';
    E.getCfg().prog.name = 'Neon Nocturne'; E.getCfg();
    o.numPartlessNamed = nm(0) === '1 \u00b7 Neon Nocturne';
    if (svPName == null) delete E.getCfg().prog.name; else E.getCfg().prog.name = svPName;
    E.getCfg().prog.parts = JSON.parse(svParts); E.getCfg();
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    const c3 = E.getCfg(); c3.keyOn = svKey.on; c3.keyRoot = svKey.root; c3.keyScale = svKey.scale;
    E.getCfg();
    return o;
  });
  ok('a derived part name is recomputed from its CURRENT chords; an authored one is left alone',
    nameRun.matches && /I — ii — iii — IV — V/.test(nameRun.p0) && nameRun.authored &&
    nameRun.grew && nameRun.numbered,
    JSON.stringify(nameRun));
  // ── PART COLOURS ────────────────────────────────────────────────────────
  // One hue per part, so a part reads as the SAME part wherever it appears —
  // the current-part strip, the ▤ overview cards, the Content head's selector,
  // the ▦ Passes tabs, and the NOTE EVENTS in the roll drawn for it. The
  // palette lives ONLY in the stylesheet and the canvas reads the same
  // `--ptN` custom properties, so this pins that there is one definition:
  // the swatches, the wrap at 8, the stamped surfaces, and the canvas PIXELS
  // following the part. The values are pinned deliberately — they were chosen
  // by a CIELab search (ΔE 80.1 across the first four, ≥24.9 from every state
  // colour, ≥18.7 from every layer-type hue, none in the reserved green band),
  // so changing one should re-run that measurement rather than be a guess.
  const ptRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const svProg = E.getCfg().prog ? JSON.stringify(E.getCfg().prog) : 'null';
    const svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svParts = L().parts ? JSON.stringify(L().parts) : null,
          svAll = L().partAll ? JSON.stringify(L().partAll) : null;
    const mk = (r) => r.map((x) => ({ root: x, intervals: [0, 4, 7] }));
    const o = {};
    const rootCss = getComputedStyle(document.documentElement);
    o.palette = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => rootCss.getPropertyValue('--pt' + i).trim());
    o.paletteOk = o.palette.join(',') ===
      '#479ef5,#f56147,#47f5d2,#ed47f5,#fade9e,#fa9ecc,#b5d5e3,#ca8d72';
    // ONE definition: the canvas half reads those very properties…
    o.fnMatches = _ambPartColor(0) === o.palette[0] && _ambPartColor(3) === o.palette[3];
    // …and a 9th part wraps rather than going colourless
    o.wraps = _ambPartColor(8) === o.palette[0];
    E.getCfg().prog = { on: true, parts: [{ name: 'Verse', len: 5 }, { name: 'Chorus', len: 4 }],
      chords: mk([0, 2, 4, 5, 7, 0, 9, 2, 7]) };
    L().on = true; L().present = true;
    L().part.kind = 'live'; L().part.bars = 5;
    L().part.rhythm = { kind: 'euclid', steps: 20, pulses: 9 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg(); window._v2.partSelect(E, L(), 0); E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    try { _ambSyncFxVis(E); } catch (e) {}
    await wait(260);
    // THE STAMPED SURFACES — the attribute AND the accent it resolves to
    // ONE select carries the CURRENT part's hue now (there is no chip per part
    // to stamp), so the claim is that the accent follows the selection.
    const psel2 = document.querySelector('.ambient-curpart-sel');
    o.chips = psel2 ? [psel2.getAttribute('data-part') + ':' +
      getComputedStyle(psel2).getPropertyValue('--pt').trim()] : [];
    o.chipsOk = !!psel2 && o.chips[0] === '1:' + o.palette[0];
    const off = null;
    o.chipEdgePaints = !!off && /^rgb\(/.test(getComputedStyle(off).borderLeftColor) &&
      getComputedStyle(off).borderLeftColor !== getComputedStyle(off).borderTopColor;
    // RESTATED 2026-09-10: the head's part SELECT is gone (the ⇶ Part strip is
    // the one chooser). The same contract — the head wears the part it is on —
    // lands on the per-part TOGGLE, which is now the only thing on the card
    // that says which part. The COMPUTED border, not just the variable:
    // `.v2-pop-pair .v2-pop-pp.on` is (0,2,0) and sets border-color, so the
    // hue rule has to be compounded past it (the documented cascade trap).
    const sel = () => document.querySelector('.v2-pop-pp.on');
    o.selPart = sel() && sel().getAttribute('data-part');
    o.selBorder = sel() ? getComputedStyle(sel()).borderTopColor : null;
    o.selPaints = o.selBorder === 'rgb(71, 158, 245)';
    // ── THE NOTE EVENTS. Read the CANVAS, not the config: the whole claim is
    // that the picture carries the hue. Needs the card EXPANDED or the canvas
    // is 0×0 and getImageData throws (the documented trap).
    const domi = () => {
      const cv = card().querySelector('.v2-vizcv');
      const g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const t = {};
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
        t[k] = (t[k] || 0) + 1;
      }
      return Object.entries(t).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    };
    const near = (list, hex2) => {
      const n = parseInt(hex2.slice(1), 16);
      const R = (n >> 16) & 255, G = (n >> 8) & 255, B = n & 255;
      return list.slice(0, 8).some((k) => { const [r, g2, b] = k.split(',').map(Number);
        return Math.abs(r - R) <= 2 && Math.abs(g2 - G) <= 2 && Math.abs(b - B) <= 2; });
    };
    o.drawnPi0 = card().querySelector('.v2-vizcv')._drawnPi;
    const px0 = domi();
    o.notesArePart1 = near(px0, o.palette[0]) && !near(px0, o.palette[1]);
    // SWITCH THE EDITED PART — the notes must take the other part's hue
    window._v2.partSelect(E, L(), 1); E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(360);
    card().classList.remove('collapsed');
    await wait(220);
    o.drawnPi1 = card().querySelector('.v2-vizcv')._drawnPi;
    const px1 = domi();
    o.notesArePart2 = near(px1, o.palette[1]) && !near(px1, o.palette[0]);
    o.selFollows = sel() && sel().getAttribute('data-part') === '2';
    // A LAYER THAT IS NOT PER-PART has no part identity for its content, so it
    // keeps the default rather than borrowing a hue that would mean nothing.
    const svC = window.confirm; window.confirm = () => true;
    window._v2.partSelect(E, L(), null); E.getCfg(); window.confirm = svC;
    if (h) h._sig = ''; window._v2.render(E); await wait(340);
    card().classList.remove('collapsed');
    await wait(200);
    o.sharedPi = card().querySelector('.v2-vizcv')._drawnPi;
    const px2 = domi();
    o.sharedIsDefault = o.sharedPi === -1 && !near(px2, o.palette[0]) && !near(px2, o.palette[1]);
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svParts) L().parts = JSON.parse(svParts); else delete L().parts;
      if (svAll) L().partAll = JSON.parse(svAll); else delete L().partAll;
      E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; } });
  ok('a part carries ONE hue everywhere — the strip, the selector, and the roll\u2019s note events',
    ptRun && !ptRun.err && ptRun.paletteOk && ptRun.fnMatches && ptRun.wraps &&
    ptRun.chipsOk && ptRun.chipEdgePaints && ptRun.selPart === '1' && ptRun.selPaints &&
    ptRun.drawnPi0 === 0 && ptRun.notesArePart1 &&
    ptRun.drawnPi1 === 1 && ptRun.notesArePart2 && ptRun.selFollows &&
    ptRun.sharedIsDefault,
    JSON.stringify(ptRun));

  ok('every part leads with its NUMBER — authored, derived, auto-named and part-less alike',
    nameRun.numAuthored && nameRun.numGeneric && nameRun.numDerived &&
    nameRun.numPartlessBare && nameRun.numPartlessNamed,
    JSON.stringify({ authored: nameRun.numAuthored, generic: nameRun.numGeneric,
      derived: nameRun.numDerived, partlessBare: nameRun.numPartlessBare,
      partlessNamed: nameRun.numPartlessNamed }));
  // ✨ TRANSFORM — commands over the notes you already have. A registry, so
  // the set grows by one entry; scoped by the bar selection when there is one.
  const tfRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    // A LIVE part has nothing to rework — the button is still PRESENT (a
    // control you cannot find is a control you do not have) and REFUSES with
    // the condition, the same pattern the no-op rhythm tabs use.
    L().part.kind = 'live'; L().part.bars = 4; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    const o = { present: !!card().querySelector('.v2-tform') };
    card().querySelector('.v2-tform').click(); await wait(300);
    const t1 = document.querySelector('.bloops-toast');
    o.liveRefuses = !!t1 && /Write it down/.test(t1.textContent) && !document.querySelector('.ctx-menu');
    // a deterministic fixture — a random roll's durations make exactness hard
    // to read, and the transforms are EXACT (documented flake lesson)
    L().part.kind = 'recorded';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.25, midi: 62, dur: 0.1 },
                      { t: 0.5, midi: 64, dur: 0.1 }, { t: 0.75, midi: 67, dur: 0.1 }];
    E.getCfg();
    const snap = () => (L().part.notes || []).map(n => Math.round(n.t * 1000) + ':' + n.midi).join(' ');
    const a0 = snap();
    // REVERSE is an exact retrograde, so doing it TWICE is the identity —
    // the strongest statement available and independent of note order
    window._v2.transform(E, L(), 'reverse', null);
    o.reversedMoved = snap() !== a0;
    window._v2.transform(E, L(), 'reverse', null);
    o.involution = snap() === a0;
    // SHUFFLE keeps the rhythm and the pitch multiset (it moves pitches
    // BETWEEN the onsets the part already has)
    const pit = (s2) => s2.split(' ').map(x => x.split(':')[1]).sort().join(',');
    const ons = (s2) => s2.split(' ').map(x => x.split(':')[0]).join(',');
    const b0 = snap();
    window._v2.transform(E, L(), 'shuffle', null);
    const s1 = snap();
    o.shuffleKeepsRhythm = ons(s1) === ons(b0) && pit(s1) === pit(b0);
    o.stamped = L().part.tf === 'shuffle';
    // SCOPED to the tapped bars: every other bar is untouched
    L().part.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.26, midi: 62, dur: 0.05 },
                      { t: 0.36, midi: 63, dur: 0.05 }, { t: 0.75, midi: 67, dur: 0.1 }];
    E.getCfg();
    window._v2.transform(E, L(), 'reverse', [1]);
    const sc = snap().split(' ');
    o.scoped = sc[0] === '0:60' && sc[3] === '750:67' && sc[1] !== '260:62';
    // …and a transformed take counts as WORK: the keep gate names it as such
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    const g = window.__gatePeek(card().querySelector('.v2-newtake')); await wait(300);
    o.replaceAsks = !!g && /Save it to the bank/.test((g.btns || []).join('|'));
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; delete L().part.tf; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    card().classList.remove('collapsed');
    return o;
  });
  // A RECORD FILED UNDER A PART IS THAT PART'S LENGTH — reconciled on EVERY
  // normalize, not only when the record is first materialised. Fitting once
  // left the edited record at whatever length it had when per-part was
  // engaged: a 1-bar cycle under a 5-bar part, repeating five times, with the
  // ruler showing one bar (reported twice). The RESIZE is the whole check —
  // an engage-time fit passes any test that never moves the part afterwards.
  const fitRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svAll = L().partAll ? JSON.stringify(L().partAll) : null;
    c0.prog = { on: true,
      chords: [0, 2, 4, 5, 7, 9, 11, 1].map((r) => ({ root: r, intervals: [0, 4, 7] })),
      parts: [{ name: 'A', len: 5 }, { name: 'B', len: 3 }] };
    E.getCfg();
    L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 1;
    E.getCfg();
    const o = { everywhere: L().part.bars };          // untouched while shared
    window._v2.partSelect(E, L(), 0); E.getCfg();
    o.onEngage = L().part.bars;                        // fitted to part A
    o.filed = L().parts && L().parts['1'] ? L().parts['1'].bars : null;
    // NOW MOVE THE PART. This is what the engage-time fit cannot answer.
    E.getCfg().prog.parts[0].len = 4; E.getCfg().prog.parts[1].len = 4;
    E.getCfg();
    o.afterResize = L().part.bars;
    o.filedAfter = L().parts && L().parts['1'] ? L().parts['1'].bars : null;
    // …and a hand-set length loses to the reconciler, so the Bars control has
    // to say it is bound rather than sit there losing (the dead-control rule)
    L().part.bars = 2; E.getCfg();
    o.handSetLoses = L().part.bars === o.afterResize;
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    window.__sec('Time'); await wait(320);
    const bt = document.querySelector('.v2-pop-tabs [data-tab="Bars"]');
    if (bt) bt.click(); await wait(180);
    const badge = document.querySelector('.v2-pop-pane .ambient-loop-badge');
    o.saysBound = !!badge && /\u00d7 part/.test(badge.textContent) &&
      !document.querySelector('.v2-pop-pane [data-f="part.bars"]');
    await wait(180);
    // disengaging brings the ICE back at ITS own length, not the part's
    window._v2.partSelect(E, L(), null); E.getCfg();
    o.iceBack = L().part.bars;
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svAll) L().partAll = JSON.parse(svAll); else delete L().partAll;
      if (L().parts) delete L().parts;
      E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) { o.err = e.message; }
    return o;
  });
  ok('a per-part record IS its part\'s length, and follows when the part is resized',
    fitRun.everywhere === 1 && fitRun.onEngage === 5 && fitRun.filed === 3 &&
    fitRun.afterResize === 4 && fitRun.filedAfter === 4 && fitRun.handSetLoses &&
    fitRun.saysBound && fitRun.iceBack === 1,
    JSON.stringify(fitRun));

  // ⛰ GROUNDWORK — the part that PLAYS THE CHANGES instead of a figure over
  // them: one onset on the 1 and one on every change, held until the next.
  const gwRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), svPart = JSON.stringify(L().part);
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    const svClk = [E._playStartAt, E._progAnchor, E._barGridAnchor];
    c0.prog = { on: true, parts: [],
      chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
               { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }] };
    c0.keyOn = true; c0.keyRoot = 0; c0.keyScale = 'major'; c0.keyFollow = false;
    E.getCfg();
    // a stale anchor clamps every chord lookup to chord 0 (documented), which
    // would make "one onset per change" pass with one chord repeated
    E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
    L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 4;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    // RESTATED 2026-09-09: Groundwork is the FIFTH SHAPE in the ⚙ Generated
    // panel (its own door and draft-panel are gone) — entered through the
    // same confirm flow as every shape, tuned by gated rows in the shared
    // panel. Every musical contract below is unchanged.
    const svCf9 = window.confirm; window.confirm = () => true;
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(300);
    const o = { door: !!card().querySelector('.v2-shapepop .v2-mkpart[data-mk="ground"]') };
    const wasRhythm = L().part.rhythm.kind;
    card().querySelector('.v2-shapepop .v2-mkpart[data-mk="ground"]').click(); await wait(500);
    card().classList.remove('collapsed');
    // the per-change overlay has its own Fine-tune tab since 2026-09-21 (it was
    // on "Repeats", where a whole second voice read as hidden)
    { const tb = card().querySelector('.v2-shapepop .v2-fttab[data-ft="accomp"]');
      if (tb && !card().classList.contains('v2-ftt-accomp')) { tb.click(); await wait(220); } }
    const r = card().querySelector('.v2-shapepop').getBoundingClientRect();
    o.onScreen = r.width > 0 && r.height > 0 && r.top >= 40 && r.bottom <= innerHeight + 1;
    o.noUseButton = document.querySelectorAll('.v2-layer .v2-mkground').length === 0;
    o.adoptedOnOpen = L().part.rhythm.kind === 'ground' && wasRhythm !== 'ground';
    o.rhythm = L().part.rhythm.kind; o.mat = L().part.mat;
    o.holds = (L().part.shape.lenRatio | 0) >= 100;
    // ONE ONSET PER CHANGE, each playing THAT chord — the whole claim
    const grab = () => {
      const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: 8 })) || [];
      const by = {};
      ns.forEach((n) => { const t = (Math.round(n.at * 100) / 100).toFixed(2);
        (by[t] = by[t] || []).push(((Math.round(69 + 12 * Math.log2(n.freq / 440)) % 12) + 12) % 12); });
      return by;
    };
    const g1 = grab();
    const times = Object.keys(g1).sort((a, b) => +a - +b);
    o.onsets = times.length;
    o.onTheChanges = times.join(',') === '0.00,2.00,4.00,6.00';
    // each onset's notes belong to the chord sounding there
    o.inChord = times.every((t) => {
      const ch = _ambProgSoundAt(E, E.getCfg().prog, _ambProgStepAt(E, +t));
      const pcs = ch ? ch.intervals.map((i) => (((ch.root + i) % 12) + 12) % 12) : [];
      return g1[t].every((m) => pcs.indexOf(m) >= 0);
    });
    o.threeEach = times.every((t) => g1[t].length === 3);
    // PER CHANGE — one cell per chord, and a tap changes only that change
    const cells = () => [...document.querySelectorAll('.v2-layer .v2-gwcell')];
    o.cells = cells().length;
    // A REAL ± STEPPER. It was a tap-to-cycle button, which can only go UP —
    // nine taps to go from 4 to 3, reported as a bug and it was one. The value
    // lives in a MAP, and `setPath` creates intermediates, so a map key is an
    // ordinary field path driven by the shared ± delegation.
    o.hasSteppers = cells()[1].querySelectorAll('.ambient-step-btn').length === 2;
    // SHAPE OF THE PANEL — reported as "this UI is junk". The compact
    // micro-stepper rules are scoped to `.v2-pop-pane` and this panel is not
    // inside one, so every cell fell back to the sheet's 60px touch stepper
    // and STACKED: 114px cells, a 728px panel filling the screen. Pinned on
    // the two things that produce that — a cell is ONE LINE (name and ± side
    // by side) and the panel needs no scrolling of its own.
    const pop = card().querySelector('.v2-shapepop');
    const pr2 = pop.getBoundingClientRect();
    o.popH = Math.round(pr2.height);
    // no inner-scroll clause any more: the SHARED panel holds five shapes
    // plus every gated row, and scrolling it is legitimate
    o.popFits = pr2.top >= 0 && pr2.bottom <= innerHeight + 1;
    o.cellOneLine = cells().every((c) => {
      const cr = c.getBoundingClientRect(); if (cr.height > 72) return false;
      const n = c.querySelector('.v2-gwcn'), b = c.querySelector('.ambient-step-btn'),
            v = c.querySelector('.ambient-step-inp');
      if (!n || !b || !v) return false;
      const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect(),
            vr = v.getBoundingClientRect();
      // the name is READABLE (it collapsed to 0 when it shared the line)…
      if (nr.width < 14 || !n.textContent.trim()) return false;
      // …and the stepper is still the COMPACT one, ± beside the value
      return br.height <= 40 && vr.left >= br.right - 1 &&
             br.top < vr.bottom && vr.top < br.bottom;
    });
    o.cellH = Math.round(cells()[0].getBoundingClientRect().height);
    // the grid takes the row, with its label ABOVE it — it was stranded in the
    // 60px label gutter beside the cells
    const gl = card().querySelector('.v2-gwparts > label');
    const gg = card().querySelector('.v2-gwpartshost');
    o.gridFullWidth = !!(gl && gg) &&
      gl.getBoundingClientRect().bottom <= gg.getBoundingClientRect().top + 1 &&
      gg.getBoundingClientRect().width > pr2.width * 0.8;
    // ONE line of prose, not two paragraphs saying the same thing.
    // RESTATED TWICE, same contract both times. (1) the dead .v2-gwsays copy
    // went with the old panel. (2) 2026-09-09: the STATIC `.v2-genmodel`
    // paragraph is gone too — it stated the RHYTHM x PITCH model in prose,
    // which the panel's first two ROWS now state as controls, and a static
    // paragraph is noise on every visit after the first (44px of a 617px
    // panel, measured). So the claim is: ZERO static paragraphs, exactly one
    // LIVE line, and the model still stated — by the two axis selects.
    o.onePara = pop.querySelectorAll('.v2-genmodel').length === 0 &&
                pop.querySelectorAll('.v2-gensays').length === 1 &&
                document.querySelectorAll('.v2-layer .v2-gwsays').length === 0 &&
                !!pop.querySelector('.v2-genrows [data-f="part.rhythm.kind"]') &&
                !!pop.querySelector('.v2-genrows [data-f="part.pitch.kind"]');
    // CAPTURE THE BUTTON ONCE and press it twice — which is what a finger
    // does. Re-querying between presses hides the real bug: the panel's own
    // sync rewrote the grid on every commit, so the second press landed on a
    // detached node and two taps moved the number by one. A probe that
    // re-queries passes either way (the poison proved it).
    const up = cells()[1].querySelector('.ambient-step-up');
    up.click(); await wait(150); up.click(); await wait(250);
    o.afterUp = JSON.stringify((L().part.ground || {}).chords || null);
    o.buttonSurvives = document.contains(up);
    const dn = cells()[1].querySelector('.ambient-step-dn');
    dn.click(); await wait(250);
    o.stored = JSON.stringify((L().part.ground || {}).chords || null);
    // …and it can come DOWN, which is the whole complaint
    o.goesDown = o.afterUp === '{"1":{"voices":5}}' && o.stored === '{"1":{"voices":4}}';
    const g2 = grab();
    o.onlyThatChange = g2['2.00'].length === 4 && g2['0.00'].length === 3 && g2['4.00'].length === 3;
    o.cellMarked = cells()[1].classList.contains('own') && !cells()[0].classList.contains('own');
    // THE DRAWING MUST NOT MOVE ON A PREVIEW. Preview anchored at `now`, so a
    // part whose content IS the changes landed on a different point of the
    // progression every press — reported as "it keeps making a new part".
    // MEASURE WHAT THE DRAWING DRAWS — `notesFor` at the PREVIEW'S OWN anchor,
    // which is what `drawPartViz` uses. A fixed `cycleStart` never moves, so a
    // check written that way passes with or without the pin (the poison proved
    // it). And a REAL PLAY leaves the clocks set, which is the state the bug
    // needs: with them null the old code pinned anyway.
    E._barGridAnchor = 12.5; E._progAnchor = 12.5; E._playStartAt = 12.5;
    // READ THE DRAWING ITSELF — the label under it names the note count, which
    // is exactly what the user watches change. Computing notes at a fixed
    // anchor never moves and passes either way (that poison), and reading them
    // at the PREVIEW's anchor is not what the drawing does for a ground part.
    // WHERE THE PICTURE WAS DRAWN FROM. The note COUNT cannot answer this —
    // rotating a progression leaves the total identical, so a count-based
    // check passed with the fix removed. The canvas records its own anchor.
    const drawn = () => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      return (cv && Number.isFinite(cv._cs)) ? cv._cs.toFixed(3) : '?';
    };
    // ONE preview to set the remembered anchor, then MOVE THE CLOCK between
    // reads. Two presses 140 ms apart land on the same chord and cannot tell
    // the fix from the bug (that poison passed); a user's presses are seconds
    // apart, and moving the chord origin is the same thing without the wait.
    try { window._v2.preview(E, L()); } catch (e) {}
    await wait(160);
    try { window._v2.previewKill(E, L()); } catch (e) {}
    const readAt = async (anchor) => {
      E._progAnchor = anchor; E._barGridAnchor = anchor; E._playStartAt = anchor;
      const hh = document.getElementById('bloom-v2-layers');
      if (hh) hh._sig = '';
      window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
      return drawn();
    };
    // …and it must be the CHANGES' own origin, not the press. Moving the chord
    // origin must move the drawing WITH it (so it still starts on change 1),
    // which is exactly what a preview-anchored drawing does not do.
    const s1 = await readAt(12.5), s2 = await readAt(13.1), s3 = await readAt(15.7);
    o.shots = [s1, s2, s3].join(' | ');
    o.stableAcrossPreviews = s1 === '12.500' && s2 === '13.100' && s3 === '15.700';
    E._barGridAnchor = null; E._progAnchor = null; E._playStartAt = null;
    // SLIP spreads the notes of an onset; 0 leaves them together
    const together = (by) => Object.keys(by).length;
    o.tightOnsets = together(grab());
    L().part.shape.slip = 60; E.getCfg();
    o.slipOnsets = together(grab());
    o.slipSpreads = o.slipOnsets > o.tightOnsets;
    L().part.shape.slip = 0; E.getCfg();
    o.slipPruned = (L().part.shape.slip === undefined);
    // ✓ Done KEEPS it. (2026-09-16: Quick and Deep are DRAFTS again — ✕ Cancel
    // restores what the part was, and nothing inside them asks first.)
    card().querySelector('.v2-shapepop .v2-gendone').click(); await wait(300);
    o.closed = !card().classList.contains('v2-genopen');
    o.doneKeeps = L().part.rhythm.kind === 'ground';
    o.face = (document.querySelector('.v2-genface') || {}).textContent || '';
    window.confirm = svCf9;
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(svPart); E.getCfg();
      E._playStartAt = svClk[0]; E._progAnchor = svClk[1]; E._barGridAnchor = svClk[2];
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('⛰ Groundwork plays the changes — one onset per change, per-change counts, and slip',
    // RESTATED 2026-09-09: entered through the Generated panel; draft/cancel
    // retired with the old door (the confirm flow protects instead); the
    // face is the Generated door's, naming the shape in force.
    gwRun.door && gwRun.onScreen && gwRun.rhythm === 'ground' && gwRun.mat === 'ground' &&
    gwRun.holds && gwRun.onsets === 4 && gwRun.onTheChanges && gwRun.inChord &&
    gwRun.threeEach && gwRun.cells === 4 && gwRun.stored === '{"1":{"voices":4}}' &&
    gwRun.onlyThatChange && gwRun.cellMarked && gwRun.slipSpreads && gwRun.slipPruned &&
    gwRun.noUseButton && gwRun.adoptedOnOpen && gwRun.hasSteppers && gwRun.goesDown &&
    gwRun.stableAcrossPreviews && gwRun.buttonSurvives && gwRun.doneKeeps &&
    gwRun.closed && /Play the changes/.test(gwRun.face),
    JSON.stringify(gwRun));

  // ◈ THE SEAMLESS-UNIT BADGE IS LIVE (2026-09-14, user: "that 30 number
  // doesn't update when i even out the parts"). It was computed inline in the
  // area strip's HTML and written nowhere else, so it was painted once when
  // the panel was built and then never again — a readout that never re-reads,
  // which is worse than no readout because it is a confident wrong answer.
  //
  // THE FIXTURE TOUCHES ONLY `prog` AND `bars`. A first cut cleared the area's
  // LAYERS and added one, which orphaned every module Map keyed on a layer id
  // (VIEWM, BSEL, the cards) and broke EIGHT downstream checks — a config
  // restore cannot put module state back (the documented rule). The
  // progression alone moves the unit, which is all this needs to prove.
  const unitRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng;
    const o = {};
    const act = () => { const st = _masterBloomState(); return st.areas[st.activeIdx] || null; };
    const a0 = act();
    const svProg = JSON.stringify(a0.prog || null), svBars = a0.bars, svBpc = a0.barsPerChord;
    try {
    const badge = () => { const el = document.querySelector('.ambient-orch-unit');
      return el ? { txt: el.textContent, warn: el.classList.contains('warn'), tip: el.title } : null; };
    const truth = () => _ambAreaLoopBars(E, act()) | 0;
    const sync = async () => { try { _ambSyncControls(E); } catch (e) {} await wait(200); };
    // FIVE CHORDS OF ONE BAR — a 5-bar progression cycle. The unit counts the
    // progression, not only the layers, which is half of why the reported
    // number was surprising.
    a0.prog = { on: true, chords: [0, 5, 7, 9, 2].map((x) => ({ root: x, intervals: [0, 4, 7] })) };
    a0.barsPerChord = 1; a0.bars = 4;
    E.getCfg(); await sync();
    o.t5 = truth(); o.b5 = badge();
    o.countsProg = o.t5 % 5 === 0 && !!(o.b5 && o.b5.txt.indexOf(o.t5 + '-bar unit') >= 0);
    // …and the TIP names both halves, so the number is explainable without
    // reading the source (which is what the question was)
    o.tipNamesBoth = !!(o.b5 && /capturable layers/.test(o.b5.tip) && /progression/.test(o.b5.tip));
    // EVEN IT OUT — 8 chords of one bar. The unit MOVES, which is the report.
    act().prog.chords = [0, 5, 7, 9, 0, 5, 7, 9].map((x) => ({ root: x, intervals: [0, 4, 7] }));
    E.getCfg(); await sync();
    o.t8 = truth(); o.b8 = badge();
    o.tracks = o.t8 !== o.t5 && o.t8 % 8 === 0 &&
               !!(o.b8 && o.b8.txt.indexOf(o.t8 + '-bar unit') >= 0) &&
               o.b8.txt !== (o.b5 || {}).txt;
    // …and the ⚠ IS A FACT ABOUT BARS vs the unit, not a permanent decoration:
    // set Bars to the unit and it clears.
    act().bars = o.t8; E.getCfg(); await sync();
    o.bClean = badge();
    o.warnClears = !!(o.bClean && !o.bClean.warn && /tiles cleanly/.test(o.bClean.tip));
    // …and comes back when Bars no longer tiles it
    act().bars = o.t8 + 1; E.getCfg(); await sync();
    o.bWarn = badge();
    o.warnReturns = !!(o.bWarn && o.bWarn.warn && /NOT a multiple/.test(o.bWarn.tip));
    } catch (e) { o.err = String(e && e.message); }
    finally {
      try {
        const a9 = act();
        if (a9) {
          if (svProg === 'null' || svProg == null) delete a9.prog; else a9.prog = JSON.parse(svProg);
          if (svBars != null) a9.bars = svBars;
          if (svBpc != null) a9.barsPerChord = svBpc; else delete a9.barsPerChord;
          E.getCfg();
          try { _ambSyncControls(E); } catch (e) {}
        }
      } catch (e) {}
    }
    return o;
  });
  ok('◈ the seamless-unit badge is LIVE — it re-reads when the progression or Bars moves',
    !unitRun.err && unitRun.countsProg && unitRun.tracks &&
    unitRun.warnClears && unitRun.warnReturns && unitRun.tipNamesBoth,
    JSON.stringify(unitRun));

  // PER-CHANGE OPERATIONS (2026-09-14, user: "we now need per-chord
  // OPERATIONS, like 'Arpeggiate' … and 'Scale' (condense or expand the part
  // into a percentage of the chord's bars, preserving the relative note event
  // sizes)"). NOT rules: everything else in that panel says how a stretch is
  // GENERATED, and these two say what to do with what came out — so they run
  // in the composite, on the region's own notes, after the roll.
  const opsRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), sv = JSON.stringify(L().part);
    const svKey = [c0.keyOn, c0.keyFollow];
    const o = {};
    try {
    c0.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }] };
    c0.keyOn = false; c0.keyFollow = false;
    const p0 = L().part;
    p0.kind = 'live'; p0.bars = 2; delete p0.notes; delete p0.takeb; delete p0.ruleb;
    p0.rhythm = { kind: 'ground', steps: 8, n: 1 };
    p0.pitch = { kind: 'chord', voices: 3 };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    const c = () => document.querySelector('.v2-layer');
    c().classList.remove('collapsed');
    // AN UNPINNED `notesFor` — the tick's own call. An operation that only
    // showed in the drawing would be no operation at all.
    const ns = () => {
      const L2 = L();
      return (window._v2.notesFor(L2, { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 8 }) || [])
        .slice().sort((a, b) => a.at - b.at);
    };
    const show = () => ns().map((n) => (Math.round(n.at * 100) / 100) + ':' +
      Math.round(69 + 12 * Math.log2(n.freq / 440))).join(' ');
    const setOps = (ob) => { L().part.ruleb = { '0:48': { ops: ob } }; E.getCfg(); };
    o.plain = show();
    // …the region is BAR 1 of two, so onsets at 0 and 2 are inside it and the
    // ones at 4 and 6 are not — an operation must not touch its neighbours.
    const inReg = (str) => str.split(' ').filter((x) => +x.split(':')[0] < 4).length;
    const outReg = (str) => str.split(' ').filter((x) => +x.split(':')[0] >= 4).join(' ');
    o.plainOut = outReg(o.plain);
    // ── ⟳ ARPEGGIATE ─────────────────────────────────────────────────────
    setOps({ arp: 4 });
    o.arp = show();
    o.arpOut = outReg(o.arp);
    o.leavesNeighbours = o.arpOut === o.plainOut;
    // two onsets in the region, four notes each
    o.arpCount = inReg(o.arp) === 8;
    // …and it is a LINE through the chord's tones, not the chord restruck:
    // every arp note is one note, and they step through the three tones.
    o.arpTimes = o.arp.split(' ').filter((x) => +x.split(':')[0] < 4)
      .map((x) => x.split(':')[0]).join(',');
    o.arpSpread = o.arpTimes === '0,0.5,1,1.5,2,2.5,3,3.5';
    const shapeOfTones = (str, lim) => { const t = str.split(' ')
      .filter((x) => +x.split(':')[0] < lim).map((x) => +x.split(':')[1]);
      return t.length ? t.map((m) => m - t[0]).join(',') : ''; };
    o.arpTones = shapeOfTones(o.arp, 2);
    o.arpRunsUp = o.arpTones === '0,4,7,0';
    setOps({ arp: 4, arpDir: 'down' });
    o.arpDown = shapeOfTones(show(), 2);
    o.directionWorks = o.arpDown === '0,-3,-7,0';
    // THE NOTE-EVENT SIZE IS PRESERVED AS A RATIO of its slot — the held chord
    // filled 90% of a 2 s slot, so each 0.5 s arp note fills 90% of 0.5 s.
    setOps({ arp: 4 });
    o.arpDur = ns().filter((n) => n.at < 4).map((n) => n.durMs)[0];
    o.plainDur = (() => { delete L().part.ruleb; E.getCfg();
      const d = ns().filter((n) => n.at < 4).map((n) => n.durMs)[0];
      return d; })();
    o.keepsRatio = Math.abs(o.arpDur - o.plainDur / 4) <= 2;
    // ── ⬡ SCALE ──────────────────────────────────────────────────────────
    // CONDENSE: the same notes, in the front of the change, sizes kept in
    // proportion — which is what "preserving the relative note event sizes"
    // means, one multiplier on both axes.
    setOps({ scale: 50 });
    o.sc50 = show();
    o.condenses = o.sc50.split(' ').filter((x) => +x.split(':')[0] < 4)
      .map((x) => x.split(':')[0]).join(',') === '0,0,0,1,1,1';
    o.sc50Dur = ns().filter((n) => n.at < 4).map((n) => n.durMs)[0];
    o.scalesDur = Math.abs(o.sc50Dur - o.plainDur / 2) <= 2;
    o.sc50Out = outReg(o.sc50);
    o.scaleLeavesNeighbours = o.sc50Out === o.plainOut;
    // EXPAND runs on past the change — that is what expanding is
    setOps({ scale: 150 });
    o.sc150 = show();
    o.expands = /(^| )3:/.test(o.sc150);
    // ── THEY COMPOSE, arpeggio first then placed ─────────────────────────
    setOps({ arp: 4, scale: 50 });
    o.both = show();
    o.composes = inReg(o.both) === 8 &&
      o.both.split(' ').filter((x) => +x.split(':')[0] < 4)
        .map((x) => x.split(':')[0]).join(',') === '0,0.25,0.5,0.75,1,1.25,1.5,1.75';
    // ── ABSENT BY DEFAULT ────────────────────────────────────────────────
    delete L().part.ruleb; E.getCfg();
    o.back = show();
    o.byteIdentical = o.back === o.plain;
    // …and a NEUTRAL operation is not an operation: it is dropped, not stored
    // as a choice, or the row reads "off" while wearing SET HERE.
    L().part.ruleb = { '0:48': { ops: { arp: 0, scale: 100 } } }; E.getCfg();
    o.neutralDropped = !L().part.ruleb;
    // a bogus value is coerced or refused, never carried
    L().part.ruleb = { '0:48': { ops: { arp: 99, arpDir: 'sideways', scale: 5, bogus: 1 } } };
    E.getCfg();
    o.coerced = JSON.stringify(L().part.ruleb) === '{"0:48":{"ops":{"arp":16,"scale":10}}}';
    // …and a direction with nothing to direct says nothing
    L().part.ruleb = { '0:48': { ops: { arpDir: 'down' } } }; E.getCfg();
    o.dirNeedsArp = !L().part.ruleb;
    delete L().part.ruleb; E.getCfg();
    // ── THE ROWS, IN THE PANEL ───────────────────────────────────────────
    if (h) h._sig = ''; window._v2.render(E); await wait(280);
    c().classList.remove('collapsed');
    const cv = c().querySelector('.v2-vizcv'); cv.scrollIntoView({ block: 'center' }); await wait(150);
    const r = cv.getBoundingClientRect(), bg = cv._barsGeo, pgeo = cv._pitchGeo;
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + bg.x0 + (cv.clientWidth - bg.x0) * (0.5 / bg.vbars),
      clientY: r.top + Math.max(3, pgeo.top - 6) }));
    await wait(300);
    const nb = c().querySelector('.v2-newtake'); if (nb) nb.click();
    await wait(360);
    o.opened = c().classList.contains('v2-baropen');
    const fld = (f) => c().querySelector('.v2-barpop [data-bf="' + f + '"]');
    const rowOf = (f) => { const e = fld(f); return e ? e.closest('.ambient-ctrl') : null; };
    const hintOf = (f) => { const rw = rowOf(f); if (!rw) return '';
      const rd = rw.querySelector('.ambient-sl-v');
      const hs = [...rw.querySelectorAll('.ambient-hint')].filter((x) => x !== rd);
      return hs.length ? hs[hs.length - 1].textContent : ''; };
    const setF = async (f, v) => { const e2 = fld(f); if (!e2) return false;
      e2.value = String(v); e2.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(320); return true; };
    o.rows = ['ops.arp', 'ops.scale'].map((f) => f + '=' + (fld(f) ? 'y' : 'MISSING')).join(' ');
    o.onScreen = ['ops.arp', 'ops.scale'].every((f) => {
      const rw = rowOf(f); if (!rw || !rw.offsetParent) return false;
      const b2 = rw.getBoundingClientRect(); return b2.width > 80 && b2.height > 20;
    });
    // AN OPERATION IS NOT A RULE, and the panel says so with its own divider —
    // reading these as more generator knobs is exactly the confusion.
    o.sec = [...c().querySelectorAll('.v2-barpop .v2-barsec label')].map((x) => x.textContent).join(',');
    // 0 and 100 ARE THE NEUTRALS, and a neutral that looks like a setting is
    // the thing this file keeps calling out — so the row says it in words.
    o.arpH0 = hintOf('ops.arp'); o.scH0 = hintOf('ops.scale');
    o.saysNeutral = /off/.test(o.arpH0) && /as written/.test(o.scH0);
    // …and Direction is offered only once there is an arpeggio to direct
    o.dirHidden = !fld('ops.arpDir');
    await setF('ops.arp', 4);
    o.dirShown = !!fld('ops.arpDir');
    o.arpH4 = hintOf('ops.arp');
    await setF('ops.scale', 150);
    o.scH150 = hintOf('ops.scale');
    o.saysMeaning = /4 notes across the change/.test(o.arpH4) && /runs on past/.test(o.scH150);
    o.ruleb = JSON.stringify(L().part.ruleb || null);
    o.sparse = /"ops":\{"arp":4,"scale":150\}/.test(o.ruleb) && !/rhythm|pitch/.test(o.ruleb);
    // back to neutral is a DELETE, through the panel
    await setF('ops.arp', 0); await setF('ops.scale', 100);
    o.clearDeletes = !L().part.ruleb;
    const bx = c().querySelector('.v2-barclose'); if (bx) bx.click();
    await wait(200);
    // …AND PUT THE SELECTION BACK. `BSEL` is module state keyed on the part's
    // signature, so a config restore cannot clear it — and the next run's
    // fixture has the same signature, which made its ruler tap DESELECT this
    // one's bar instead of selecting its own (measured: `opened: false`).
    // RE-READ THE GEOMETRY AT CLICK TIME. `r`/`bg`/`pgeo` were measured before
    // the panel opened, and `getBoundingClientRect` is VIEWPORT-relative — so
    // any scroll or height change since (a popover revealing itself, a row
    // appearing, one more button in the take bar) leaves `r.top` pointing at
    // empty space and this deselect silently MISSES. BSEL then stays dirty and
    // the NEXT run's tap toggles it off instead of selecting its own bar, which
    // surfaces two checks later as `opened: false` — never here. Re-resolve the
    // canvas too: a render between then and now detaches the node.
    {
      const cv9 = c().querySelector('.v2-vizcv');
      if (cv9) {
        cv9.scrollIntoView({ block: 'center' }); await wait(150);
        const r9 = cv9.getBoundingClientRect(), bg9 = cv9._barsGeo, pg9 = cv9._pitchGeo;
        if (bg9 && pg9) cv9.dispatchEvent(new MouseEvent('click', { bubbles: true,
          clientX: r9.left + bg9.x0 + (cv9.clientWidth - bg9.x0) * (0.5 / bg9.vbars),
          clientY: r9.top + Math.max(3, pg9.top - 6) }));
      }
    }
    await wait(250);
    } catch (e) { o.err = String(e && e.message); }
    finally {
      try {
        const c9 = E.getCfg();
        if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
        c9.keyOn = svKey[0]; c9.keyFollow = svKey[1];
        L().part = JSON.parse(sv); E.getCfg();
        if (h) h._sig = ''; window._v2.render(E); await wait(200);
        document.querySelector('.v2-layer').classList.remove('collapsed');
      } catch (e) {}
    }
    return o;
  });
  ok('⟳ Arpeggiate spreads ONE change into a line through its tones — neighbours untouched',
    opsRun.arpCount && opsRun.arpSpread && opsRun.arpRunsUp && opsRun.directionWorks &&
    opsRun.keepsRatio && opsRun.leavesNeighbours,
    JSON.stringify({ err: opsRun.err, plain: opsRun.plain, arp: opsRun.arp,
      arpTimes: opsRun.arpTimes, arpTones: opsRun.arpTones, arpDown: opsRun.arpDown,
      arpDur: opsRun.arpDur, plainDur: opsRun.plainDur, keepsRatio: opsRun.keepsRatio,
      leavesNeighbours: opsRun.leavesNeighbours }));
  ok('⬡ Scale fits a change into a percentage of itself — onsets AND lengths, in proportion',
    opsRun.condenses && opsRun.scalesDur && opsRun.expands && opsRun.scaleLeavesNeighbours &&
    opsRun.composes && opsRun.byteIdentical,
    JSON.stringify({ err: opsRun.err, sc50: opsRun.sc50, sc150: opsRun.sc150, both: opsRun.both,
      sc50Dur: opsRun.sc50Dur, plainDur: opsRun.plainDur, condenses: opsRun.condenses,
      scalesDur: opsRun.scalesDur, expands: opsRun.expands, composes: opsRun.composes,
      byteIdentical: opsRun.byteIdentical }));
  ok('…and the two are OPERATIONS, not rules — their own section, their neutrals named, dropped when neutral',
    opsRun.opened && opsRun.onScreen && opsRun.rows === 'ops.arp=y ops.scale=y' &&
    opsRun.sec === 'Operations' && opsRun.saysNeutral && opsRun.saysMeaning &&
    opsRun.dirHidden && opsRun.dirShown && opsRun.sparse &&
    opsRun.neutralDropped && opsRun.dirNeedsArp && opsRun.coerced && opsRun.clearDeletes,
    JSON.stringify({ err: opsRun.err, opened: opsRun.opened, rows: opsRun.rows, sec: opsRun.sec,
      onScreen: opsRun.onScreen, arpH0: opsRun.arpH0, scH0: opsRun.scH0, arpH4: opsRun.arpH4,
      scH150: opsRun.scH150, dirHidden: opsRun.dirHidden, dirShown: opsRun.dirShown,
      ruleb: opsRun.ruleb, sparse: opsRun.sparse, neutralDropped: opsRun.neutralDropped,
      dirNeedsArp: opsRun.dirNeedsArp, coerced: opsRun.coerced, clearDeletes: opsRun.clearDeletes }));

  // A STRETCH CAN BE RECOLOURED AND RE-VOICED (2026-09-14, user: "user should
  // be able to cycle through inversions across octaves on this menu, also add
  // chord characteristics and extensions, like 7th, 9th, maj/min, aug/dim").
  // Three rows in the per-region panel: the triad, what is stacked on it, and
  // how the result is rotated. All three are `part.ruleb` fields, so they are
  // the part's until the stretch states one — the panel's whole model.
  const recolRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), sv = JSON.stringify(L().part);
    const svKey = [c0.keyOn, c0.keyFollow];
    const o = {};
    try {
    // C major then E minor, so a recolour is VISIBLE as a different third and
    // an extension-only change can be shown to keep each triad's own quality.
    c0.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] }] };
    c0.keyOn = false; c0.keyFollow = false;
    const p0 = L().part;
    p0.kind = 'live'; p0.bars = 2; delete p0.notes; delete p0.takeb; delete p0.ruleb;
    p0.rhythm = { kind: 'ground', steps: 8, n: 1 };
    p0.pitch = { kind: 'chord', voices: 3 };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    const c = () => document.querySelector('.v2-layer');
    c().classList.remove('collapsed');
    // WHAT SOUNDS, grouped per onset — an unpinned `notesFor`, which is what
    // the tick calls. Measuring the drawing alone would pass with playback
    // ignoring the whole feature (the documented per-bar-rules lesson).
    const chords = () => {
      const L2 = L();
      const ns = window._v2.notesFor(L2, { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 8 }) || [];
      const g = {};
      ns.forEach((n) => { const k = Math.round(n.at * 1000);
        (g[k] = g[k] || []).push(Math.round(69 + 12 * Math.log2(n.freq / 440))); });
      return Object.keys(g).sort((a, b) => a - b)
        .map((k) => g[k].sort((a, b) => a - b).join('/')).join('  ');
    };
    o.plain = chords();
    // …as PITCH CLASSES relative to the change's own root, which is what a
    // chord quality actually IS. The first cut pinned absolute MIDI and failed
    // on a layer whose register sits an octave up — a check a register move
    // can break is testing the fixture, not the feature.
    const pcsOf = (str, i, root) => {
      const g = str.split('  ')[i]; if (!g) return '';
      return Array.from(new Set(g.split('/').map((m) => ((((+m - root) % 12) + 12) % 12))))
        .sort((a, b) => a - b).join(',');
    };
    // ── THE ENGINE, on the PART (the region panel writes the same fields) ──
    const setP = (ob) => { Object.assign(L().part.pitch, ob); E.getCfg(); };
    const del = (f) => { delete L().part.pitch[f]; E.getCfg(); };
    // INVERSION KEEPS GOING PAST THE OCTAVE — that is the whole ask. With
    // three voices the THIRD press is root position an octave up, so a check
    // that only looked at 1 and 2 could not tell this from a wrapping control.
    const inv = [];
    for (const k of [1, 2, 3]) { setP({ inv: k }); inv.push(chords()); }
    o.inv = inv.join(' | ');
    const first = o.plain.split('  ')[0].split('/').map(Number);
    const third = inv[2].split('  ')[0].split('/').map(Number);
    o.octaveUp = third.length === first.length && third.every((m, i) => m === first[i] + 12);
    setP({ inv: -1 }); o.down1 = chords();
    o.dropsTop = (() => {
      const a = o.plain.split('  ')[0].split('/').map(Number).sort((x, y) => x - y);
      const b2 = o.down1.split('  ')[0].split('/').map(Number).sort((x, y) => x - y);
      const want = a.slice(0, -1).concat([a[a.length - 1] - 12]).sort((x, y) => x - y);
      return b2.join('/') === want.join('/');
    })();
    del('inv');
    o.invCleared = chords() === o.plain;
    // ── QUALITY replaces the triad, root untouched ───────────────────────
    setP({ qual: 'min' }); o.qMin = chords(); o.qMinIvs = pcsOf(o.qMin, 0, 0);
    setP({ qual: 'aug' }); o.qAug = chords(); o.qAugIvs = pcsOf(o.qAug, 0, 0);
    setP({ qual: 'dim7' }); o.qDim7 = chords(); o.qDim7Ivs = pcsOf(o.qDim7, 0, 0);
    // ° 7 is FOUR tones, and Notes at once says 3 — the floor is raised, or a
    // diminished 7th is indistinguishable from a plain diminished.
    o.dim7Is4 = o.qDim7.split('  ')[0].split('/').length === 4;
    del('qual');
    // ── EXTENSION alone keeps each change's OWN triad ────────────────────
    // C major stays major and E MINOR STAYS MINOR — deriving the triad from
    // the change rather than assuming major is the whole point of this rung.
    setP({ ext: '7' }); o.x7 = chords();
    // C MAJOR STAYS MAJOR AND E MINOR STAYS MINOR under the same extension —
    // the triad is read off each change rather than assumed.
    o.x7a = pcsOf(o.x7, 0, 0); o.x7b = pcsOf(o.x7, 1, 4);
    o.keepsOwnTriad = o.x7a === '0,4,7,10' && o.x7b === '0,3,7,10';
    setP({ ext: 'maj7' }); o.xMaj7 = chords();
    o.seventhAudible = o.x7 !== o.plain && o.xMaj7 !== o.x7;
    setP({ ext: '9' }); o.x9 = chords();
    o.ninthIs5 = o.x9.split('  ')[0].split('/').length === 5;
    // ── …and they COMPOSE ────────────────────────────────────────────────
    setP({ qual: 'min', ext: '7', inv: 1 }); o.composed = chords();
    // an inversion does not change WHICH tones sound, only where they sit
    o.composedIvs = pcsOf(o.composed, 0, 0);
    o.composedRotated = (() => {
      const a = o.plain.split('  ')[0].split('/').map(Number);
      const b2 = o.composed.split('  ')[0].split('/').map(Number);
      return b2.length === 4 && b2[0] > a[0];      // the bass has moved up off the root
    })();
    del('qual'); del('ext'); del('inv');
    o.back = chords();
    // ABSENT BY DEFAULT: nothing stored, and the notes are what they were —
    // which is what keeps golden/arch/harness green by construction.
    o.byteIdentical = o.back === o.plain;
    o.stored = JSON.stringify(L().part.pitch);
    o.nothingStored = !/qual|ext|inv/.test(o.stored);
    // AN UNKNOWN VALUE IS REJECTED, not stored — a select whose value matches
    // no option silently shows the FIRST one (the documented trap).
    L().part.pitch.qual = 'bogus'; L().part.pitch.ext = '99'; L().part.pitch.inv = 'x';
    E.getCfg();
    o.rejects = JSON.stringify([L().part.pitch.qual, L().part.pitch.ext, L().part.pitch.inv]) === '[null,null,null]';
    // ── THE ROWS, IN THE PANEL THE USER POINTED AT ───────────────────────
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(280);
    c().classList.remove('collapsed');
    const cv = c().querySelector('.v2-vizcv'); cv.scrollIntoView({ block: 'center' }); await wait(150);
    const r = cv.getBoundingClientRect(), bg = cv._barsGeo, pgeo = cv._pitchGeo;
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + bg.x0 + (cv.clientWidth - bg.x0) * (0.5 / bg.vbars),
      clientY: r.top + Math.max(3, pgeo.top - 6) }));
    await wait(300);
    const nb = c().querySelector('.v2-newtake'); if (nb) nb.click();
    await wait(360);
    o.opened = c().classList.contains('v2-baropen');
    const fld = (f) => c().querySelector('.v2-barpop [data-bf="' + f + '"]');
    const rowOf = (f) => { const e = fld(f); return e ? e.closest('.ambient-ctrl') : null; };
    const hintOf = (f) => { const rw = rowOf(f); if (!rw) return '';
      const rd = rw.querySelector('.ambient-sl-v');
      const hs = [...rw.querySelectorAll('.ambient-hint')].filter((x) => x !== rd);
      return hs.length ? hs[hs.length - 1].textContent : ''; };
    o.rows = ['pitch.qual', 'pitch.ext', 'pitch.inv'].map((f) => f + '=' + (fld(f) ? 'y' : 'MISSING')).join(' ');
    // REACHABLE, not merely present — a querySelector hit proves nothing
    o.onScreen = ['pitch.qual', 'pitch.ext', 'pitch.inv'].every((f) => {
      const rw = rowOf(f); if (!rw || !rw.offsetParent) return false;
      const b2 = rw.getBoundingClientRect(); return b2.width > 80 && b2.height > 20;
    });
    // THE OPTIONS COME FROM THE WHITELIST — a select offering a value
    // `setBarRule` rejects renders BLANK, so the two must be one list.
    const wl = (f) => ((window._v2.barFields || {}).pitch || {})[f] || [];
    o.qualFromWhitelist = fld('pitch.qual')
      ? [...fld('pitch.qual').options].map((x) => x.value).join(',') === wl('qual').join(',') : false;
    o.extFromWhitelist = fld('pitch.ext')
      ? [...fld('pitch.ext').options].map((x) => x.value).join(',') === wl('ext').join(',') : false;
    // A BARE INVERSION NUMBER SAYS NOTHING — 0 and 1 are exactly the values
    // this file calls meaningless, so the row says what the value MEANS.
    const setF = async (f, v) => { const e2 = fld(f); if (!e2) return false;
      e2.value = String(v); e2.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(320); return true; };
    o.h0 = hintOf('pitch.inv');
    await setF('pitch.inv', 1); o.h1 = hintOf('pitch.inv');
    await setF('pitch.inv', 3); o.h3 = hintOf('pitch.inv');
    o.saysMeaning = /root position/.test(o.h0) && /1st inversion/.test(o.h1) &&
                    /root position/.test(o.h3) && /octave up/.test(o.h3);
    // …and a row that RAISES another row's value says so, or "Notes at once: 3"
    // is a readout that lies while four tones sound.
    await setF('pitch.ext', 'maj7');
    o.hExt = hintOf('pitch.ext');
    o.saysFloor = /4 tones/.test(o.hExt) && /Notes at once/.test(o.hExt);
    // STORED SPARSELY on the region, and marked as its own
    o.ruleb = JSON.stringify(L().part.ruleb || null);
    o.sparse = /"pitch":\{[^}]*"inv":3/.test(o.ruleb) && /"ext":"maj7"/.test(o.ruleb) &&
               !/rhythm/.test(o.ruleb);
    o.marked = !!(rowOf('pitch.ext') && rowOf('pitch.ext').classList.contains('v2-barown'));
    // …and back to the part's is a DELETE, not a stored neutral
    await setF('pitch.ext', '');
    o.afterClear = JSON.stringify(L().part.ruleb || null);
    o.clearDeletes = !/ext/.test(o.afterClear);
    const bx = c().querySelector('.v2-barclose'); if (bx) bx.click();
    await wait(200);
    // …and the selection back, for the same reason (see the ops run above).
    // RE-READ THE GEOMETRY AT CLICK TIME. `r`/`bg`/`pgeo` were measured before
    // the panel opened, and `getBoundingClientRect` is VIEWPORT-relative — so
    // any scroll or height change since (a popover revealing itself, a row
    // appearing, one more button in the take bar) leaves `r.top` pointing at
    // empty space and this deselect silently MISSES. BSEL then stays dirty and
    // the NEXT run's tap toggles it off instead of selecting its own bar, which
    // surfaces two checks later as `opened: false` — never here. Re-resolve the
    // canvas too: a render between then and now detaches the node.
    {
      const cv9 = c().querySelector('.v2-vizcv');
      if (cv9) {
        cv9.scrollIntoView({ block: 'center' }); await wait(150);
        const r9 = cv9.getBoundingClientRect(), bg9 = cv9._barsGeo, pg9 = cv9._pitchGeo;
        if (bg9 && pg9) cv9.dispatchEvent(new MouseEvent('click', { bubbles: true,
          clientX: r9.left + bg9.x0 + (cv9.clientWidth - bg9.x0) * (0.5 / bg9.vbars),
          clientY: r9.top + Math.max(3, pg9.top - 6) }));
      }
    }
    await wait(250);
    } catch (e) { o.err = String(e && e.message); }
    finally {
      try {
        const c9 = E.getCfg();
        if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
        c9.keyOn = svKey[0]; c9.keyFollow = svKey[1];
        L().part = JSON.parse(sv); E.getCfg();
        if (h) h._sig = ''; window._v2.render(E); await wait(200);
        document.querySelector('.v2-layer').classList.remove('collapsed');
      } catch (e) {}
    }
    return o;
  });
  ok('a stretch can be RECOLOURED — its own triad, its own extension, each change keeping what it is',
    recolRun.qMinIvs === '0,3,7' && recolRun.qAugIvs === '0,4,8' && recolRun.qDim7Ivs === '0,3,6,9' &&
    recolRun.dim7Is4 && recolRun.keepsOwnTriad && recolRun.seventhAudible && recolRun.ninthIs5 &&
    recolRun.rejects && recolRun.byteIdentical && recolRun.nothingStored,
    JSON.stringify(recolRun).slice(0, 700));
  ok('…and inversions CYCLE ACROSS OCTAVES — past the voice count is root position an octave up',
    recolRun.octaveUp && recolRun.invCleared && recolRun.dropsTop &&
    recolRun.composedIvs === '0,3,7,10' && recolRun.composedRotated,
    JSON.stringify(recolRun).slice(0, 700));
  ok('…and the three rows are reachable in the per-region panel, say what they mean, and store sparsely',
    recolRun.opened && recolRun.onScreen && recolRun.rows === 'pitch.qual=y pitch.ext=y pitch.inv=y' &&
    recolRun.qualFromWhitelist && recolRun.extFromWhitelist &&
    recolRun.saysMeaning && recolRun.saysFloor &&
    recolRun.sparse && recolRun.marked && recolRun.clearDeletes,
    JSON.stringify({ err: recolRun.err, opened: recolRun.opened, rows: recolRun.rows,
      onScreen: recolRun.onScreen, qualWL: recolRun.qualFromWhitelist, extWL: recolRun.extFromWhitelist,
      h0: recolRun.h0, h1: recolRun.h1, h3: recolRun.h3, hExt: recolRun.hExt,
      saysMeaning: recolRun.saysMeaning, saysFloor: recolRun.saysFloor,
      ruleb: recolRun.ruleb, sparse: recolRun.sparse, marked: recolRun.marked,
      afterClear: recolRun.afterClear, clearDeletes: recolRun.clearDeletes }));

  // ✨ AUTO — THE SHORT WAY IN (2026-09-14, user: "the Generated menu feels
  // totally overloaded, let's sidestep it for now; create a new 'By Rule'
  // option called 'Auto'"). Two presses, no knobs, applied to the SELECTED
  // part: ▦ Chords fills every change, ♪ Melody is one voice over them.
  const autoRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), svPart = JSON.stringify(L().part);
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    const svClk = [E._playStartAt, E._progAnchor, E._barGridAnchor];
    const svOn = L().on, svPr = L().present, svFor = L().partFor;
    const o = {};
    // A CADENCE, so "fills the changes bars" is a claim with teeth: chord 1
    // runs TWO bars and chord 2 one, inside a 3-bar part.
    c0.prog = { on: true, name: 'P',
      parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }],
      chords: [{ root: 0, intervals: [0, 4, 7], bars: 2 }, { root: 5, intervals: [0, 4, 7] },
               { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }] };
    c0.keyOn = false; c0.keyFollow = false;
    E.getCfg();
    E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
    L().on = true; L().present = true; L().part.kind = 'live';
    delete L().part.mat; delete L().part.mem;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    const svCf = window.confirm; window.confirm = () => true;
    // THE ROW IS IN THE MAKE SECTION, so open it the way a finger does — a
    // `querySelector` hit proves nothing and a 0x0 rect is the tell.
    window.__sec('Generate'); await wait(300);
    // ── THE DOOR IS REACHABLE, and it is in the By rule group ─────────────
    const door = () => card().querySelector('.v2-autobtn');
    const dr = door() && door().getBoundingClientRect();
    o.door = !!(door() && door().offsetParent && dr.width > 40 && dr.height > 20);
    o.doorTxt = door() ? door().textContent : '';
    // the two doors sit in ONE group, and the group is labelled "By rule"
    const grp = door() && door().closest('.v2-matgrp');
    o.sameGroup = !!(grp && grp.querySelector('.v2-genbtn'));
    o.grpLab = grp ? (grp.querySelector('.v2-matlab') || {}).textContent : '';
    // A DOOR IS AN ACTION, NOT A STATUS. Both doors lighting for one part is
    // the mode-or-status rule broken, so ⚙ Generated keeps the light and this
    // one never takes it — asserted AFTER a build below, where it would.
    const wrap = () => card().querySelector('.v2-autowrap');
    o.shutRect = Math.round(wrap().getBoundingClientRect().width);
    door().click(); await wait(300);
    o.openRect = Math.round(wrap().getBoundingClientRect().width);
    o.opened = o.shutRect === 0 && o.openRect > 100;
    // ── IT SAYS WHICH PART IT WILL WRITE ─────────────────────────────────
    // "applies to the currently selected part" is only true if the panel
    // names it — a stopped clock resolves to part 0 (the documented trap).
    o.says = (card().querySelector('.v2-autosays') || {}).textContent || '';
    o.namesPart = /Verse/.test(o.says) && /3 bar/.test(o.says) && /2 change/.test(o.says);
    const picks = () => [...card().querySelectorAll('.v2-autopick')];
    o.picks = picks().map((b) => b.getAttribute('data-auto')).join(',');
    o.pickRects = picks().map((b) => Math.round(b.getBoundingClientRect().width));
    o.bothOnScreen = picks().length === 2 && o.pickRects.every((w) => w > 60);
    const notes = () => window._v2.takeNotesNow(E, L()) || [];
    const onsets = () => [...new Set(notes().map((n) => Math.round(n.t * 1000) / 1000))].sort((a, b) => a - b);
    const poly = () => {
      const m = {}; notes().forEach((n) => { const k = Math.round(n.t * 1000); m[k] = (m[k] || 0) + 1; });
      const v = Object.keys(m).map((k) => m[k]); return v.length ? Math.max.apply(null, v) : 0;
    };
    // ── ▦ CHORDS FILLS THE CHANGES, CADENCE AND ALL ──────────────────────
    picks()[0].click(); await wait(340);
    o.chordMat = L().part.mat;
    o.chordBars = L().part.bars;
    o.chordOnsets = onsets().join(',');
    o.chordPoly = poly();
    // ONE onset per change and NOT one per bar: the part is 3 bars and the
    // first chord holds two of them, so a uniform lattice would put a note at
    // 1/3 as well. The cadence is what says 0 and 2/3.
    o.fillsCadence = o.chordOnsets === '0,0.667' && o.chordBars === 3 && o.chordPoly === 3;
    // …and each note HOLDS to the next change rather than being a stab
    o.chordHolds = (L().part.shape || {}).lenRatio === 100;
    // THE CARD NAMES THE LAYER, so a pick shows on it once ✓ Done writes it
    // (✨ Quick is staged, 2026-09-16) — commit, then reopen for the next pick
    const commitQuick = async (reopen) => {
      const d = card().querySelector('.v2-autodone'); if (d) d.click(); await wait(300);
      card().classList.remove('collapsed');
      if (reopen) { door().click(); await wait(300); card().classList.remove('collapsed'); }
    };
    await commitQuick(true);
    // THE SAME MATERIAL, NOT A SECOND ONE WEARING A NEW WORD. ▦ Chords is
    // ⛰ Groundwork, and every surface has to keep saying so.
    o.chordIsGround = L().part.mat === 'ground' &&
      /Play the changes/.test((card().querySelector('.v2-genface') || {}).textContent || '');
    // the DOOR still does not light; ⚙ Generated does
    o.doorDark = !door().classList.contains('on') &&
                 card().querySelector('.v2-genbtn').classList.contains('on');
    // …and INSIDE the panel it says which one is in force, which is a status
    // that is unambiguous there
    o.litChords = picks().map((b) => b.getAttribute('data-auto') + ':' + b.classList.contains('on')).join(' ');
    // THE PANEL STAYS OPEN — two choices is a comparison, and shutting it on
    // the first press means going back in to hear the other one.
    o.stayedOpen = card().classList.contains('v2-autoopen');
    // ── ♪ MELODY IS ONE VOICE ────────────────────────────────────────────
    picks()[1].click(); await wait(340);
    o.melMat = L().part.mat;
    o.melPoly = poly();
    o.melN = notes().length;
    o.melVoices = (L().part.pitch || {}).voices;
    o.melLines = (L().part.pitch || {}).lines;
    o.singleVoice = o.melMat === 'melody' && o.melPoly === 1 && o.melN > 1 &&
                    o.melVoices === 1 && !(o.melLines > 1);
    // …on a grid the BARS DIVIDE, or a note can never land on a bar line (the
    // documented roll bug). 3 bars → 12 steps, so every onset is a 12th.
    o.melSteps = (L().part.rhythm || {}).steps;
    o.onGrid = o.melSteps % Math.max(1, Math.round(L().part.bars)) === 0;
    await commitQuick(false);
    // IT IS NAMED EVERYWHERE, or a material with no chip renders blank
    o.melFace = (card().querySelector('.v2-genface') || {}).textContent || '';
    o.prov = (card().querySelector('.v2-notecount') || {}).textContent || '';
    // …and it must NOT borrow the Roll's words: they are the same SHAPE and
    // differ only by the stamp, so one line saying both is two names for one
    // state (the divergent-label rule).
    o.namedOnce = /Melody/.test(o.melFace) && /Melody/.test(o.prov) &&
                  !/run of single notes/.test(o.prov) && !/Roll/.test(o.prov);
    // A ROLL KEEPS ITS OWN WORDS — the phrase keys on the stamp, and keying it
    // on the shape renamed every Roll ever made (caught here).
    window._v2.rollRun(E, L()); E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(240);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    o.rollProv = (card().querySelector('.v2-notecount') || {}).textContent || '';
    o.rollKeepsWords = /Roll/.test(o.rollProv) && !/single voice, moving/.test(o.rollProv);
    // ── EVERY PRESS REROLLS (restated 2026-09-16, user: "pressing Chords or
    // Melody should reroll"). It ADOPTED on the lit one; ✨ Quick is staged and
    // has no knobs, so another press is another roll — measured off the NOTES.
    door().click(); await wait(300);
    picks()[1].click(); await wait(340);         // back to Melody
    const noteSig = () => notes().map((n) => Math.round(n.t * 1000) + ':' + n.midi).join(',');
    const mel0 = noteSig(), take0 = L().part.take | 0;
    picks()[1].click(); await wait(340);         // …and again
    o.melRerolls = L().part.mat === 'melody' && (L().part.take | 0) !== take0 && noteSig() !== mel0;
    picks()[0].click(); await wait(340);
    const ch0 = noteSig();
    picks()[0].click(); await wait(340);
    o.chordRerolls = L().part.mat === 'ground' && noteSig() !== ch0;
    o.adoptKeeps = o.melRerolls && o.chordRerolls;
    // ── CLOSE ────────────────────────────────────────────────────────────
    const x = card().querySelector('.v2-autodone'); if (x) x.click();
    await wait(260);
    o.closed = !card().classList.contains('v2-autoopen') &&
               Math.round(wrap().getBoundingClientRect().width) === 0;
    // …and the Generated door still opens ITS panel, not this one — the two
    // popovers share no class name (the duplicate-class trap, pre-armed).
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(280);
    o.exclusive = card().classList.contains('v2-genopen') && !card().classList.contains('v2-autoopen');
    const gx = card().querySelector('.v2-gendone'); if (gx) gx.click();
    await wait(200);
    try { window.__toContent(); } catch (e) {}    // …and put the section sheet back
    await wait(200);
    window.confirm = svCf;
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(svPart); L().on = svOn; L().present = svPr;
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      E.getCfg();
      E._playStartAt = svClk[0]; E._progAnchor = svClk[1]; E._barGridAnchor = svClk[2];
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('✨ Auto is a reachable By-rule door — two presses, no knobs, and it names the part it writes',
    // ✨ Auto is ✨ Quick since 2026-09-16 (label-only)
    autoRun.door && /Quick/.test(autoRun.doorTxt || '') && autoRun.sameGroup &&
    autoRun.opened && autoRun.namesPart &&
    autoRun.picks === 'chords,melody' && autoRun.bothOnScreen &&
    autoRun.stayedOpen && autoRun.closed && autoRun.exclusive,
    JSON.stringify(autoRun));
  ok('✨ Auto ▸ Chords fills every change at its own cadence, and it IS ⛰ Groundwork — one state, one word',
    autoRun.fillsCadence && autoRun.chordHolds && autoRun.chordIsGround &&
    autoRun.doorDark && autoRun.litChords === 'chords:true melody:false',
    JSON.stringify(autoRun));
  ok('✨ Auto ▸ Melody is ONE voice on a grid the bars divide, named everywhere, and a Roll keeps its own words',
    autoRun.singleVoice && autoRun.onGrid && autoRun.namedOnce &&
    // …and a press on the lit option REROLLS (was: adopts), both options
    autoRun.rollKeepsWords && autoRun.adoptKeeps,
    JSON.stringify(autoRun));

  // ⛰ GROUNDWORK IS FILED BY PART NOW, and a change can carry a LINE over it.
  // The panel was a flat strip of chord cells — on a chained progression that
  // is a row of names with nothing saying where one part ends and the next
  // begins ("it needs to be clearer which part is which"). Each PART is its
  // own block holding GLOBAL (that part speaking for all of its changes) and
  // the changes themselves, each of which may override it. The ladder is the
  // one this file uses everywhere: chord → part → layer, absent = inherit.
  const gwPartsRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), svPart = JSON.stringify(L().part);
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    const svClk = [E._playStartAt, E._progAnchor, E._barGridAnchor];
    const svOn = L().on, svPr = L().present;
    const o = {};
    // TWO PARTS over five changes — the shape the report is about. One part
    // cannot tell a part-scoped setting from a layer-scoped one.
    c0.prog = { on: true, name: 'P',
      parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 3 }],
      chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
               { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] },
               { root: 2, intervals: [0, 3, 7] }] };
    c0.keyOn = false; c0.keyFollow = false;
    E.getCfg();
    E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
    const Lp = L();
    Lp.on = true; Lp.present = true; Lp.part.kind = 'live'; Lp.part.bars = 5;
    Lp.part.rhythm = { kind: 'ground', steps: 8, n: 1 };
    Lp.part.pitch = Object.assign({}, Lp.part.pitch, { kind: 'chord', voices: 3 });
    delete Lp.part.ground;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    // the panel lives behind ⚙ Generated, and pressing it ADOPTS the shape
    const svCf = window.confirm; window.confirm = () => true;
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
    await wait(300);
    const notes = () => (window._v2.takeNotesNow(E, L()) || []).length;
    const stored = () => JSON.stringify(L().part.ground || null);
    const blocks = () => [...document.querySelectorAll('.v2-layer .v2-gwpart')];
    const cellOf = (ci) => document.querySelector('.v2-layer .v2-gwcell[data-gwci="' + ci + '"]');
    o.blocks = blocks().length;
    o.names = blocks().map((b) => (b.querySelector('.v2-gwpname') || {}).textContent || '');
    // each block holds only ITS OWN changes — that is the whole report
    o.perBlockCells = blocks().map((b) => [...b.querySelectorAll('.v2-gwcell')].map((c) => c.dataset.gwci).join(','));
    o.split = o.perBlockCells.join(' | ') === '0,1 | 2,3,4';
    // GLOBAL — one row per part, the three things a part says for all of it
    o.globLabs = blocks().map((b) => [...b.querySelectorAll('.v2-gwglob .v2-mini-lab')].map((x) => x.textContent).join('/'));
    o.hasGlobal = o.globLabs.every((x) => x === 'Notes/Hold %/Slip');
    o.hasLineBtn = blocks().every((b) => !!b.querySelector('.v2-gwpmel'));
    // …and the head SAYS what it is set to, so a block can never hide its state
    o.sum0 = (blocks()[0].querySelector('.v2-gwpsum') || {}).textContent;
    o.n0 = notes();
    // A PART SETTING REACHES EVERY CHANGE IN IT AND NO OTHER. Verse → 1 note
    // each leaves the Chorus at three: 2x1 + 3x3 = 11 where it was 5x3 = 15.
    const gUp = blocks()[0].querySelector('.v2-gwglob .ambient-step-dn');
    gUp.click(); await wait(140); gUp.click(); await wait(260);
    o.partStored = stored();
    o.nPart = notes();
    o.partScoped = o.n0 === 15 && o.nPart === 11;
    // THE BUTTON SURVIVES ITS OWN COMMIT — the panel's sync must not rewrite
    // the block under the finger (two taps moving the number by one is the
    // documented re-render-under-the-finger trap, and this panel had it).
    o.globSurvives = document.contains(gUp);
    // A CHANGE OUTRANKS ITS PART: chord 0 back to three inside a part set to one
    const cu = cellOf(0).querySelector('.ambient-step-up');
    cu.click(); await wait(140); cu.click(); await wait(260);
    o.chordStored = stored();
    o.nChord = notes();
    o.chordOutranksPart = o.nChord === 13 && /"chords":\{"0":\{"voices":3\}\}/.test(o.chordStored);
    o.cellMarked = cellOf(0).classList.contains('own') && !cellOf(1).classList.contains('own');
    // ── A LINE OVER THE CHORD ────────────────────────────────────────────
    // THE ♪ Line TAB FIRST (2026-09-21): a part block is two tabs, and every
    // line control below — the part's ♪ Line switch, a change's three-state —
    // is the LINE tab's half. On Chords they are `display: none`, and while a
    // `.click()` still fires on a hidden node, a check that drives controls
    // nobody can see is not checking the card the user has. Pressed on BOTH
    // blocks, because the tab is per part and `cellOf` reaches across them.
    card().querySelectorAll('.v2-gwptab[data-gwt="line"]').forEach((t2) => t2.click());
    await wait(260);
    // The chord SUSTAINS and a separate voice moves over it — a real second
    // pass, not a re-voicing. 3 changes in the Chorus x 4 notes = 12 more.
    const lb = blocks()[1].querySelector('.v2-gwpmel');
    lb.click(); await wait(320);
    o.melStored = stored();
    o.nMel = notes();
    o.lineAdds = o.nMel === o.nChord + 12;
    o.melRow = !!document.querySelector('.v2-layer .v2-gwpart[data-gwpi="1"] .v2-gwmelrow');
    o.melSays = /line/.test((blocks()[1].querySelector('.v2-gwpsum') || {}).textContent || '');
    // …and the chord still sounds underneath it — the line is ADDED, never
    // substituted, which is what separates this from a per-change pitch rule.
    const nn = window._v2.takeNotesNow(E, L()) || [];
    o.chordHeld = nn.filter((n) => Math.abs(n.t - 0.4) < 0.001).length >= 1;
    // THE LINE'S OWN SETTINGS, and they are only offered once it is on
    // SCOPED AWAY FROM `.v2-gwclrow`, which shares the class: a change that
    // lights its own line draws the same six knobs at its own rung.
    o.melLabs = [...document.querySelectorAll('.v2-layer .v2-gwmelrow:not(.v2-gwclrow) .v2-mini-lab')].map((x) => x.textContent).join('/');
    o.melKind = !!document.querySelector('.v2-layer .v2-gwmelrow:not(.v2-gwclrow) .v2-gwkind select');
    // A CHANGE'S LINE BUTTON IS THREE-STATE, because absent and off are
    // different answers — and the FIRST tap always changes what you hear, so
    // on a part that already gives a line it means "not this one".
    const mb = () => cellOf(3).querySelector('.v2-gwmel');
    o.st0 = mb().dataset.gwmel;
    mb().click(); await wait(300);
    o.st1 = mb().dataset.gwmel; o.n1 = notes(); o.stored1 = stored();
    mb().click(); await wait(300);
    o.st2 = mb().dataset.gwmel;
    mb().click(); await wait(300);
    o.st3 = mb().dataset.gwmel; o.stored3 = stored();
    o.triState = o.st0 === 'inherit' && o.st1 === 'off' && o.st2 === 'on' && o.st3 === 'inherit' &&
                 o.n1 === o.nMel - 4 &&                     // the first tap silences THAT line
                 /"mel":\{"on":0\}/.test(o.stored1) &&      // …stored, because off ≠ absent
                 !/"3"/.test(o.stored3);                    // …and back to absent
    // A CHANGE CAN CARRY A LINE ITS PART DOES NOT GIVE IT
    const mb0 = () => cellOf(0).querySelector('.v2-gwmel');
    mb0().click(); await wait(300);
    o.ownLine = notes() === o.nMel + 4 && /"0":\{[^}]*"mel":\{"on":1\}/.test(stored());
    // NOTHING STORED = NOTHING CHANGED. A layer that has set nothing must
    // carry no field at all, or every older project gains one on load.
    delete L().part.ground; E.getCfg();
    o.absentByDefault = stored() === 'null' && notes() === 15;
    // the legacy flat map IS a chord-scoped note count, and is migrated rather
    // than kept as a third parallel store
    L().part.ground = { per: { '1': 0, '4': 5 } }; E.getCfg();
    o.migrated = stored();
    o.migrates = o.migrated === '{"chords":{"1":{"voices":0},"4":{"voices":5}}}';
    const gp = card().querySelector('.v2-gendone'); if (gp) gp.click();
    await wait(200);
    window.confirm = svCf;
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(svPart); L().on = svOn; L().present = svPr; E.getCfg();
      E._playStartAt = svClk[0]; E._progAnchor = svClk[1]; E._barGridAnchor = svClk[2];
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('⛰ Groundwork is filed by PART — global, then per change, and a change may carry a line',
    gwPartsRun.blocks === 2 && gwPartsRun.split && gwPartsRun.hasGlobal &&
    gwPartsRun.hasLineBtn && /Verse/.test(gwPartsRun.names[0]) && /Chorus/.test(gwPartsRun.names[1]) &&
    /3 notes/.test(gwPartsRun.sum0 || '') &&
    gwPartsRun.partScoped && gwPartsRun.globSurvives &&
    gwPartsRun.chordOutranksPart && gwPartsRun.cellMarked &&
    gwPartsRun.absentByDefault && gwPartsRun.migrates,
    JSON.stringify(gwPartsRun));
  ok('⛰ …and the line is a SECOND voice over the held chord, off by default, three-state per change',
    gwPartsRun.lineAdds && gwPartsRun.melRow && gwPartsRun.melSays && gwPartsRun.chordHeld &&
    gwPartsRun.melKind && gwPartsRun.melLabs === 'Notes/Moves/Octave/Length %/Level/Range' &&
    gwPartsRun.triState && gwPartsRun.ownLine,
    JSON.stringify(gwPartsRun));

  // "NOTES ARE FLASHING" (2026-09-09): a per-part window's edges come out of a
  // BISECTION and carry ~10ms of float noise per query, so the rAF's
  // once-per-cycle redraw check and the drawing's own anchor disagreed every
  // frame the moment another part's span was sounding — the canvas redrew
  // 30-57x/s. Pins the fix pair: snapped window edges + the 20ms tolerance.
  // Counts REAL canvas clears while playing across a part boundary, on the
  // unequal-parts shape (5+4) the noise reproduces on.
  const flashRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const svProg = E.getCfg().prog ? JSON.stringify(E.getCfg().prog) : 'null';
    const svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svParts = L().parts ? JSON.stringify(L().parts) : null,
          svAll = L().partAll ? JSON.stringify(L().partAll) : null;
    const o = {};
    E.getCfg().prog = { on: true,
      parts: [{ name: 'A', len: 5 }, { name: 'B', len: 4 }],
      chords: [0, 2, 4, 5, 7, 0, 9, 2, 7].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    L().on = true; L().present = true;
    L().part.kind = 'live'; L().part.bars = 5;
    L().part.rhythm = { kind: 'euclid', steps: 16, pulses: 9, rotate: 5 };
    L().part.pitch = { kind: 'walk', degree: 1, span: 3, voices: 3 };
    L().partFor = 0;
    L().parts = { 1: JSON.parse(JSON.stringify(L().part)) };
    L().parts[1].bars = 4;
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    const cv0 = card().querySelector('.v2-vizcv');
    const proto = CanvasRenderingContext2D.prototype;
    const oCR = proto.clearRect;
    let redraws = 0;
    proto.clearRect = function (x, y, w2) {
      try { if (this.canvas === cv0 && w2 >= cv0.width - 2) redraws++; } catch (e) {}
      return oCR.apply(this, arguments);
    };
    try { await Tone.start(); } catch (e) {}
    _ambStartGenerator(E);
    // 13s at 120bpm reaches ~2.5 bars into part B's span (part A = 10s).
    // SAMPLED rather than one long wait, so the same playback also answers
    // "how many bars does the ruler draw for the part that is SOUNDING" —
    // no extra 13 seconds for a second fixture of the same shape.
    const rulerBy = {};
    for (let i = 0; i < 26; i++) {
      await wait(500);
      const cvS = card().querySelector('.v2-vizcv');
      if (!cvS || !cvS._barsGeo) continue;
      // WHOSE RECORD THE CANVAS SAYS IT DREW — never `_ambPartChordAt(cv._cs)`.
      // A window's `cs` is SNAPPED and can sit one ULP below the boundary it
      // names, which answers the PREVIOUS part (see the 2026-09-10 entry); this
      // probe bucketed on it and so flaked by anchor, reporting both rulers
      // under one part and none under the other. `_drawnPi` is the picture's
      // own claim, resolved from the window rather than re-derived from it.
      const pi = Number.isFinite(cvS._drawnPi) ? (cvS._drawnPi | 0) : -1;
      const rec = rulerBy[pi] = rulerBy[pi] || { bars: {}, lab: {} };
      rec.bars[String(Math.round(cvS._barsGeo.barsF * 100) / 100)] = 1;
      rec.lab[((card().querySelector('.v2-vizlab') || {}).textContent || '')
        .split('\u00b7').map((x) => x.trim()).filter((x) => /bars?$/.test(x))[0] || '?'] = 1;
    }
    proto.clearRect = oCR;
    _ambStopGenerator(E);
    o.redraws = redraws;
    o.ruler = Object.fromEntries(Object.entries(rulerBy).map(([k, v]) =>
      [k, { bars: Object.keys(v.bars), lab: Object.keys(v.lab) }]));
    // PART A IS 5 BARS AND PART B IS 4 — the ruler, and the readout beside it,
    // must say which one is SOUNDING. They read `L.part.bars` (the record
    // being EDITED) while the NOTES were laid across the window actually
    // playing, so with part A selected the drawing put four bars of music
    // under a five-bar ruler and the readout said "5 bars · 8s" — 8s IS four
    // bars at 120bpm, the one line contradicting itself. Reported as "part 2
    // renders as 5 bars".
    o.rulerFollows = !!(o.ruler['0'] && o.ruler['1']) &&
      o.ruler['0'].bars.length === 1 && o.ruler['0'].bars[0] === '5' &&
      o.ruler['1'].bars.length === 1 && o.ruler['1'].bars[0] === '4' &&
      o.ruler['0'].lab.join() === '5 bars' && o.ruler['1'].lab.join() === '4 bars';
    o.vm = window._v2.vizModeOf(L());
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svParts) L().parts = JSON.parse(svParts); else delete L().parts;
      if (svAll) L().partAll = JSON.parse(svAll); else delete L().partAll;
      E.getCfg();
      E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('the roll redraws once per cycle while playing — never per frame (the flashing bug)',
    flashRun && !flashRun.err && flashRun.redraws >= 1 && flashRun.redraws <= 12,
    JSON.stringify(flashRun));
  ok('the ruler and the readout count the SOUNDING part\u2019s bars, not the edited record\u2019s',
    flashRun && !flashRun.err && flashRun.rulerFollows,
    JSON.stringify(flashRun && flashRun.ruler));

  // "THE EVENTS I DREW WERE GONE… THEY APPEARED ON THE NEXT PART, AND THE
  // COLOUR IS THE OTHER PART'S" (2026-09-10). `cycleWindowAt` SNAPS its window
  // edges to the 1/48-bar grid so every consumer computes the same `cs` (the
  // flashing fix above) — and the snap reconstructs the boundary to within a
  // ULP, which can land on the WRONG SIDE of it: measured cs 4.06 against a
  // boundary at 4.06 + 4.4e-16. Everything that then re-derived the part from
  // that float — the drawn record, its colour, `_vmOther`, `vizFollows` and
  // `notesFor`'s own swap — got the PREVIOUS part for a whole pass. With two
  // parts that reads as the picture swapping them: content drawn into part 1
  // shown under part 2, and missing when part 1 came round again.
  // DETERMINISTIC, and swept across ANCHORS rather than measured during one
  // playback: whether the ULP falls the wrong way depends on the cold-start
  // anchor, so a single play is exactly the run that can pass with the bug in.
  const winPiRun = await page.evaluate(async () => { try {
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = { prog: E.getCfg().prog ? JSON.stringify(E.getCfg().prog) : 'null',
      part: JSON.stringify(L().part), pf: L().partFor,
      parts: L().parts ? JSON.stringify(L().parts) : null,
      all: L().partAll ? JSON.stringify(L().partAll) : null,
      pa: E._progAnchor, ps: E._playStartAt, bg: E._barGridAnchor, cf: E._cfg };
    const o = { mismatch: 0, noteMiss: 0, tot: 0, anchors: 0, ex: null, exOld: null, oldBad: 0 };
    const cfg = E.getCfg();
    cfg.prog = { on: true, parts: [{ name: 'A', len: 4 }, { name: 'B', len: 4 }],
      chords: [0, 5, 7, 9, 0, 3, 5, 7].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    cfg.bpm = 120;
    L().on = true; L().present = true;
    L().part.kind = 'recorded'; L().part.bars = 4;
    L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 64, dur: 0.2 }];
    L().partFor = 0; L().parts = {}; delete L().partAll;
    E.getCfg();
    // a record for part 1 that is UNMISTAKABLY not part 0's, so the swap is
    // observable in the notes and not only in an index
    L().parts['1'].notes = [{ t: 0, midi: 72, dur: 0.2 }, { t: 0.25, midi: 74, dur: 0.2 },
                            { t: 0.75, midi: 76, dur: 0.2 }];
    E.getCfg();
    const Lr = L(), st = { startAt: 0 };
    const midis = (ns) => ns.map((n) => Math.round(69 + 12 * Math.log2(n.freq / 440)))
      .sort((a, b) => a - b).join(',');
    for (let a = 0; a < 40; a++) {
      const anchor = a * 0.03;
      E._progAnchor = anchor; E._playStartAt = anchor; E._barGridAnchor = anchor; E._cfg = cfg;
      o.anchors++;
      for (let k = 0; k < 90; k++) {
        const t = anchor + 0.02 + k * 0.19;
        const w = window._v2.cycleWindowAt(Lr, E, cfg, t, st);
        const piNow = (_ambPartChordAt(E, cfg, t) || {}).pi | 0;
        const want = piNow === 0 ? '60,64' : '72,74,76';
        const got = midis(window._v2.notesFor(Lr, { E, cfg, key: 'v2:' + (Lr.id | 0),
          cycleStart: w.cs, cycleSec: w.cyc, pi: (w.pi | 0) }));
        o.tot++;
        if ((w.pi | 0) !== piNow) { o.mismatch++; if (!o.ex) o.ex = { anchor, t: +t.toFixed(3), piNow, wpi: w.pi | 0 }; }
        if (got !== want) { o.noteMiss++; }
        // …and the SHAPE THIS PINS: re-deriving the part from the returned
        // `cs`, which is what shipped, must be seen to go wrong somewhere in
        // the sweep — a check whose poison cannot trigger pins nothing.
        const piOld = (_ambPartChordAt(E, cfg, w.cs) || {}).pi | 0;
        if (piOld !== piNow) { o.oldBad++; if (!o.exOld) o.exOld = { anchor, t: +t.toFixed(3), piNow, piOld, cs: w.cs }; }
      }
    }
    try {
      const c9 = E.getCfg();
      if (sv.prog === 'null') delete c9.prog; else c9.prog = JSON.parse(sv.prog);
      L().part = JSON.parse(sv.part);
      if (Number.isFinite(sv.pf)) L().partFor = sv.pf; else delete L().partFor;
      if (sv.parts) L().parts = JSON.parse(sv.parts); else delete L().parts;
      if (sv.all) L().partAll = JSON.parse(sv.all); else delete L().partAll;
      E.getCfg();
      E._progAnchor = sv.pa; E._playStartAt = sv.ps; E._barGridAnchor = sv.bg; E._cfg = sv.cf;
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('the window says WHICH PART it is \u2014 the drawn record and its colour never lag a pass behind',
    winPiRun && !winPiRun.err && winPiRun.tot > 3000 &&
    winPiRun.mismatch === 0 && winPiRun.noteMiss === 0,
    JSON.stringify(winPiRun));
  ok('\u2026and the sweep reaches an anchor where re-deriving it from the window start WOULD be wrong',
    winPiRun && !winPiRun.err && winPiRun.oldBad > 0,
    JSON.stringify(winPiRun && { oldBad: winPiRun.oldBad, ex: winPiRun.exOld }));

  // THE SAME FAMILY, FOUND BY AUDITING IT (2026-09-10): `_ambTransposeLayer`
  // moved a v2 recorded part by scaling `n.freq` — and a stored note is
  // `{t, midi, dur}` with NO `freq` at all, so the guard never fired and
  // transposing an area left every v2 recorded part in the old key. It also
  // only ever looked at `L.part`, so even once it worked it would have moved
  // the record being EDITED and left the other parts' behind.
  const trRun = await page.evaluate(async () => { try {
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const sv = { part: JSON.stringify(L().part), pf: L().partFor,
      parts: L().parts ? JSON.stringify(L().parts) : null,
      all: L().partAll ? JSON.stringify(L().partAll) : null,
      prog: JSON.stringify(c0.prog || null) };
    c0.prog = { on: true, parts: [{ name: 'A', len: 2 }, { name: 'B', len: 2 }],
      chords: [0, 5, 7, 9].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    L().part.kind = 'recorded'; L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }];
    L().partFor = 0; L().parts = {}; delete L().partAll;
    E.getCfg();
    L().parts['1'].notes = [{ t: 0, midi: 67, dur: 0.2 }];
    E.getCfg();
    const snap = () => { const x = L(); return {
      edited: (x.part.notes || []).map((n) => n.midi),
      other: ((x.parts && x.parts['1'] && x.parts['1'].notes) || []).map((n) => n.midi),
      ice: ((x.partAll && x.partAll.notes) || []).map((n) => n.midi) }; };
    const o = { before: snap() };
    _ambTransposeArea(E.getCfg(), 5); E.getCfg();
    o.after = snap();
    // …and back, so the fixture is left where it was found
    _ambTransposeArea(E.getCfg(), -5); E.getCfg();
    o.back = snap();
    try {
      const c9 = E.getCfg();
      if (sv.prog === 'null') delete c9.prog; else c9.prog = JSON.parse(sv.prog);
      L().part = JSON.parse(sv.part);
      if (Number.isFinite(sv.pf)) L().partFor = sv.pf; else delete L().partFor;
      if (sv.parts) L().parts = JSON.parse(sv.parts); else delete L().parts;
      if (sv.all) L().partAll = JSON.parse(sv.all); else delete L().partAll;
      E.getCfg();
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('transposing the area moves EVERY filed v2 record \u2014 not just the one being edited',
    trRun && !trRun.err &&
    trRun.before.edited.join() === '60' && trRun.before.other.join() === '67' &&
    trRun.after.edited.join() === '65' && trRun.after.other.join() === '72' &&
    trRun.after.ice.join() === '65' &&
    trRun.back.edited.join() === '60' && trRun.back.other.join() === '67',
    JSON.stringify(trRun));

  // A PART'S LENGTH IS ANSWERED TWICE and the two can legitimately differ:
  // `_ambLenPartBars` (the part's chords — what the normalize RECONCILER fits
  // every per-part record to) and `_ambPassSpanAt` (the PASS sounding — what
  // `cycleWindowAt` hands the emitter as one cycle). When they disagree the
  // record is fitted into the window and its notes compress ("the 4-bar part is
  // jammed into 3 bars"). `bloomPartWatch()` is the in-situ instrument for that
  // class, and a diagnostic that silently stops discriminating is worse than
  // none — so it is pinned in BOTH directions on the one shape measured to
  // disagree (a ▦ Passes SUBSET: a pass playing 3 of 4 chords IS 3 bars) and
  // one measured to agree. NOTE: a multi-shape sweep of this on ONE page
  // reported hang disagreements that do not exist — the shapes leaked into each
  // other; each case here rebuilds the progression from scratch.
  const partWatchRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svProg = E.getCfg().prog ? JSON.stringify(E.getCfg().prog) : 'null';
    const svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svParts = L().parts ? JSON.stringify(L().parts) : null,
          svAll = L().partAll ? JSON.stringify(L().partAll) : null;
    const mk = (r) => r.map((x) => ({ root: x, intervals: [0, 4, 7] }));
    const o = { exists: typeof window.bloomPartWatch === 'function' };
    const run = (mut) => {
      const pr = { on: true, parts: [{ name: 'Verse', len: 5 }, { name: 'Chorus', len: 4 }],
        chords: mk([0, 2, 4, 5, 7, 0, 9, 2, 7]) };
      mut(pr);
      E.getCfg().prog = pr;
      L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 5;
      E.getCfg(); window._v2.partSelect(E, L(), 0); E.getCfg();
      return String(window.bloomPartWatch() || '');
    };
    const plain = run(() => {});
    o.plainAgrees = /lengths agree/.test(plain) && !/JAMMED/.test(plain) &&
                    /Verse .* 5 chords = 5 bars/.test(plain) && /Chorus .* 4 chords = 4 bars/.test(plain);
    const sub = run((pr) => { pr.parts[1].grid = { cols: 2, seq: { 1: [0, 1, 2] } }; });
    // NAMES the cause, not just the number — the report has to be actionable
    o.subFlags = /JAMMED into 75%/.test(sub) && /\u25a6 Passes subset/.test(sub) &&
                 /play a record of a different length/.test(sub);
    // A CADENCE is the OTHER honest answer: four chords are not four bars, and
    // nothing is jammed — the part simply IS 3 bars.
    const cad = run((pr) => { pr.chords[5].bars = 0.5; pr.chords[6].bars = 0.5; });
    o.cadenceHonest = /Chorus .* 4 chords = 3 bars .* cadence 0\.5/.test(cad) &&
                      /lengths agree/.test(cad) && !/JAMMED/.test(cad);
    // …and it says what a layer that never engaged ◫ Per part is doing
    delete L().partFor; delete L().parts; delete L().partAll; E.getCfg();
    const shared = String(window.bloomPartWatch() || '');
    o.sharedNamed = /Everywhere: ONE cycle/.test(shared);
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svParts) L().parts = JSON.parse(svParts); else delete L().parts;
      if (svAll) L().partAll = JSON.parse(svAll); else delete L().partAll;
      E.getCfg();
      const h = document.getElementById('bloom-v2-layers');
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; } });
  ok('bloomPartWatch names when a pass plays a record of a different length \u2014 and when it does not',
    partWatchRun && !partWatchRun.err && partWatchRun.exists && partWatchRun.plainAgrees &&
    partWatchRun.subFlags && partWatchRun.cadenceHonest && partWatchRun.sharedNamed,
    JSON.stringify(partWatchRun));

  // ✎ EDIT HOLDS THE RECORD IT IS EDITING, AT THAT RECORD'S OWN LENGTH.
  // The record DRAWN and the window it is drawn OVER must be the same length,
  // and only VIEW gets that for free (it follows the sounding part). EDIT pins
  // the EDITED record — and with another part sounding, that part's pass is a
  // different length, so the picture laid a 5-bar record across a 4-bar window:
  // measured `ruler 4 · 27 notes · record 5 bars`, re-drawn every time the
  // arrangement moved ("the visualization was totally different when it cycled
  // back and playback wasn't lining up with it"). Held now, with NO playhead —
  // nothing is playing that record, so a sweep would be a false claim — and
  // the sweep has to make the SAME call or its cs comparison re-triggers the
  // draw every frame (the flashing bug).
  // 240bpm so a bar is 1s: part A = 5s, part B = 4s, so ~8s reaches part B.
  const vmHoldRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const c0 = E.getCfg();
    const svProg = c0.prog ? JSON.stringify(c0.prog) : 'null', svBpm = c0.bpm;
    const svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svParts = L().parts ? JSON.stringify(L().parts) : null,
          svAll = L().partAll ? JSON.stringify(L().partAll) : null;
    const svVm = window._v2.vizModeOf(L());
    const mk = (r) => r.map((x) => ({ root: x, intervals: [0, 4, 7] }));
    E.getCfg().bpm = 240;
    E.getCfg().prog = { on: true, parts: [{ name: 'Verse', len: 5 }, { name: 'Chorus', len: 4 }],
      chords: mk([0, 2, 4, 5, 7, 0, 9, 2, 7]) };
    L().on = true; L().present = true;
    L().part.kind = 'live'; L().part.bars = 5;
    L().part.rhythm = { kind: 'euclid', steps: 20, pulses: 9, rotate: 0 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg(); window._v2.partSelect(E, L(), 0); E.getCfg();
    // the two records are VISIBLY different, so "which one is drawn" is legible
    L().parts['1'].rhythm = { kind: 'pulse', n: 4 };
    L().parts['1'].pitch = { kind: 'walk', span: 3 };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    card().classList.remove('collapsed');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    card().classList.remove('collapsed');
    const o = {};
    try { await Tone.start(); } catch (e) {}
    const sample = () => {
      const cv = card().querySelector('.v2-vizcv'); if (!cv || !cv._barsGeo) return null;
      let sp = -1;
      try { const w = _ambPartChordAt(E, E.getCfg(), Tone.now()); sp = w ? (w.pi | 0) : -1; } catch (e) {}
      // …and WHAT THE CARD SAYS about whose record it is showing
      const lb = (card().querySelector('.v2-vizlab') || {}).textContent || '';
      return { sp, ruler: Math.round(cv._barsGeo.barsF * 100) / 100,
               notes: (cv._hits || []).length, rec: L().part.bars,
               says: /\ud83d\udc41 showing /.test(lb) ? lb.slice(lb.indexOf('\ud83d\udc41')) : '' };
    };
    for (const mode of ['view', 'edit']) {
      // RESTATED: the two mode buttons became ONE select (view/edit/draw/
      // multi) — three of the four combinations they offered meant the same
      // thing. Same contract: the mode is driven through the real control.
      const msl = card().querySelector('.v2-modepick');
      if (msl) { msl.value = mode; msl.dispatchEvent(new Event('input', { bubbles: true })); }
      await wait(220);
      o[mode + 'Mode'] = window._v2.vizModeOf(L());
      const cv0 = card().querySelector('.v2-vizcv');
      const proto = CanvasRenderingContext2D.prototype, oCR = proto.clearRect;
      let redraws = 0;
      proto.clearRect = function (x, y, w2) {
        try { if (this.canvas === cv0 && w2 >= cv0.width - 2) redraws++; } catch (e) {}
        return oCR.apply(this, arguments);
      };
      // PLAY NOW STARTS FROM THE CURRENT PART (the ⇶ strip's selection), so a
      // check that cares WHICH part is sounding has to say where it starts —
      // an earlier check's selection would otherwise decide it. Cleared, which
      // is the from-the-top behaviour this check was written against.
      delete E._curPart;
      _ambStartGenerator(E);
      const by = {};
      let forced = false;
      for (let i = 0; i < 22; i++) {
        await wait(500);
        let r2 = sample(); if (!r2) continue;
        // SETTLED READS ONLY: `sp` comes from the CLOCK and the picture from the
        // CANVAS, which is one draw behind at a part boundary — so a transient
        // pairing (part 1's ruler over part 0's record) can be recorded as if
        // it were a state, and it was (one run in several). Two reads a beat
        // apart, kept only when the sounding part has not moved between them.
        await wait(140);
        const r2b = sample();
        if (!r2b || r2b.sp !== r2.sp) continue;
        r2 = r2b;
        // FORCE A REBUILD ONCE while the OTHER part sounds. `drawPartViz` and
        // the sweep each carry the guard, and the sweep's alone hides the
        // draw's: with the sweep holding, nothing re-draws, so a stale but
        // correct picture survives and a draw-side regression is invisible
        // (measured — that poison passed). `V2.render` is the path an ordinary
        // edit takes, and it goes through the draw's own guard.
        if (!forced && r2.sp === 1) {
          forced = true;
          if (h) h._sig = ''; window._v2.render(E); await wait(220);
          card().classList.remove('collapsed');
          await wait(160);
          r2 = sample(); if (!r2) continue;
        }
        (by[r2.sp] = by[r2.sp] || {})[r2.ruler + '|' + r2.notes + '|' + r2.rec] = 1;
        (o[mode + 'Says'] = o[mode + 'Says'] || {})[r2.sp] = r2.says;
      }
      o[mode + 'Forced'] = forced;
      _ambStopGenerator(E);
      proto.clearRect = oCR;
      o[mode] = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Object.keys(v)]));
      o[mode + 'Redraws'] = redraws;
      await wait(260);
    }
    // VIEW follows: part A draws its own 27-note 5-bar record, part B its own
    // 4-note 4-bar one. EDIT holds: BOTH draw the edited 5-bar record on a
    // 5-bar ruler — the ruler never disagrees with the record it is under.
    // ASSERTED AS "the expected signature is PRESENT" plus "the broken one is
    // ABSENT", never as an exact set: the sample reads the sounding part from
    // `Tone.now()` and the picture from the canvas, which is one window behind
    // at a boundary, so a correct build legitimately shows a straddling extra
    // reading (the poison printed one). The CONTRACT with teeth is the last
    // clause — in EDIT the ruler always equals the record it is under.
    const has = (m, k, want) => !!(o[m] && o[m][k] && o[m][k].indexOf(want) >= 0);
    // RESTATED 2026-09-10: these pinned the NOTE COUNT DRAWN (`5|27|5`), and the
    // drawing is a WINDOW on the part now — at a phone's width four bars of a
    // five-bar part are on screen, so 27 became 24. The count was always a
    // proxy; the claim this check's own name makes is that VIEW swaps the
    // picture between parts and EDIT does not, which is what it asserts now.
    const sigs = (m) => Object.keys(o[m] || {}).map((k) => (o[m][k] || []).join('/'));
    const vs = sigs('view'), es = sigs('edit');
    o.viewFollows = vs.length === 2 && vs[0] !== vs[1];
    o.editHolds = es.length === 2 && es[0] === es[1];
    o.editRulerMatchesRecord = Object.values(o.edit || {}).every((arr) =>
      arr.every((sig) => { const [ru, , rec] = sig.split('|'); return ru === rec; }));
    // …and never the reported shape — a 5-bar record laid across a 4-bar
    // ruler. Stated as the RELATION, not as a literal signature, for the same
    // reason: the note count is no longer the record's.
    o.editNeverSqueezes = !Object.values(o.edit || {}).some((arr) =>
      arr.some((sig) => { const [ru, , rec] = sig.split('|'); return ru !== rec; }));
    // A SWAP YOU CAN SEE BUT CANNOT NAME reads as content being lost — reported
    // verbatim once the notes were colour-coded by part ("they appeared on the
    // next part … the events I drew were gone … the colour is wrong"). Nothing
    // WAS lost; the picture had moved and the card did not say so. In VIEW the
    // readout names the part it is following and says yours is safe; in EDIT it
    // says nothing, because nothing is being followed.
    o.viewNamesOther = /showing .*Chorus/.test((o.viewSays || {})['1'] || '') &&
                       /Verse content is safe/.test((o.viewSays || {})['1'] || '') &&
                       !((o.viewSays || {})['0'] || '');
    o.editSaysNothing = !((o.editSays || {})['0'] || '') && !((o.editSays || {})['1'] || '');
    // …and neither mode thrashes the canvas (the flashing guard, both paths)
    o.noThrash = o.viewRedraws <= 14 && o.editRedraws <= 14;
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      c9.bpm = svBpm;
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svParts) L().parts = JSON.parse(svParts); else delete L().parts;
      if (svAll) L().partAll = JSON.parse(svAll); else delete L().partAll;
      E.getCfg();
      E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
      const b2 = card().querySelector('.v2-modepick');
      if (b2) { b2.value = svVm; b2.dispatchEvent(new Event('input', { bubbles: true })); }
      await wait(200);
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; } });
  ok('\u270e Edit holds the record it is editing at its OWN length; \ud83d\udc41 View follows the sounding part',
    vmHoldRun && !vmHoldRun.err && vmHoldRun.viewFollows && vmHoldRun.editHolds &&
    vmHoldRun.editRulerMatchesRecord && vmHoldRun.editNeverSqueezes && vmHoldRun.noThrash &&
    vmHoldRun.viewNamesOther && vmHoldRun.editSaysNothing,
    JSON.stringify(vmHoldRun));

  // A SHAPE'S STAMP AND ITS RULES CAN DISAGREE — "Groundwork is broken, it
  // just creates one sustained chord instead of one chord for each change"
  // (2026-09-09): the Rhythm-type select had no 'ground' option, so on a
  // Groundwork part it rendered BLANK; picking anything wrote rhythm.kind
  // while `mat` stayed 'ground', and the ⛰ press then adopted the stamp and
  // rebuilt nothing, forever. Pins all three fixes: the honest option, the
  // consistency-gated adopt, and the mem-restore repair.
  const gwDriftRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const svProg = E.getCfg().prog ? JSON.stringify(E.getCfg().prog) : 'null';
    const svPart = JSON.stringify(L().part);
    const svConfirm = window.confirm;
    window.confirm = () => true;
    const o = {};
    E.getCfg().prog = { on: true, chords: [0, 5, 7, 9].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(220);
    card().classList.remove('collapsed');
    const onsetCount = () => {
      let ns = [];
      try { ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + (L().id | 0), cycleStart: 0,
          cycleSec: (L().part.bars || 2) * 2 })) || []; } catch (e) {}
      const set = new Set();
      ns.forEach((n) => { if (n.freq > 0) set.add(Math.round(n.at * 100)); });
      return set.size;
    };
    // build Groundwork, for real
    const g1 = card().querySelector('.v2-mkpart[data-mk="ground"]');
    if (g1) g1.click(); await wait(300);
    o.built = { rk: (L().part.rhythm || {}).kind, onsets: onsetCount() };
    // the select is HONEST on a ground part (it used to render blank)
    const rsel = () => document.querySelector('.v2-layer [data-f="part.rhythm.kind"]');
    o.selFace = rsel() && rsel().selectedIndex >= 0
      ? rsel().options[rsel().selectedIndex].value : '(blank)';
    // DRIFT: the rules move to pulse while the stamp stays 'ground'
    L().part.rhythm = { kind: 'pulse', n: 1, steps: 8 }; E.getCfg();
    o.drifted = { rk: (L().part.rhythm || {}).kind, mat: L().part.mat, onsets: onsetCount() };
    // ⛰ pressed again must REBUILD, not adopt the stamp
    if (h) h._sig = ''; window._v2.render(E); await wait(220);
    card().classList.remove('collapsed');
    const g2 = card().querySelector('.v2-mkpart[data-mk="ground"]');
    if (g2) g2.click(); await wait(300);
    o.rebuilt = { rk: (L().part.rhythm || {}).kind, onsets: onsetCount() };
    // POISONED MEM: a filed ground spec carrying the drift is repaired on restore
    L().part.mem = { ground: { rhythm: { kind: 'pulse', n: 1, steps: 8 } } };
    L().part.rhythm = { kind: 'pulse', n: 1, steps: 8 }; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(220);
    card().classList.remove('collapsed');
    const g3 = card().querySelector('.v2-mkpart[data-mk="ground"]');
    if (g3) g3.click(); await wait(300);
    o.memRepaired = { rk: (L().part.rhythm || {}).kind, onsets: onsetCount() };
    window.confirm = svConfirm;
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      L().part = JSON.parse(svPart); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('⛰ a drifted Groundwork part REBUILDS on the next press — stamp alone never adopts, mem restore is repaired, the select names ground',
    gwDriftRun.built && gwDriftRun.built.rk === 'ground' && gwDriftRun.built.onsets === 4 &&
    gwDriftRun.selFace === 'ground' &&
    gwDriftRun.drifted && gwDriftRun.drifted.onsets === 1 &&
    gwDriftRun.rebuilt && gwDriftRun.rebuilt.rk === 'ground' && gwDriftRun.rebuilt.onsets === 4 &&
    gwDriftRun.memRepaired && gwDriftRun.memRepaired.rk === 'ground' && gwDriftRun.memRepaired.onsets === 4,
    JSON.stringify(gwDriftRun));

  ok('⛰ the Groundwork rows are legible in the Generated panel — one-line cells, grid full-width',
    gwRun.cellOneLine && gwRun.popFits && gwRun.gridFullWidth && gwRun.onePara &&
    gwRun.cellH <= 72,
    JSON.stringify({ popH: gwRun.popH, cellH: gwRun.cellH, popFits: gwRun.popFits,
      cellOneLine: gwRun.cellOneLine, gridFullWidth: gwRun.gridFullWidth,
      onePara: gwRun.onePara }));

  // ⚙ SHAPE… — the four Generated shapes and the knobs that decide what each
  // one produces, in ONE panel. Four buttons in the row put every choice on
  // screen and left nowhere for the parameters, which sat three tabs away in
  // Rhythm, Pattern and Pitch.
  const genRun = await page.evaluate(async () => {
    // A MATERIAL PRESS ASKS FIRST now (it replaces the notes), and a native
    // confirm is AUTO-DISMISSED in puppeteer — so a probe that drives these
    // doors has to answer it, or the door correctly does nothing.
    const svConfirm = window.confirm; window.confirm = () => true;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    L().on = true; L().present = true; L().part.kind = 'live'; E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    const knobs = () => [...document.querySelectorAll('.v2-genrows .ambient-ctrl')]
      .filter((x) => x.getBoundingClientRect().height > 0)
      .map((x) => ((x.querySelector('label') || {}).textContent || '').split('\u00b7')[0].trim());
    const o = { rowShapes: card().querySelectorAll('.v2-matrow .v2-mkpart, .v2-matrow .v2-rollrun').length };
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(320);
    // RE-QUERY after every press: choosing a shape re-renders the card, so a
    // captured node is detached and clicking it does nothing (the documented
    // trap — it read as "Roll did not take" on a working panel).
    const pop = () => document.querySelector('.v2-layer .v2-shapepop');
    const r = pop().getBoundingClientRect();
    // ON SCREEN and inside the visible band — it opens from inside the sheet,
    // so it has the same status-bar/header problem the sheet had
    o.onScreen = r.width > 0 && r.height > 0 && r.top >= 40 && r.bottom <= innerHeight + 1;
    o.shapes = [...pop().querySelectorAll('.v2-genshapes .ambient-seg')].length;
    // SET the shape rather than inheriting whatever the last check left — the
    // part arrived as an arpeggio and the knob comparison read its knobs (the
    // documented "a structural check must SET the state it measures").
    pop().querySelector('.v2-mkpart[data-mk="sustain"]').click(); await wait(420);
    o.sustainKnobs = knobs();
    // CHOOSING KEEPS IT OPEN — a panel that shuts on every choice cannot be
    // used to compare shapes
    pop().querySelector('.v2-rollrun').click(); await wait(420);
    o.openAfterChoice = card().classList.contains('v2-genopen');
    o.kindAfter = L().part.pitch.kind;
    o.rollKnobs = knobs();
    // …and the knobs are the ones that shape THIS shape
    o.knobsFollow = o.rollKnobs.indexOf('Range') >= 0 && o.sustainKnobs.indexOf('Range') < 0 &&
      o.sustainKnobs.indexOf('Notes at once') >= 0;
    // A KNOB COMMITS, without rebuilding the card under the finger…
    const sp = document.querySelector('.v2-genrows [data-f="part.pitch.span"]');
    if (sp) { sp.value = '9'; sp.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(240);
    o.committed = (L().part.pitch.span | 0) === 9;
    o.stillOpen = card().classList.contains('v2-genopen');
    // …and the copies do not DRIFT — restated 2026-09-16 for staging: the
    // panel's copy holds the staged value, the card's copy keeps the LAYER's
    // until ✓ Done, and after Done every copy agrees on the written value
    const inPanel = (x) => !!x.closest('.v2-genwrap, .v2-autowrap');
    const spans = () => [...document.querySelectorAll('.v2-layer .v2-f[data-f="part.pitch.span"]')];
    o.copies = spans().map((x) => (inPanel(x) ? 'p' : 'c') + x.value).join(',');
    const realSpan = String(window.__Lreal(E).part.pitch.span | 0);
    o.stagedApart = spans().every((x) => inPanel(x) ? x.value === '9' : x.value === realSpan);
    // the card still says which shape is in force WITHOUT opening the panel
    card().querySelector('.v2-shapepop .v2-gendone').click(); await wait(240);
    o.copiesAfter = spans().map((x) => x.value).join(',');
    o.noDrift = o.stagedApart && spans().length > 0 && spans().every((x) => x.value === '9');
    o.closed = !card().classList.contains('v2-genopen');
    o.doorNames = (document.querySelector('.v2-genface') || {}).textContent || '';
    // NO DUPLICATE-CLASS TRAP: the panel's own actions must not answer to the
    // card's selectors, or a probe finds the hidden copy first (it did, twice)
    o.oneNewTake = document.querySelectorAll('.v2-layer .v2-newtake').length;
    o.onePopPrev = document.querySelectorAll('.v2-layer .v2-pop-preview').length;
    try {
      L().part = JSON.parse(sv); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    window.confirm = svConfirm;
    return o;
  });
  ok('⚙ Shape… holds the four shapes AND the knobs that shape them, in one panel',
    genRun.rowShapes === 0 && genRun.onScreen && genRun.shapes === 5 &&
    genRun.openAfterChoice && genRun.kindAfter === 'walk' && genRun.knobsFollow &&
    genRun.committed && genRun.stillOpen && genRun.noDrift && genRun.closed &&
    /Roll/.test(genRun.doorNames) && genRun.oneNewTake === 1 && genRun.onePopPrev === 1,
    JSON.stringify(genRun));

  // ---- THE PANEL'S CONTROLS EARN THEIR RANGES (2026-09-08, user: "generated
  // menu is very buggy — some parameter changes don't do anything for most
  // values, some don't update their readouts, some shouldn't be sliders").
  // Three contracts from that sweep: (1) Grid is a ± STEPPER whose press
  // commits and re-renders WITHOUT closing the panel — as a slider, the
  // steps commit's V2.render replaced the input on the FIRST input event and
  // the rest of the drag wrote nothing; (2) the euclid bounds FOLLOW the
  // Grid (pulses max = steps, Push max = steps−1) — a 1..32 pulses slider
  // under an 8-step grid had 24 values that normalize silently clamped away;
  // (3) a raw slider's OWN readout follows the drag — nothing else writes
  // `.ambient-sl-v` on an un-knobbed slider, and the mirror skips `el2 === f`.
  const genCtlRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 5 };
    L().part.pitch = { kind: 'walk', span: 3 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(300);
    const ctl = (f2) => document.querySelector('.v2-layer .v2-shapepop .v2-f[data-f="' + f2 + '"]');
    const o = {};
    const steps0 = ctl('part.rhythm.steps');
    o.gridIsStepper = !!steps0 && steps0.classList.contains('ambient-step-inp');
    o.bounds0 = { pulsesMax: +(ctl('part.rhythm.pulses') || {}).max,
                  pushMax: +(ctl('part.rhythm.rotate') || {}).max };
    const up = steps0 && steps0.closest('.ambient-ctrl').querySelector('.ambient-step-up');
    if (up) up.click(); await wait(400);
    card().classList.remove('collapsed');
    o.stepsAfter = (L().part.rhythm || {}).steps | 0;
    o.inputShows = +((ctl('part.rhythm.steps') || {}).value || 0);
    o.panelOpen = card().classList.contains('v2-genopen');
    o.bounds1 = { pulsesMax: +(ctl('part.rhythm.pulses') || {}).max,
                  pushMax: +(ctl('part.rhythm.rotate') || {}).max };
    const sl2 = ctl('part.shape.lenRatio');
    if (sl2) { sl2.value = '42'; sl2.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(200);
    const sl3 = ctl('part.shape.lenRatio');
    const rd3 = sl3 && sl3.closest('.ambient-ctrl').querySelector('.ambient-sl-v');
    o.sliderIsSlider = !!sl3 && sl3.classList.contains('ambient-sl');
    o.readout = rd3 ? rd3.textContent : '(none)';
    const gc4 = document.querySelector('.v2-layer .v2-shapepop .v2-gendone');
    if (gc4) gc4.click(); await wait(200);
    try { L().part = JSON.parse(sv); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(200);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return o;
  });
  ok('Generated panel: Grid is a stepper that commits with the panel open, and the euclid bounds follow it',
    genCtlRun.gridIsStepper && genCtlRun.stepsAfter === 9 && genCtlRun.inputShows === 9 &&
    genCtlRun.panelOpen &&
    genCtlRun.bounds0.pulsesMax === 8 && genCtlRun.bounds0.pushMax === 7 &&
    genCtlRun.bounds1.pulsesMax === 9 && genCtlRun.bounds1.pushMax === 8,
    JSON.stringify(genCtlRun));
  // ── PUSH 0 MEANS NO PUSH, AND NO NUMBER IS BARE ─────────────────────────
  // (2026-09-09, user: "Push is buggy, at 0 all notes are set forward 3 values"
  // and "the numeric values in the Generated menu are not all intelligible").
  // TWO defects, both mechanical. (1) `euclideanPattern`'s accumulator tests
  // AFTER adding, so its first hit lands at `ceil(steps/pulses) - 1` and never
  // on step 0: 5 of 8 begins on step 1, 2 of 8 on step 3 (the reported "forward
  // 3"), 1 of 8 on step 7. v2 normalises the phase; v1's generator is
  // deliberately untouched, since re-phasing it would silently re-rhythm every
  // saved project. (2) `_ambSlUnit` reads the LAST id segment, and this panel's
  // second copies carry `-gen`, so EVERY slider here looked up the unit for
  // "gen", found none, and rendered a bare number.
  const pushRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const sv = JSON.stringify(L().part);
    const o = {};
    // (1) EVERY density starts on the beat at Push 0 — the sparser the pattern
    // the worse the old offset was, so the sparse cases are the ones with teeth
    o.first = {};
    [[5, 8], [3, 8], [2, 8], [1, 8], [3, 16], [9, 20]].forEach(([k, n]) => {
      o.first[k + '/' + n] = window._v2.euclidCells(k, n, 0).indexOf(1);
    });
    o.allStartOnBeat = Object.values(o.first).every((x) => x === 0);
    // …and ONE step of Push moves it by exactly one, wrapping home at `steps`
    const at = (r) => window._v2.euclidCells(5, 8, r).join('');
    const rot1 = (t) => t.slice(1) + t.slice(0, 1);
    o.pushIsOneStep = at(1) === rot1(at(0)) && at(2) === rot1(at(1));
    o.pushWraps = at(8) === at(0);
    // (2) what the EMITTER places — the claim is about the notes, not the grid
    L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 2;
    L().part.pitch = { kind: 'chord', voices: 1 };
    const cyc = 2 * ((60 / (E.getCfg().bpm || 120)) * 4);
    const ons = (rh) => { L().part.rhythm = rh; E.getCfg();
      const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: cyc })) || [];
      return [...new Set(ns.map((n) => Math.round((n.at / cyc) * ((rh.steps | 0) || 8))))]
        .sort((a, b) => a - b).join(','); };
    o.emit2of8 = ons({ kind: 'euclid', steps: 8, pulses: 2, rotate: 0 });
    o.emitPush2 = ons({ kind: 'euclid', steps: 8, pulses: 2, rotate: 2 });
    // the MULTI-VOICE branch never touches euclidCells — it asks v1's per-voice
    // builder directly, so it needs the same shift or a polyrhythm keeps the
    // old offset while a single-voice part is fixed
    o.emitVoices = ons({ kind: 'euclid', steps: 8, pulses: 2, rotate: 0, voices: 3 });
    o.voice0OnBeat = /^0,/.test(o.emitVoices);
    // (3) NO BARE NUMBERS in the panel: every visible row's value carries a
    // unit, or a hint that names one. A slider folds its hint into a `title`,
    // which a phone never shows, so a bare slider readout names nothing.
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 5, rotate: 0 };
    L().part.pitch = { kind: 'mixed', voices: 3 };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(320);
    const rows = [...document.querySelectorAll('.v2-genrows .ambient-ctrl')]
      .filter((x) => x.getBoundingClientRect().height > 0);
    o.bare = rows.map((r) => {
      const rd = r.querySelector('.ambient-sl-v');
      if (!rd) return null;                       // a stepper's hint renders visibly
      const hint = [...r.querySelectorAll('.ambient-hint')]
        .filter((x) => !x.classList.contains('ambient-sl-v'))
        .map((x) => x.textContent.trim()).filter(Boolean)[0] || '';
      const v = rd.textContent.trim();
      return (/^-?\d+$/.test(v) && !hint)
        ? (((r.querySelector('label') || {}).textContent || '?').trim() + '=' + v) : null;
    }).filter(Boolean);
    o.noBare = o.bare.length === 0;
    o.sampleReadouts = rows.map((r) => { const rd = r.querySelector('.ambient-sl-v');
      return rd ? rd.textContent.trim() : null; }).filter(Boolean);
    const gc = document.querySelector('.v2-layer .v2-shapepop .v2-gendone'); if (gc) gc.click();
    await wait(220);
    try { L().part = JSON.parse(sv); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(220);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; } });
  ok('Push 0 means NO push — every density starts on the beat, and one step moves it by one',
    pushRun && !pushRun.err && pushRun.allStartOnBeat && pushRun.pushIsOneStep &&
    pushRun.pushWraps && pushRun.emit2of8 === '0,4' && pushRun.emitPush2 === '2,6' &&
    pushRun.voice0OnBeat,
    JSON.stringify({ first: pushRun && pushRun.first, emit2of8: pushRun && pushRun.emit2of8,
      emitPush2: pushRun && pushRun.emitPush2, voices: pushRun && pushRun.emitVoices }));
  ok('no number in the Generated panel is bare — a slider readout carries its unit',
    pushRun && !pushRun.err && pushRun.noBare,
    JSON.stringify({ bare: pushRun && pushRun.bare, readouts: pushRun && pushRun.sampleReadouts }));

  ok('Generated panel: a slider’s own right-gutter readout follows the drag, WITH its unit',
    // RESTATED 2026-09-09: the readout says "42%", not "42". A slider folds its
    // hint into a `title`, which a phone never shows, so the unit in the
    // readout is the only thing naming what the number means — reported as
    // "the numeric values are not all intelligible". `_ambSlUnit` reads the
    // LAST id segment and this panel's second copies carry a `-gen` suffix, so
    // every slider here looked up the unit for "gen" and found none.
    // RESTATED AGAIN 2026-09-11, same contract, one clause stronger: "42%" is
    // a percentage of NOTHING NAMED, and this is the control that decides
    // whether a note reaches the next grid line — reported as "a note 1 bar
    // long should fit the bar" against a picture that was honest about a note
    // 90% of its slot. The readout names the relationship now, so the check
    // asserts the value follows the drag AND that the number says what it is
    // a percentage OF.
    genCtlRun.sliderIsSlider && /^42%/.test(genCtlRun.readout || '') &&
      /slot/.test(genCtlRun.readout || ''),
    JSON.stringify(genCtlRun));

  // ── THE PANEL IS THE MODEL, NOT FIVE PRESETS (2026-09-09, user: "condense
  // the top options and expose more parameters for expressiveness").
  // MEASURED BEFORE, at 390x780: head 56 + a STATIC 44px model paragraph +
  // 162px of two-line shape chips + 48px of live line + 61px of actions =
  // 371px of furniture in a 617px panel (60%), leaving 232px that held FIVE
  // knobs of the fifteen defined. The panel stated "a RHYTHM x a PITCH RULE"
  // in prose and let you touch NEITHER axis — the two selects that name them
  // sat three tabs away — so a hand-built combination was unreachable from
  // the one surface whose whole job is choosing one.
  // Four contracts here, each of which was a real hole:
  //   (1) BOTH AXES are controls in the panel, they commit, and the OTHER
  //       copy on the card follows (a commit does not rebuild — two copies of
  //       one field is the documented drift bug);
  //   (2) picking an axis RE-GATES the knobs, so the panel shows the handful
  //       that shape THAT combination;
  //   (3) the shape-specific knobs each shape needs are present — Direction
  //       for the arpeggio above all, which was missing while the panel
  //       offered Arpeggio as one of its five doors;
  //   (4) the second tier is a FOLD, shut by default, and a gated-OUT row
  //       inside an OPEN fold stays hidden — `applyGate` writes '' to show a
  //       row, so `.v2-sub`'s display:none still wins; inline 'none' beats the
  //       fold. Both directions, or the fold and the gate fight.
  const genAxisRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const svConfirm = window.confirm; window.confirm = () => true;
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 5 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    // PRESS THE DOOR — setting `v2-genopen` by hand leaves the module's own
    // GENPOP unset, so the first re-render shuts the panel and every later
    // measurement reads 0x0 (it did).
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(320);
    const pop = () => document.querySelector('.v2-layer .v2-shapepop');
    const rows = () => [...pop().querySelectorAll('.v2-genrows .ambient-ctrl')]
      .filter((x) => x.getBoundingClientRect().height > 0)
      .map((x) => ((x.querySelector('label') || {}).textContent || '?').trim());
    const o = {};
    const pr = pop().getBoundingClientRect();
    o.fits = pr.width > 0 && pr.top >= 40 && pr.bottom <= innerHeight + 1;
    // the fold's open state now survives rebuilds, so an earlier check may
    // have left it open — shut it through its own button first
    if (card().classList.contains('v2-so-recipe')) {
      const f0 = pop().querySelector('.v2-discbtn[data-disc="recipe"]'); if (f0) { f0.click(); await wait(200); } }
    { const t0 = pop().querySelector('.v2-fttab[data-ft="rhythm"]'); if (t0) { t0.click(); await wait(200); } }
    // THE MAIN TIER IS SHORT (2026-09-16, "overloaded… simplify"): measured on
    // the euclid × chord part before anything is opened. RESTATED 2026-09-17:
    // Fine-tune is four TABS now, not a fold, so the main tier is every row
    // that is neither on a tab nor inside ⚠ Advanced: recipe.
    o.mainRows = [...pop().querySelectorAll('.v2-genrows .ambient-ctrl:not(.v2-ft):not(.v2-sub)')]
      .filter((x) => x.getBoundingClientRect().height > 0)
      .map((x) => ((x.querySelector('label') || {}).textContent || '?').trim());
    // the axes live behind ⚠ Advanced: recipe now — open it for (1)–(3)
    const db0 = () => document.querySelector('.v2-layer .v2-shapepop .v2-discbtn[data-disc="recipe"]');
    if (db0() && !card().classList.contains('v2-so-recipe')) { db0().click(); await wait(220); }
    o.noStaticPara = pop().querySelectorAll('.v2-genmodel').length === 0;
    // (1)+(2) THE RHYTHM AXIS
    const rs = () => pop().querySelector('.v2-genrows [data-f="part.rhythm.kind"]');
    // GUARDED: a MISSING control is precisely the regression this hunts, and
    // an unguarded write on null throws and kills the whole run — which tells
    // you less than one red line (the documented rule, in select form).
    o.rhythmIsHere = !!rs();
    if (rs()) { rs().value = 'chance'; rs().dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(300);
    o.rhythmWrote = L().part.rhythm.kind === 'chance';
    o.rhythmRows = rows();
    // Syncopate is read ONLY by the chance walk, so it appears with it and
    // never on a euclid part — a knob that does nothing is the whole reason
    // these are gated
    // RESTATED 2026-09-10: the euclid-only row is labelled 'Steps' now — it is
    // per CYCLE, and 'Grid' is the per-BAR note value on the surface's own
    // footer. Two controls over two different quantities sharing one name was
    // the naming rule's own mistake. Same contract; a stale 'Grid' here would
    // have passed trivially, which is worse than failing.
    o.regated = o.rhythmRows.indexOf('Chance') >= 0 && o.rhythmRows.indexOf('Syncopate') >= 0 &&
                o.rhythmRows.indexOf('Steps') < 0 && o.rhythmRows.indexOf('Grid') < 0;
    // RESTATED 2026-09-15 — there is ONE copy of this field on the card now.
    // This pinned "two copies agree" because a commit does not rebuild, so the
    // sheet's Rhythm-type select and the panel's had to be mirrored; the sheet's
    // was a duplicate saying "Rhythm type" for what the panel calls "Rhythm",
    // and it is gone with the rest of the second tier. The drift it guarded
    // against cannot happen to a single control — so the claim becomes the
    // stronger one underneath it: exactly one control writes this field, and it
    // is the panel's, holding the value that was just committed.
    o.rhythmCopies = [...card().querySelectorAll('.v2-f[data-f="part.rhythm.kind"]')].map((x) => x.value);
    o.rhythmAgrees = o.rhythmCopies.length === 1 && o.rhythmCopies[0] === L().part.rhythm.kind &&
      !!pop().querySelector('.v2-genrows [data-f="part.rhythm.kind"]');
    // (1)+(3) THE PITCH AXIS — this one re-renders the card, so re-query
    const ps = () => document.querySelector('.v2-layer .v2-genrows [data-f="part.pitch.kind"]');
    o.pitchIsHere = !!ps();
    if (ps()) { ps().value = 'series'; ps().dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(420);
    o.pitchWrote = L().part.pitch.kind === 'series';
    o.stillOpen = document.querySelector('.v2-layer').classList.contains('v2-genopen');
    // STAGED: the panel's copy is the edit, the card's copy is still the layer
    const pk = [...document.querySelectorAll('.v2-layer .v2-f[data-f="part.pitch.kind"]')];
    o.pitchCopies = pk.map((x) => x.value);
    o.pitchAgrees = pk.length === 2 &&
      pk.every((x) => x.closest('.v2-genwrap') ? x.value === 'series' : x.value === window.__Lreal(E).part.pitch.kind);
    o.arpRows = rows();
    // THE ARPEGGIO'S OWN KNOB. It writes, which is the claim — a select that
    // renders and commits nothing is the state this whole panel was in.
    const dsel = pop().querySelector('.v2-genrows [data-f="part.pitch.dir"]');
    o.dirIsHere = !!dsel;
    if (dsel) { dsel.value = 'updown'; dsel.dispatchEvent(new Event('input', { bubbles: true })); await wait(260); }
    o.dirWrote = L().part.pitch.dir === 'updown';
    // HARMONY, from inside the panel — a SET, and its handler re-renders, so
    // BOTH copies must come back lit
    const hb = pop().querySelector('.v2-genrows .v2-harm[data-harm="2"]');
    o.harmIsHere = !!hb;
    if (hb) { hb.click(); await wait(380); }
    o.harmWrote = JSON.stringify(L().part.pitch.harm || null) === '[{"deg":2}]';
    // EVERY copy comes back lit — the sheet's, and the panel's two (main tier
    // for single-note shapes, ▸ Fine-tune for chord shapes; one is gated off)
    // …the panel's copies lit, the card's (the layer's) not — until ✓ Done
    const hc = [...document.querySelectorAll('.v2-layer .v2-harm[data-harm="2"]')];
    o.harmLitBoth = hc.length >= 2 &&
      hc.filter((x) => x.closest('.v2-genwrap')).every((x) => x.classList.contains('on')) &&
      hc.filter((x) => !x.closest('.v2-genwrap')).every((x) => !x.classList.contains('on'));
    // (4) THE TABS (RESTATED 2026-09-17 — was one ▸ Fine-tune fold): a knob
    // shows on its own tab and nowhere else
    const tab = (k) => document.querySelector('.v2-layer .v2-shapepop .v2-fttab[data-ft="' + k + '"]');
    o.foldIsHere = !!tab('rhythm') && !!tab('take');
    if (tab('take')) { tab('take').click(); await wait(220); }
    const shutRows = rows(), shut = shutRows.length;
    if (tab('rhythm')) tab('rhythm').click();
    await wait(240);
    const open = rows();
    o.foldOpens = shutRows.indexOf('Hold steps') < 0 && open.indexOf('Hold steps') >= 0;
    const me = document.querySelector('.v2-layer .v2-genrows [data-f="part.shape.holdSteps"]');
    if (me) { me.value = '7'; me.dispatchEvent(new Event('input', { bubbles: true })); await wait(260); }
    o.foldCommits = (L().part.shape.holdSteps | 0) === 7;
    // A GATED-OUT ROW ON THE OPEN TAB STAYS HIDDEN — Roam reads only
    // fixed/stack/chord pitch, and this part is a series
    if (tab('notes')) { tab('notes').click(); await wait(220); }
    const roam = document.querySelector('.v2-layer .v2-genrows [data-f="part.pitch.roam"]');
    o.gateBeatsFold = !!roam && roam.closest('.ambient-ctrl').getBoundingClientRect().height === 0;
    if (tab('take')) tab('take').click();
    await wait(220);
    o.foldShuts = rows().indexOf('Hold steps') < 0;
    { const f1 = document.querySelector('.v2-layer .v2-shapepop .v2-discbtn[data-disc="recipe"]');
      if (f1 && document.querySelector('.v2-layer').classList.contains('v2-so-recipe')) { f1.click(); await wait(200); } }
    // THE SELECT IS RE-SYNCED. 'drawn' is internal and has no option, so a
    // select left on it renders BLANK — and a blank select is what invites the
    // pick that drifts the rules (the Groundwork bug). Changed WITHOUT a
    // rebuild (a rebuild would set it from `rhythmShown` and prove nothing),
    // then committed on an unrelated field so `applyGate` is the only thing
    // that can have fixed it.
    // RESTATED 2026-09-15 with the consolidation: "BOTH selects" was the sheet's
    // copy and the panel's, and the sheet's is gone — so the count is 1 and the
    // sync claim is about the one control that is left. `applyGate` still has to
    // do it; nothing else writes that value back.
    L().part.rhythm.kind = 'drawn'; E.getCfg();
    const nl = pop().querySelector('.v2-genrows [data-f="part.shape.lenRatio"]');
    if (nl) { nl.value = '80'; nl.dispatchEvent(new Event('input', { bubbles: true })); await wait(280); }
    o.drawnSel = [...document.querySelectorAll('.v2-layer [data-f="part.rhythm.kind"]')].map((x) => x.value);
    o.drawnSynced = o.drawnSel.length === 1 && o.drawnSel.every((v) => v === 'euclid');
    // …AND THE PANEL STILL HOLDS MORE KNOBS THAN IT USED TO. Five was the
    // measured before-count on the default euclid/chord shape; the accretion
    // this replaces was the OPPOSITE problem, so the clause has teeth in the
    // direction that regressed.
    o.knobCount = shut;
    const gc = document.querySelector('.v2-layer .v2-shapepop .v2-gendone'); if (gc) gc.click();
    await wait(220);
    try { L().part = JSON.parse(sv); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(220);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    window.confirm = svConfirm;
    return o;
  });
  ok('⚙ Generated: BOTH axes are controls, they re-gate the knobs, and the second tier folds',
    genAxisRun.fits && genAxisRun.noStaticPara &&
    genAxisRun.rhythmIsHere && genAxisRun.rhythmWrote && genAxisRun.regated && genAxisRun.rhythmAgrees &&
    genAxisRun.pitchIsHere && genAxisRun.pitchWrote && genAxisRun.stillOpen && genAxisRun.pitchAgrees &&
    genAxisRun.dirIsHere && genAxisRun.dirWrote &&
    genAxisRun.harmIsHere && genAxisRun.harmWrote && genAxisRun.harmLitBoth &&
    genAxisRun.foldIsHere && genAxisRun.foldOpens && genAxisRun.foldCommits &&
    // RESTATED 2026-09-16: the shut panel is the SHORT tier — at most five rows
    // (it was ≥8, when the complaint was the opposite one). RESTATED 2026-09-17:
    // plus the Tuned line, and it ends on the ⚠ Advanced: recipe fold
    genAxisRun.gateBeatsFold && genAxisRun.foldShuts &&
    genAxisRun.mainRows.length >= 3 && genAxisRun.mainRows.length <= 6 &&
    genAxisRun.mainRows.some((x) => x === 'Tuned' || x === 'Changed') &&
    genAxisRun.mainRows[genAxisRun.mainRows.length - 1] === '\u26a0 Advanced: recipe' &&
    genAxisRun.drawnSynced,
    JSON.stringify(genAxisRun));

  // ⚇ MIXED — the fourth Generated door: chords AND single notes from one
  // part. The other three each commit to one texture (Sustained is always a
  // chord, Arpeggio and Roll always one note at a time), so "both" could only
  // be hand-built on the knobs.
  const mixRun = await page.evaluate(async () => { try {
    // A MATERIAL PRESS ASKS FIRST now (it replaces the notes), and a native
    // confirm is AUTO-DISMISSED in puppeteer — so a probe that drives these
    // doors has to answer it, or the door correctly does nothing.
    const svConfirm = window.confirm; window.confirm = () => true;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part), c0 = E.getCfg();
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    c0.keyOn = true; c0.keyRoot = 0; c0.keyScale = 'major'; c0.keyFollow = false;
    E.getCfg();
    L().on = true; L().present = true;
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    const o = {};
    // the shapes live behind ⚙ Shape… now
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(300);
    const btn = document.querySelector('.v2-layer .v2-shapepop .v2-mkpart[data-mk="mixed"]');
    o.door = !!btn;
    o.sub = btn ? btn.textContent : '';
    if (btn) btn.click();
    await wait(450);
    const gcM = document.querySelector('.v2-layer .v2-shapepop .v2-gendone');
    if (gcM) gcM.click();
    await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    o.kind = L().part.pitch.kind; o.mat = L().part.mat;
    // BOTH TEXTURES, and the balance actually moves them. Counted as onsets
    // carrying more than one note vs exactly one — which is the whole claim.
    const tally = (mix) => {
      if (mix != null) L().part.pitch.mix = mix;
      E.getCfg();
      let ch = 0, one = 0;
      for (let k = 0; k < 12; k++) {
        const cyc = (L().part.bars || 2) * 2;
        const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
          { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: k * cyc, cycleSec: cyc })) || [];
        const by = {};
        ns.forEach((n) => { const t = (Math.round(n.at * 1000) / 1000).toFixed(3);
          (by[t] = by[t] || []).push(1); });
        Object.values(by).forEach((g) => { if (g.length > 1) ch++; else one++; });
      }
      return { ch, one };
    };
    const mid = tally(null);
    o.both = mid.ch > 0 && mid.one > 0;
    const none = tally(0); o.allSingle = none.ch === 0 && none.one > 0;
    const all = tally(100); o.allChords = all.one === 0 && all.ch > 0;
    // seeded, so a take replays — never `Math.random` in the emit path
    L().part.pitch.mix = 50; E.getCfg();
    const shot = () => JSON.stringify(window._v2.withEdit(() => window._v2.notesFor(L(),
      { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: 4 })));
    o.deterministic = shot() === shot();
    // the balance has a REACHABLE control (rule 6) …
    // RE-QUERY: the Mixed press re-rendered the host, so the `card` captured
    // above is detached and clicking its buttons does nothing (the documented
    // trap — it read as "there is no Mix tab" on a card that has one).
    const card2 = document.querySelector('.v2-layer');
    card2.classList.remove('collapsed');
    card2.querySelector('.v2-gototab[data-goto="Pitch"]').click(); await wait(320);
    // ITS OWN TAB — a row of an inactive tab is hidden by design, so the tab
    // has to be opened before the rect means anything (measured 0 otherwise).
    const mtab = document.querySelector('.v2-pop-tabs [data-tab="Mix"]');
    o.hasTab = !!mtab;
    if (mtab) mtab.click(); await wait(200);
    const mixEl = document.querySelector('.v2-pop-pane [data-f="part.pitch.mix"]');
    o.hasControl = !!mixEl && mixEl.getBoundingClientRect().height > 0;
    await wait(180);
    // …and it is GATED to the kind that reads it — a slider that does nothing
    // on every other pitch rule is the dead-control class
    L().part.pitch = { kind: 'chord', voices: 3 }; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(240);
    const c2 = document.querySelector('.v2-layer'); c2.classList.remove('collapsed');
    c2.querySelector('.v2-gototab[data-goto="Pitch"]').click(); await wait(320);
    const gtab = document.querySelector('.v2-pop-tabs [data-tab="Mix"]');
    if (gtab) { gtab.click(); await wait(180); }
    const gone = document.querySelector('.v2-pop-pane [data-f="part.pitch.mix"]');
    o.gatedOff = !gtab || !gone || gone.getBoundingClientRect().height === 0;
    await wait(180);
    try {
      const c9 = E.getCfg();
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(sv); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    window.confirm = svConfirm;
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('⚇ Mixed makes chords AND single notes, and the balance moves them',
    mixRun.door && /Mix chords \+ notes/.test(mixRun.sub) && mixRun.kind === 'mixed' &&
    mixRun.mat === 'mixed' && mixRun.both && mixRun.allSingle && mixRun.allChords &&
    mixRun.deterministic && mixRun.hasTab && mixRun.hasControl && mixRun.gatedOff,
    JSON.stringify(mixRun));

  // WHAT IT WILL GENERATE, IN WORDS. The hint read `euclid 5 of 8 · walk ·
  // take 15` — every term correct, and no answer to "what is this going to
  // generate", reported as the whole thing being opaque.
  const saysRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    L().on = true; L().present = true;
    const h = document.getElementById('bloom-v2-layers');
    const say = async (mut) => {
      eval(mut); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(260);
      const card = document.querySelector('.v2-layer');
      card.classList.remove('collapsed');
      const el = card.querySelector('.v2-notecount');
      return el ? el.textContent.trim() : '';
    };
    const o = {};
    o.roll = await say("L().part.kind='live';L().part.bars=4;L().part.mat='roll';" +
      "L().part.rhythm={kind:'euclid',steps:8,pulses:5,rotate:2};" +
      "L().part.pitch={kind:'walk',degree:1,span:3,stutter:25}");
    o.pad = await say("L().part.rhythm={kind:'pulse',n:1};L().part.mat='sustain';" +
      "L().part.pitch={kind:'chord',voices:3};L().part.bars=2");
    o.arp = await say("L().part.rhythm={kind:'pulse',n:8};L().part.mat='arp';" +
      "L().part.pitch={kind:'series',dir:'up',span:2}");
    // WHERE THE TAKE FACT LIVES NOW. This line used to END by saying whether
    // the drawing is what plays or one take of many; that is the Every cycle
    // toggle's whole job, it sits directly beneath, and its FACE says which
    // mode is in force. RESTATED, not dropped — same contract, one surface,
    // and the reader is spared the same sentence twice.
    {
      // MOVED 2026-09-12: the dice live in Shape ▸ Every pass now, beside the
      // other two switches that make a layer differ pass to pass — asked as
      // "what is stochastic about live layers, and where are those controls
      // (they should be in one place)". Same contract, read at the new home,
      // plus the SIGNPOST the move left behind: a control that is simply gone
      // from where it was gets reported as missing (this file's own rule), so
      // Material must still name where it went.
      const c2 = document.querySelector('.v2-layer');
      c2.classList.remove('collapsed');
      window.__sec('Generate'); await wait(280);
      const mt = [...c2.querySelectorAll('.v2-pop-tabs [data-tab]')]
        .find((x) => x.getAttribute('data-tab') === 'Method');
      if (mt) { mt.click(); await wait(240); }
      // RESTATED 2026-09-13: the signpost was a LABELLED ROW with no control
      // — 51px of a 228px tab, two lines of prose — and it is a trailing
      // clause on the material line now ("this popover feels noisy and overly
      // complicated"). Same contract, read where it lives: Material still
      // names where the dice went, exactly once.
      const sign = c2.querySelector('.v2-notecount');
      o.signVis = !!sign && sign.getBoundingClientRect().height > 0;
      o.signNames = !!sign && /Every pass/.test(sign.textContent || '');
      o.signNotADupe = c2.querySelectorAll('.v2-varytoggle').length === 1 &&
        !c2.querySelector('.v2-varysign');

      window.__sec('Shape'); await wait(280);
      const et = [...c2.querySelectorAll('.v2-pop-tabs [data-tab]')]
        .find((x) => x.getAttribute('data-tab') === 'Every pass');
      if (et) { et.click(); await wait(240); }
      const row = [...c2.querySelectorAll('.ambient-ctrl')]
        .find((r2) => r2.querySelector('.v2-varytoggle'));
      o.everyFace = row ? (row.querySelector('.v2-varytoggle').textContent || '').trim() : '';
      o.everyHint = row ? ((row.querySelector('.v2-varyhint') || {}).textContent || '') : '';
      o.everyVis = !!row && row.getBoundingClientRect().height > 0;
      // …and the three switches are TOGETHER, which is the point of the move
      const labs = [...c2.querySelectorAll('.v2-pop-pane .ambient-ctrl')]
        .filter((r2) => r2.getBoundingClientRect().height > 0)
        .map((r2) => ((r2.querySelector('label') || {}).textContent || '').trim());
      o.allThree = ['Re-roll', 'Humanize', 'Vel var'].every((n) => labs.indexOf(n) >= 0);
      const ll = c2.querySelector('.v2-liveline');
      o.liveLine = ll ? (ll.textContent || '').trim() : '';
    }
    o.locked = await say("L().part.kind='recorded';L().part.made='take';" +
      "L().part.notes=[{t:0,midi:60,dur:0.2},{t:0.5,midi:64,dur:0.2}]");
    // NO JARGON: the shapes' internal names must not reach the reader. `walk`
    // and `euclid` are field values, not English.
    const jargon = /\b(euclid|walk|series|stack|anchor|chance|pulse ×|lenRatio)\b/;
    o.noJargon = !jargon.test(o.roll) && !jargon.test(o.pad) && !jargon.test(o.arp);
    // it says the two things a single drawing cannot show — the live half on
    // the Every cycle toggle, the same-every-pass half in the line itself
    o.saysReRolled = o.everyVis && /Play this take/.test(o.everyFace) &&
      /take \d+ is what plays/.test(o.everyHint) &&
      // the move is complete: one copy, all three together, a forwarding
      // address at the old home, and the tab STATES the answer rather than
      // leaving it to be worked out
      o.signVis && o.signNames && o.signNotADupe && o.allThree &&
      // 'SAME EVERY PASS', not 'STATIC' (2026-09-16): this line answers the
      // per-cycle question, and the word it used to open with now names the
      // STATE instead. The sentence under it is unchanged, so the clause that
      // has teeth about its CONTENT stays exactly as it was.
      /^FIXED/.test(o.liveLine) && /shape the material ONCE/.test(o.liveLine);
    // …and the live line must NOT repeat it. Three surfaces for one fact
    // (line, toggle, drawing readout) is how they come to disagree.
    o.noTailEcho = !/Plays take|New take rolls|Re-rolled every cycle/.test(o.roll);
    o.saysExact = /plays these notes|Plays exactly these notes/.test(o.locked);
    // …and never both at once
    o.notBoth = !(/Re-rolled/.test(o.locked) && /Plays exactly/.test(o.locked));
    // THE LINE STATES THE MATERIAL; THE HEAD STATES THE SIZE. It used to end
    // "over N bars" while the section head four pixels above already read
    // `15 notes · 6 bars` — bars twice in one open popover, three times with
    // the drawing's readout. Restated onto the stronger claim: the parameters
    // are there AND the length is not said twice.
    o.saysCounts = /5 hits/.test(o.roll) && /over 8 steps/.test(o.roll) &&
      !/over 4 bars/.test(o.roll) && !/\d+ notes?$/.test(o.locked || '');
    // …and the PITCH clause must not restate the shape phrase either: a pad
    // read "one held chord of 3 notes — one onset, held, 3 notes of the chord",
    // the same fact three times. The count is said once, by the shape.
    o.saysPitch = /wandering up to 3 notes/.test(o.roll) &&
      /one held chord of 3 notes/.test(o.pad) && !/3 notes of the chord/.test(o.pad) &&
      /sweeping the chord up/.test(o.arp);
    // THE SHAPE PHRASE — what KIND of content this is, which is the question
    // ("is Roll a run of notes? a sustained chord? several chords?"). The
    // parameter text above passes with or without it, which is why both
    // poisons went green until this was added.
    o.shapes = /a run of single notes/.test(o.roll) && /one held chord of 3 notes/.test(o.pad) &&
      /the chord, one note at a time/.test(o.arp);
    // the long form must WRAP inside the sheet, never clip (UI rule 2)
    const card = document.querySelector('.v2-layer');
    window.__sec('Generate'); await wait(320);
    const el = document.querySelector('.v2-pop-pane .v2-notecount') ||
               document.querySelector('.v2-notecount');
    if (el) {
      const r = el.getBoundingClientRect(), pr = el.parentElement.getBoundingClientRect();
      o.wraps = !(el.scrollWidth > el.clientWidth + 1) && r.right <= pr.right + 1 &&
        getComputedStyle(el).whiteSpace === 'normal';
    }
    // EVERY MATERIAL DOOR SAYS WHAT IT MAKES, ON THE BUTTON. The explanation
    // used to be a `title`, which a phone NEVER SHOWS — so on the device these
    // were five bare words and the question had no answer at the point of the
    // decision. Asserted as VISIBLE text, not merely present markup.
    // EVERY DOOR, in the row AND in the ⚙ Shape… panel — the four shapes moved
    // there, and they still have to say what they make
    const cardS = document.querySelector('.v2-layer');
    cardS.classList.remove('collapsed');
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
    await wait(280);
    // SCOPED to the row and the SHAPE panel — the Groundwork panel is closed,
    // and sweeping `.v2-genshapes` unscoped picked up its (invisible) button.
    o.subs = [...document.querySelectorAll('.v2-notesrow .ambient-seg, .v2-shapepop .v2-genshapes .ambient-seg')].map((b2) => {
      const sub = b2.querySelector('.v2-matsub');
      const r2 = sub && sub.getBoundingClientRect();
      return { face: ((b2.childNodes[0] && b2.childNodes[0].nodeValue) || '').trim(),
        sub: sub ? sub.textContent.trim() : '',
        vis: !!(r2 && r2.width > 0 && r2.height > 0),
        clipped: !!(sub && sub.scrollWidth > sub.clientWidth + 1) };
    });
    // RESTATED 2026-09-16: the SHAPE doors explain themselves with an
    // imperative face ("Roll a line", "Play the changes") and carry no
    // subtitle; the row's doors keep theirs. Either way the explanation is
    // VISIBLE text on the button, never a title.
    const isShape = (x) => !x.sub;
    o.everyDoorExplains = o.subs.length >= 7 &&
      o.subs.every((x) => isShape(x) ? x.face.length >= 8 : (x.sub.length > 3 && x.vis && !x.clipped)) &&
      o.subs.filter(isShape).length === 5;
    const gc3 = document.querySelector('.v2-layer .v2-shapepop .v2-gendone'); if (gc3) gc3.click();
    await wait(200);
    // THE MODEL IS STATED BY CONTROLS, NOT A PARAGRAPH (restated 2026-09-13).
    // It was a static 73px block — a THIRD of the tab, on every visit forever
    // — and a static block is always the first suspect: it never changes and
    // never responds. Every fact in it is carried by something that DOES, so
    // the claim is now that those surfaces exist: the two LABELLED doors state
    // the two ways, and LIVE ⟷ SAME EVERY PASS is the FIRST TOKEN of the
    // drawing's own readout, per layer and live. Strictly stronger — a
    // paragraph can say "it becomes LIVE when…" while the card never shows
    // which this one is. (The quiet pole was 'Static' until 2026-09-16; the
    // word went to the STATE, and this axis took its own.)
    const cardM = document.querySelector('.v2-layer');
    const labs2 = [...cardM.querySelectorAll('.v2-notesrow .v2-matlab')]
      .filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.textContent.trim());
    const vl = cardM.querySelector('.v2-vizlab');
    o.matLabs = labs2.length;
    o.modelStated = !document.querySelector('.v2-matmodel') && labs2.length === 0 &&
      !!vl && /^(FIXED|LIVE)\b/.test((vl.textContent || '').trim());
    await wait(180);
    try {
      L().part = JSON.parse(sv); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  });
  ok('the card says what it will GENERATE — the shape first, then the rules, and each door explains itself',
    saysRun.noJargon && saysRun.saysReRolled && saysRun.saysExact && saysRun.notBoth &&
    saysRun.saysCounts && saysRun.saysPitch && saysRun.shapes && saysRun.noTailEcho &&
    saysRun.everyDoorExplains && saysRun.modelStated && saysRun.wraps,
    JSON.stringify(saysRun));

  // 🎲 ROLL MIRRORS THE PART, AND A PRESS ON THE LIT CHIP BUILDS NOTHING.
  // It rolled its own length, so a record filed under a 5-bar part came back
  // 1 bar and then repeated five times under it; and the already-in-this-mode
  // guard keyed on the STAMP, so a chip lit by INFERENCE (a walked line IS a
  // roll) still rebuilt and threw the content away.
  const rollRun2 = await page.evaluate(async () => {
    // A MATERIAL PRESS ASKS FIRST now (it replaces the notes), and a native
    // confirm is AUTO-DISMISSED in puppeteer — so a probe that drives these
    // doors has to answer it, or the door correctly does nothing.
    const svConfirm = window.confirm; window.confirm = () => true;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svAll = L().partAll ? JSON.stringify(L().partAll) : null;
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    c0.prog = { on: true,
      chords: [0, 2, 4, 5, 7].map((r) => ({ root: r, intervals: [0, 4, 7] }))
        .concat([{ root: 9, intervals: [0, 3, 7] }, { root: 11, intervals: [0, 3, 6] }]),
      parts: [{ name: 'A', len: 5 }, { name: 'B', len: 2 }] };
    c0.keyOn = true; c0.keyRoot = 0; c0.keyScale = 'major'; c0.keyFollow = false;
    E.getCfg();
    L().on = true; L().present = true; L().part.kind = 'live';
    L().partFor = 0; L().partAll = JSON.parse(JSON.stringify(L().part));
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    const draw = async () => { if (h) h._sig = ''; window._v2.render(E); await wait(280);
      document.querySelector('.v2-layer').classList.remove('collapsed'); };
    // BY CLASS, never by text: the button carries a subtitle now, so its
    // textContent is "🎲 Rolla run of single notes" and an equality match
    // silently finds nothing (it took down the whole run once).
    const rollBtn = () => document.querySelector('.v2-layer .v2-rollrun');
    const shape = () => JSON.stringify({ b: L().part.bars, r: L().part.rhythm, p: L().part.pitch });
    const o = {};
    await draw();
    rollBtn().click(); await wait(450);
    o.barsA = L().part.bars;                       // the 5-bar part's length
    o.stamped = L().part.mat === 'roll';
    const s1 = shape();
    rollBtn().click(); await wait(450);
    o.repeatIsNoop = shape() === s1;               // a second press builds nothing
    // an INFERRED-lit chip — no stamp, but a walked line already IS a roll
    delete L().part.mat; L().part.bars = 5;
    L().part.pitch = { kind: 'walk', degree: 1, span: 3 };
    E.getCfg(); await draw();
    const s2 = shape();
    rollBtn().click(); await wait(450);
    o.inferredIsNoop = shape() === s2;
    o.inferredStamps = L().part.mat === 'roll';    // …and it records the mode
    // a roll made for the OTHER part takes THAT part's length
    window._v2.partSelect(E, L(), 1);
    delete L().part.mat; L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg(); await draw();
    rollBtn().click(); await wait(450);
    o.barsB = L().part.bars;
    // …and one cycle of it spans that part's chords, so the generated notes
    // are in the harmonic character of the bars they play under
    try {
      const cyc = L().part.bars * 2;
      const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: cyc })) || [];
      o.slots = [...new Set(ns.map((n) => _ambProgStepAt(E, n.at) % 7))].sort().join(',');
    } catch (e) { o.slots = 'ERR'; }
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svAll) L().partAll = JSON.parse(svAll); else delete L().partAll;
      if (L().parts) delete L().parts;
      E.getCfg(); await draw();
    } catch (e) { o.err = e.message; }
    window.confirm = svConfirm;
    return o;
  });
  ok('🎲 Roll takes the selected part\'s length, and a press on the lit chip builds nothing',
    rollRun2.barsA === 5 && rollRun2.barsB === 2 && rollRun2.stamped &&
    rollRun2.repeatIsNoop && rollRun2.inferredIsNoop && rollRun2.inferredStamps &&
    rollRun2.slots === '0,1',
    JSON.stringify(rollRun2));

  // THE EDITOR CANNOT BE COVERED BY THE APP'S OWN CHROME — because it is not
  // floating any more. The old check drove `--v2-safetop`/`--v2-safebot` to
  // stand in for a phone (env() is always 0 on a desktop, which is why the
  // centring bug shipped twice) and asserted a CENTRED sheet cleared the status
  // bar and the 40px fixed `.float-header`. Restated on what makes that
  // impossible rather than on the arithmetic that used to avoid it: the editor
  // is `position: static`, inside the layer body, and it scrolls with the panel
  // — so no fixed chrome can be over it at any inset.
  const safeRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    L().on = true; L().present = true;
    L().part.kind = 'live'; L().part.bars = 4;
    L().part.rhythm = { kind: 'pulse', steps: 16, n: 1 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(280);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    const gt = (window.__toContent(), null);
    if (gt) gt.click(); await wait(340);
    const pop = document.querySelector('.v2-pop');
    const wrap = document.querySelector('.v2-pop-wrap');
    const body = document.querySelector('.v2-layer > .ambient-layer-body');
    const out = [];
    for (const [st, sb] of [[0, 0], [47, 34], [59, 34]]) {
      document.documentElement.style.setProperty('--v2-safetop', st + 'px');
      document.documentElement.style.setProperty('--v2-safebot', sb + 'px');
      await wait(120);
      const q = pop.getBoundingClientRect(), br = body.getBoundingClientRect();
      out.push({ st, sb,
        inFlow: getComputedStyle(wrap).position === 'static' &&
                getComputedStyle(pop).position === 'static',
        inBody: body.contains(wrap) && q.top >= br.top - 1 && q.bottom <= br.bottom + 1,
        noFloat: !document.querySelector('.v2-pop-scrim') });
    }
    document.documentElement.style.removeProperty('--v2-safetop');
    document.documentElement.style.removeProperty('--v2-safebot');
    await wait(200);
    try {
      L().part = JSON.parse(svPart); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return out;
  });
  ok('the editor sits in the layer body, so no chrome can cover it at any inset',
    safeRun.length === 3 && safeRun.every((x) => x.inFlow && x.inBody && x.noFloat),
    JSON.stringify(safeRun));

  // THE DRAWING IS ONE CYCLE, and its ruler counts BARS — so a 1-bar cycle is
  // one label and four beat lines however many chords the part has. Asked as
  // "why does the ruler just say 1 when the part is 5 chords": nothing said the
  // cycle was SHORTER than the part, so the picture read as failing to show the
  // changes.
  const overRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svAll = L().partAll ? JSON.stringify(L().partAll) : null;
    c0.prog = { on: true,
      chords: [0, 9, 5, 7, 2, 3, 10].map((r) => ({ root: r, intervals: [0, 4, 7] })),
      parts: [{ name: 'A', len: 5 }, { name: 'B', len: 2 }] };
    E.getCfg();
    L().on = true; L().present = true; L().part.kind = 'live';
    // EVERYWHERE, deliberately: a PER-PART record is now reconciled to its
    // part's length on every normalize, so it can never be shorter than the
    // part and this clause could not fire. Shared content under a longer part
    // is exactly the case it is for.
    delete L().partFor; delete L().partAll; delete L().parts;
    const say = async () => {
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(300);
      const card = document.querySelector('.v2-layer');
      card.classList.remove('collapsed');
      const lab = card.querySelector('.v2-vizlab');
      return { txt: lab ? lab.textContent.trim() : '', el: lab };
    };
    const o = {};
    L().part.bars = 1; E.getCfg();
    const a = await say();
    o.shortSays = /repeats 5× over the 5-bar part/.test(a.txt) && /Sync/.test(a.txt);
    // …and it must WRAP rather than run out of the sheet (UI rule 2)
    if (a.el) {
      const r = a.el.getBoundingClientRect();
      const pr = a.el.parentElement.getBoundingClientRect();
      o.wraps = a.el.scrollWidth <= a.el.clientWidth + 1 && r.right <= pr.right + 1;
      o.lines = Math.round(r.height / parseFloat(getComputedStyle(a.el).lineHeight || 16));
    }
    // a cycle that MATCHES says nothing — a readout that always fires is noise
    L().part.bars = 5; E.getCfg();
    o.matchSilent = !/repeats/.test((await say()).txt);
    // fractional counts are honest
    L().part.bars = 2.5; E.getCfg();
    o.halfSays = /repeats 2× over the 5-bar part/.test((await say()).txt);
    // and with no progression there is no part to be shorter than
    const c2 = E.getCfg(); c2.prog.on = false; E.getCfg();
    L().part.bars = 1; E.getCfg();
    o.noProgSilent = !/repeats/.test((await say()).txt);
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svAll) L().partAll = JSON.parse(svAll); else delete L().partAll;
      E.getCfg();
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) { o.err = e.message; }
    return o;
  });
  ok('the drawing says when its cycle is shorter than the part it plays under',
    overRun.shortSays && overRun.halfSays && overRun.matchSilent &&
    overRun.noProgSilent && overRun.wraps,
    JSON.stringify(overRun));

  // A LOCKED TAKE KEEPS FOLLOWING THE CHANGES. A live part resolves every note
  // against the chord sounding at its own onset; freezing it stores absolute
  // pitches, and with 'fixed' it then replays the chords it was CAPTURED over
  // for the rest of the piece — reported as "it just repeats the first 2
  // chords, even over part 2".
  const followRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svProg = JSON.stringify(c0.prog || null), svPart = JSON.stringify(L().part);
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    const svH = L().harmony;
    const svClocks = [E._playStartAt, E._progAnchor, E._barGridAnchor];
    c0.prog = { on: true,
      chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
               { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] },
               { root: 2, intervals: [0, 3, 7] }, { root: 3, intervals: [0, 4, 7] },
               { root: 10, intervals: [0, 4, 7] }, { root: 8, intervals: [0, 4, 7] }],
      parts: [{ name: 'A', len: 5 }, { name: 'B', len: 3 }] };
    c0.keyOn = true; c0.keyRoot = 0; c0.keyScale = 'major'; c0.keyFollow = false;
    E.getCfg();
    // a real play leaves these set, and a stale anchor clamps every lookup to
    // chord 0 — the documented trap, which would make this pass for the wrong
    // reason by never advancing the changes at all
    E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
    L().on = true; L().present = true; delete L().harmony;
    L().part.kind = 'live'; L().part.bars = 2;
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 4, rotate: 0 };
    L().part.pitch = { kind: 'walk', degree: 1, span: 4 };
    E.getCfg();
    // FRACTION OF NOTES IN THE SOUNDING CHORD, over five cycles — which spans
    // both parts, so a take frozen over part A's opening is measured against
    // part B's different chords too.
    const score = () => {
      const cyc = (L().part.bars || 1) * 2;
      let ok = 0, n = 0;
      for (let k = 0; k < 5; k++) {
        const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
          { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: k * cyc, cycleSec: cyc })) || [];
        ns.forEach((nt) => {
          const ch = _ambProgSoundAt(E, E.getCfg().prog, _ambProgStepAt(E, nt.at));
          const pcs = ch ? ch.intervals.map((i) => (((ch.root + i) % 12) + 12) % 12) : [];
          const m = (((Math.round(69 + 12 * Math.log2(nt.freq / 440)) % 12) + 12) % 12);
          if (pcs.indexOf(m) >= 0) ok++;
          n++;
        });
      }
      return { ok, n };
    };
    const o = {};
    const live = score(); o.live = live.ok + '/' + live.n;
    o.liveFollows = live.n > 8 && live.ok === live.n;
    window._v2.capture(E, L()); E.getCfg();
    o.defaultFollow = L().harmony || null;
    const lock = score(); o.locked = lock.ok + '/' + lock.n;
    o.lockedFollows = lock.n === live.n && lock.ok === lock.n;
    // …and Fixed still means fixed — the control has to keep working BOTH ways,
    // or "follows the changes" would just be unconditional
    L().harmony = 'fixed'; E.getCfg();
    const fx = score(); o.fixed = fx.ok + '/' + fx.n;
    o.fixedDiffers = fx.ok < fx.n;
    // with NO progression a capture invents nothing
    const c2 = E.getCfg(); c2.prog.on = false; E.getCfg();
    L().part.kind = 'live'; delete L().harmony; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();
    o.noProgLeavesAlone = !L().harmony;
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(svPart);
      if (svH) L().harmony = svH; else delete L().harmony;
      E._playStartAt = svClocks[0]; E._progAnchor = svClocks[1]; E._barGridAnchor = svClocks[2];
      E.getCfg();
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) { o.err = e.message; }
    return o;
  });
  ok('a locked take keeps following the changes, and Fixed still pins it',
    followRun.liveFollows && followRun.defaultFollow === 'chordlock' &&
    followRun.lockedFollows && followRun.fixedDiffers && followRun.noProgLeavesAlone,
    JSON.stringify(followRun));

  // A ROLL CAN PLAY MORE THAN ONE NOTE AT A TIME. `pitch.walk` is one line by
  // definition, so 🎲 Roll was monophonic and the only way to thicken it was
  // Harmony — which duplicates the one line at a fixed interval, i.e. parallel
  // motion, never independence. `pitch.lines` rolls N walks with their own
  // streams and their own memories.
  const linesRun = await page.evaluate(async () => {
    // PER-CYCLE VARIATION IS A CHOICE NOW (`part.vary`) — the default is that
    // playback plays the TAKE the drawing shows, every cycle. This check's
    // whole phenomenon is observed ACROSS cycles, so it asks for the mode it
    // is testing; the contract it pins is unchanged.
    try { (_masterEng.getCfg().layers || [])[0].part.vary = 1; _masterEng.getCfg(); } catch (e) {}
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part), c0 = E.getCfg();
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    c0.keyOn = true; c0.keyRoot = 0; c0.keyScale = 'major'; c0.keyFollow = false;
    L().part.kind = 'live'; L().instrument.voice = 'synth';
    L().part.rhythm = { kind: 'pulse', steps: 8 }; L().part.bars = 1;
    L().part.pitch = { kind: 'walk', degree: 1, span: 3, home: 'center' };
    E.getCfg();
    // SAMPLE ACROSS ONSETS, not within one window: this fixture emits a single
    // onset per cycle, so a "do the shapes vary" check measured inside one
    // window can only ever see ONE shape and reported a working feature as
    // broken. Each cycle start is a different onset and therefore a different
    // seed, which is exactly what the walk varies on.
    const shapes = () => {
      const all = [];
      let max = 0;
      for (let i = 0; i < 8; i++) {
        const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
          { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 100 + i * 4, cycleSec: 4 })) || [];
        const by = {};
        ns.forEach((n) => { const k = (Math.round(n.at * 1000) / 1000).toFixed(3);
          (by[k] = by[k] || []).push(Math.round(69 + 12 * Math.log2(n.freq / 440))); });
        Object.values(by).forEach((x) => {
          const g = x.slice().sort((a, b) => a - b);
          if (g.length > max) max = g.length;
          if (g.length > 1) all.push(g.map((m) => m - g[0]).join(','));
        });
      }
      return { max, shapes: all };
    };
    const o = {};
    o.plain = shapes().max;                       // absent = one line, as always
    L().part.pitch.lines = 1; E.getCfg();
    o.prunedAt1 = L().part.pitch.lines === undefined;
    L().part.pitch.lines = 3; E.getCfg();
    const three = shapes();
    o.three = three.max;
    // INDEPENDENT: the interval shape must CHANGE from onset to onset. A
    // constant shape is parallel motion, which is what Harmony does and what
    // this is not — asserted as "more than one distinct shape", never a count,
    // so it cannot pin one roll's numbers.
    o.distinctShapes = new Set(three.shapes).size;
    // INDEPENDENCE, TESTED PROPERLY. "The interval shapes vary" does NOT test
    // it — a poison that gave every line the identical stream still varied
    // them, because the lines start on different DEGREES and a scale is
    // unevenly spaced, so the same step from a different degree is a different
    // number of semitones. That check would have passed on parallel lines.
    // The real property: with ONE shared stream every line is a FUNCTION of
    // line 0 (same step, fixed degree offset), so a given bottom note always
    // pairs with the same second note. Independent streams break that.
    const pairs = {};
    for (let i = 0; i < 24; i++) {
      const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 200 + i * 4, cycleSec: 4 })) || [];
      const by = {};
      ns.forEach((n) => { const k = (Math.round(n.at * 1000) / 1000).toFixed(3);
        (by[k] = by[k] || []).push(Math.round(69 + 12 * Math.log2(n.freq / 440))); });
      Object.values(by).forEach((x) => {
        if (x.length < 2) return;
        const g = x.slice().sort((a, b) => a - b);
        (pairs[g[0]] = pairs[g[0]] || new Set()).add(g[1]);
      });
    }
    // A RE-ROLL KEEPS THE TEXTURE. The roll replaces the pitch object
    // wholesale, so Lines and Harmony were wiped by every press — the only way
    // to keep polyphony was to never re-roll again.
    L().part.pitch.harm = [{ deg: 2 }]; E.getCfg();
    window._v2.rollRun(E, L()); E.getCfg();
    o.keptOverRoll = (L().part.pitch.lines | 0) === 3 &&
      Array.isArray(L().part.pitch.harm) && L().part.pitch.harm.length === 1 &&
      L().part.pitch.kind === 'walk';
    delete L().part.pitch.harm; L().part.pitch.lines = 3; E.getCfg();
    o.pairGroups = Object.keys(pairs).length;
    o.maxPartners = Object.values(pairs).reduce((m, st) => Math.max(m, st.size), 0);
    o.independent = o.maxPartners >= 2;
    // …and HARMONY is the PARALLEL one, on the same line, for contrast. Note it
    // is parallel in DEGREES, not semitones — a diatonic 3rd is 4 semitones
    // over C and 3 over D — so the contrast is that its shape takes only those
    // few values while independent lines wander freely. Asserting "one shape"
    // would be wrong, and passed only because the first fixture had one onset.
    delete L().part.pitch.lines; L().part.pitch.harm = [{ deg: 2 }]; E.getCfg();
    const har = shapes();
    o.harmMax = har.max;
    o.harmShapes = new Set(har.shapes).size;
    o.harmParallel = o.harmShapes <= 2;
    delete L().part.pitch.harm; E.getCfg();
    // the CONTROL exists on a walk and is absent where it means nothing
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    card.querySelector('.v2-gototab[data-goto="Pitch"]').click(); await wait(280);
    const lt = document.querySelector('.v2-pop-tabs [data-tab="Lines"]');
    o.tabOnWalk = !!lt && lt.getBoundingClientRect().height > 0;
    if (lt) lt.click(); await wait(160);
    const li = document.querySelector('.v2-pop-pane [data-f="part.pitch.lines"]');
    o.ctlOnWalk = !!li && li.getBoundingClientRect().height > 0;
    await wait(180);
    L().part.pitch = { kind: 'chord', voices: 3 }; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    const c2 = document.querySelector('.v2-layer'); c2.classList.remove('collapsed');
    c2.querySelector('.v2-gototab[data-goto="Pitch"]').click(); await wait(280);
    const lt2 = document.querySelector('.v2-pop-tabs [data-tab="Lines"]');
    o.tabOnChord = !!lt2 && lt2.getBoundingClientRect().height > 0 && !!lt2.offsetParent;
    await wait(180);
    try {
      const c9 = E.getCfg();
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(sv); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) { o.err = e.message; }
    return o;
  });
  // …and PUT IT BACK: these run in ONE page against ONE cfg, and a `vary`
  // left on is the next check's bug (it snapshots the part AFTER this was
  // set, so its own restore would keep it).
  await page.evaluate(() => { try {
    delete (_masterEng.getCfg().layers || [])[0].part.vary; _masterEng.getCfg();
  } catch (e) {} });
  ok('a Roll can play several INDEPENDENT lines — and Harmony is the parallel one',
    linesRun.plain === 1 && linesRun.prunedAt1 && linesRun.three === 3 &&
    linesRun.independent && linesRun.pairGroups >= 2 && linesRun.keptOverRoll &&
    linesRun.harmMax === 2 && linesRun.harmParallel &&
    linesRun.tabOnWalk && linesRun.ctlOnWalk && !linesRun.tabOnChord,
    JSON.stringify(linesRun));

  // POLYPHONY — a chord must be a CHORD. Measured through the real control in
  // C major, Pitch → Chord played C+D+E: adjacent scale steps, a cluster, and
  // byte-identical to Stack, so the two kinds could not be told apart.
  const chordRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part), c0 = E.getCfg();
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    const svProg = JSON.stringify(c0.prog || null);
    const setKey = (on, root, scale) => { const c = E.getCfg();
      c.keyOn = on; c.keyRoot = root; c.keyScale = scale; c.keyFollow = false; E.getCfg(); };
    const midi = (mut) => {
      eval(mut); E.getCfg();
      const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 100, cycleSec: 4 })) || [];
      const by = {};
      ns.forEach((n) => { const k = (Math.round(n.at * 1000) / 1000).toFixed(3);
        (by[k] = by[k] || []).push(Math.round(69 + 12 * Math.log2(n.freq / 440))); });
      // INTERVALS from the lowest note, not absolute pitches: "a chord is
      // built in thirds" is a claim about the SHAPE, and pinning absolute midi
      // makes it fail whenever the layer's register differs (it read an octave
      // high on the first run, with every interval correct).
      const g = (Object.values(by)[0] || []).slice().sort((a, b) => a - b);
      return g.map((m) => m - g[0]).join(',');
    };
    const base = "L().part.kind='live';L().instrument.voice='synth';" +
      "L().part.rhythm={kind:'pulse',steps:2};L().part.bars=1";
    const o = {};
    if (E.getCfg().prog) E.getCfg().prog.on = false;
    setKey(true, 0, 'major');
    o.cmaj3 = midi(base + ";L().part.pitch={kind:'chord',voices:3}");
    o.cmaj4 = midi(base + ";L().part.pitch={kind:'chord',voices:4}");
    o.stack3 = midi(base + ";L().part.pitch={kind:'stack',voices:3}");
    setKey(true, 9, 'minor');
    o.amin3 = midi(base + ";L().part.pitch={kind:'chord',voices:3}");
    setKey(false, 0, 'major');
    o.chrom3 = midi(base + ";L().part.pitch={kind:'chord',voices:3}");
    // A POOL is unchanged — a progression's own tones ARE the harmony, so
    // consecutive picks are already chord tones. This is the other side of the
    // line and the reason the source/progression checks above never moved.
    const cP = E.getCfg();
    cP.prog = { on: true, chords: [{ root: 0, intervals: [0, 3, 7] }] };
    E.getCfg();
    o.pool3 = midi(base + ";L().part.pitch={kind:'chord',voices:3}");
    // restore the world
    try {
      const c9 = E.getCfg();
      if (svProg === 'null') delete c9.prog; else c9.prog = JSON.parse(svProg);
      c9.keyOn = svKey[0]; c9.keyRoot = svKey[1]; c9.keyScale = svKey[2]; c9.keyFollow = svKey[3];
      L().part = JSON.parse(sv); E.getCfg();
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) { o.err = e.message; }
    return o;
  });
  ok('Chord builds a CHORD — thirds over a scale, the pool\'s own tones over a progression',
    chordRun.cmaj3 === '0,4,7' &&             // a major triad
    chordRun.cmaj4 === '0,4,7,11' &&          // …and its major 7th
    chordRun.amin3 === '0,3,7' &&             // A C E — diatonic, so MINOR
    chordRun.chrom3 === '0,4,7' &&            // no key: thirds by interval
    chordRun.pool3 === '0,3,7' &&             // the progression's OWN Cm tones
    chordRun.stack3 === '0,2,4',              // Stack keeps its own meaning
    JSON.stringify(chordRun));

  // 🔍 FIND A CONTROL — an index over the card. Every control is filed with
  // the thing it modifies, which is the right filing and a poor index: the
  // variance family alone spans four tabs in three sheets, and "where are all
  // the variance controls" was asked twice. It NAVIGATES; it never renders a
  // second copy of a field.
  const findRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    // A FIXTURE, because the landing is measured ON SCREEN: the ⚙ row this
    // navigates to is gated `rhythm:euclid,drawn`, and a row that is indexed
    // but gated out would land invisibly and prove the weaker half only.
    // Seeded BEFORE the card is resolved — a render detaches it, and every
    // measurement below then reads a node in a detached tree as 0 (it did).
    const svPart = JSON.stringify(L().part);
    L().part.kind = 'live';
    L().part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    const inp = card.querySelector('.v2-findin');
    const o = { present: !!inp };
    if (!inp) return o;
    // 16px FLOOR — below it iOS zooms the page on focus and never zooms back
    o.fontPx = parseFloat(getComputedStyle(inp).fontSize) || 0;
    const r0 = inp.getBoundingClientRect();
    o.fits = r0.width > 0 && r0.right <= innerWidth + 1 && r0.height >= 30;
    const type = async (v) => {
      inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(140);
      return [...card.querySelectorAll('.v2-findhit')].map((x) => ({
        lab: x.getAttribute('data-flab'), grp: x.getAttribute('data-fgrp'),
        tab: x.getAttribute('data-ftab'), gen: x.getAttribute('data-fgen') === '1' }));
    };
    const ghost = await type('ghost');
    // RESTATED 2026-09-10: Ghosts is in Shape ▸ SHAPING now — it shapes the
    // static content once (measured identical over six cycles) rather than
    // varying it, which is why the tab split. Same contract: one exact hit,
    // and the finder knows where it lives.
    o.exact = ghost.length === 1 && ghost[0].lab === 'Ghosts' &&
      ghost[0].grp === 'Shape' && ghost[0].tab === 'Shaping';
    // THE CATEGORY WORD reaches the whole family across sheets — the question
    // this exists for. Asserted as SHEET COVERAGE, not a count: a number would
    // pin today's roster and break the next time a control is added.
    const fam = await type('variance');
    const sheets = new Set(fam.map((x) => x.grp));
    o.famSheets = [...sheets].sort().join(',');
    // Content is BACK IN THIS LINE (2026-09-15) and it is the proof the gap
    // closed: the family only reaches Content through the ⚙ Generated panel's
    // rhythm Vary, and for a day the panel was not in the index at all — every
    // one of its ~40 rows unstamped, so 'push', 'vary' and the rest answered
    // "Nothing matches" for controls two presses away. `stampGroups` sweeps
    // `.v2-genpop .ambient-ctrl` now, so the category word spans the sheets
    // again. The narrower version this replaces is deleted rather than kept
    // beside it: a parked assertion that outlives its bug reads as the contract.
    o.famSpans = sheets.has('Content') && sheets.has('Pitch') && sheets.has('Shape');
    // …and the ⚙ row is what carries Content — named, so a future regression
    // says WHICH half went rather than just "the family shrank".
    o.famGenHit = fam.some((x) => x.gen && x.grp === 'Content' && x.tab === 'Method');
    // RESTATED 2026-09-10: the `Variance` tab SPLIT — three of its four knobs
    // are deterministic content shapers (measured identical over six cycles),
    // so it is `Shaping` and `Performance` now. The contract is unchanged and
    // slightly stronger: the category word must still reach BOTH halves, or
    // the split would have orphaned one of them from the search.
    // RESTATED AGAIN 2026-09-12: `Performance` is `Every pass`, because the
    // DICE moved in beside Humanize and Vel var — asked as "what is stochastic
    // about live layers, and where are those controls (they should be in one
    // place)". Same contract, and the half it names is now the complete set of
    // switches that make a layer differ pass to pass.
    o.famHasVariance = fam.some((x) => x.tab === 'Shaping') &&
      fam.some((x) => x.tab === 'Every pass');
    // a miss says so rather than showing an empty box
    await type('zzzqq');
    o.saysNone = /Nothing matches/.test((card.querySelector('.v2-findnone') || {}).textContent || '');
    // TYPING MUST NOT RE-RENDER THE CARD — that replaces the input under the
    // finger and takes the caret with it (the documented Humanize-drag bug)
    await type('vary');
    o.inputSurvives = document.contains(inp) && inp.value === 'vary';
    // A HIT NAVIGATES TO THE ONE HOME, and marks the row it sent you to.
    // 'Push' — a ⚙ PANEL row (2026-09-15). It is the strongest target on the
    // card because it pins the WHOLE path in one press: index → the section
    // that owns it → the door inside that section → the row, marked and ON
    // SCREEN. It is also unambiguous, which 'How many' is not: the panel uses
    // that one label for `rhythm.pulses` AND `rhythm.n` (mutually exclusive by
    // rhythm kind, so only ever one live — but two rows under one name, so a
    // check pinned there would be asserting which of them sorted first.)
    const pushHits = await type('push');
    o.pushHits = pushHits;
    const hit = [...card.querySelectorAll('.v2-findhit')].find((x) => x.getAttribute('data-flab') === 'Push');
    o.hitFound = !!hit && pushHits.length === 1;
    o.hitWhere = hit ? (hit.getAttribute('data-fgrp') + '/' + hit.getAttribute('data-ftab') +
      (hit.getAttribute('data-fgen') === '1' ? '[gen]' : '')) : null;
    if (hit) hit.click();
    await wait(600);
    const pop = document.querySelector('.v2-pop');
    o.opened = pop ? pop.getAttribute('aria-label') : null;
    const on = document.querySelector('.v2-pop-tabs [data-tab].on');
    o.tab = on ? on.getAttribute('data-tab') : null;
    o.marked = document.querySelectorAll('.v2-findmark').length === 1;
    // …AND THE DOOR OPENED WITH IT. A hit that lands on the right tab with the
    // panel shut leaves the control as unreachable as it was before the index
    // knew about it — the mark would be flashing behind a closed door.
    o.genOpen = document.querySelector('.v2-layer').classList.contains('v2-genopen');
    const mk = document.querySelector('.v2-findmark');
    const mr = mk ? mk.getBoundingClientRect() : null;
    o.markInGen = !!mk && !!mk.closest('.v2-genpop');
    o.markLab = mk ? ((mk.querySelector('label') || {}).textContent || '').trim() : null;
    // ON SCREEN, not merely in the DOM: a 0×0 rect is the documented tell, and
    // so is a row scrolled off the panel — the navigation scrolls it into view.
    o.markOnScreen = !!mr && mr.height > 0 && mr.width > 0 &&
      mr.top >= 0 && mr.bottom <= innerHeight + 1;
    o.markRect = mr ? (Math.round(mr.width) + 'x' + Math.round(mr.height) + ' @' + Math.round(mr.top)) : null;
    o.cleared = card.querySelector('.v2-findin').value === '' &&
      !card.querySelector('.v2-findres').classList.contains('on');
    await wait(200);
    // …and put the door back, through its own ✕ (GENPOP is module state — a
    // class removed by hand would leave the module thinking it is still open).
    const gc9 = document.querySelector('.v2-layer .v2-genpop .v2-gendone');
    if (gc9) gc9.click();
    await wait(240);
    // ONE wrap — the card's own embedded editor. It was "none", back when the
    // sheet was a modal you could close; the finder must still never mint a
    // second one.
    o.clean = document.querySelectorAll('.v2-pop-wrap').length === 1;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(220);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('🔍 Find a control indexes the whole card and navigates to the one home',
    findRun.present && findRun.fontPx >= 16 && findRun.fits && findRun.exact &&
    findRun.famSpans && findRun.famGenHit && findRun.famHasVariance && findRun.saysNone &&
    findRun.inputSurvives && findRun.hitFound && findRun.opened === 'Content' &&
    // The hit SAYS where it will take you and then takes you there — both
    // halves, or a hit could navigate anywhere and still pass. Content ▸ Method
    // is where a ⚙ panel row lives: the panel has no tab of its own, so the
    // finder names the DOOR that opens it, and the press opens that door.
    findRun.hitWhere === 'Content/Method[gen]' && findRun.tab === 'Method' &&
    findRun.genOpen && findRun.markInGen && findRun.markLab === 'Push' &&
    findRun.markOnScreen &&
    findRun.marked && findRun.cleared && findRun.clean,
    JSON.stringify(findRun));

  // THE ⚙ PANEL IS IN THE INDEX — STRUCTURALLY, not by one lucky search term.
  // `findIndex` can only see rows `stampGroups` has stamped `data-v2g`, and for
  // a day it stamped `.ambient-grp` bodies only: the ⚙ Generated panel is a
  // CARD CHILD, so all 40 of its rows were outside the sweep and the finder
  // answered "Nothing matches" for controls two presses away. That went unnoticed
  // while ✦ Method carried duplicates of those knobs, and became audible the
  // moment the duplicates were deleted — which is exactly how an index gap
  // hides: behind a copy of the thing it is missing. Pinned at the STAMP, so
  // the next surface added outside a group body is caught before a term is.
  const stampRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    window.__toContent(); await wait(220);          // rows back in their groups
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    const o = {};
    const gen = [...card.querySelectorAll('.v2-genpop .ambient-ctrl')];
    o.genRows = gen.length;
    o.genStamped = gen.filter((r) => r.dataset.v2g === 'Content' && r.dataset.v2gen === '1').length;
    o.genAll = o.genRows > 20 && o.genStamped === o.genRows;
    // NO ROW IS INDEXED TWICE. `findIndex` emits one entry per stamped row, so
    // a stamped row INSIDE another stamped row is two entries for one control —
    // which is what the sweep's own "never restamp a nested row" guard exists
    // to prevent, and what a second, laxer sweep would quietly undo.
    const stamped = [...card.querySelectorAll('[data-v2g]')];
    o.stampedN = stamped.length;
    o.nested = stamped.filter((r) => r.querySelector('[data-v2g]')).length;
    // …AND A GROUP ROW STILL ANSWERS FOR ITS OWN GROUP. The ⚙ sweep writes
    // 'Content' to everything it touches, so the failure to rule out is it
    // reaching past the panel and re-filing the card — measured on one row per
    // sheet rather than trusting the selector.
    const whereIs = (f) => [...card.querySelectorAll('[data-f="' + f + '"]')]
      .map((el) => { const r = el.closest('[data-v2g]');
        return r ? (r.dataset.v2g + (r.dataset.v2gen ? '[gen]' : '')) : 'unstamped'; });
    o.groups = { level: whereIs('level'), delay: whereIs('delay.mix'),
                 voice: whereIs('instrument.voice'), bars: whereIs('part.bars') };
    o.groupsIntact = o.groups.level.join() === 'Mix' && o.groups.delay.join() === 'FX' &&
      o.groups.voice.join() === 'Instrument' && o.groups.bars.join() === 'Content';
    // THE ONE FIELD WITH TWO CONTROLS proves both halves at once: the sheet's
    // Pitch row is filed under Pitch, the ⚙ panel's copy under Content[gen].
    // Order-free — which sheet renders first is not the claim.
    o.pitchHomes = whereIs('part.pitch.kind').sort().join(',');
    o.bothHomes = o.pitchHomes === 'Content[gen],Pitch';
    // …and the panel's own words RESOLVE. Sampled from three different rows of
    // it, by the label each one actually shows — an index that holds rows
    // nobody can search by name is the same gap wearing different clothes.
    const inp = card.querySelector('.v2-findin');
    const type = async (v) => { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(160);
      return [...card.querySelectorAll('.v2-findhit')].map((x) => ({
        lab: x.getAttribute('data-flab'), grp: x.getAttribute('data-fgrp'),
        tab: x.getAttribute('data-ftab'), gen: x.getAttribute('data-fgen') === '1' })); };
    o.words = {};
    for (const w of ['push', 'vary', 'spread']) {
      const hits = await type(w);
      o.words[w] = hits.filter((x) => x.gen).map((x) => x.lab + '@' + x.grp + '/' + x.tab).join('|');
    }
    // Every one resolves to a ⚙ row, filed under the door that opens it. NOT
    // asserted for 'pulses'/'rotate'/'onsets': those are the DELETED tab's
    // vocabulary, and an index over the labels controls actually show must not
    // invent a word no surface uses (the panel says How many · Push).
    o.wordsResolve = /^Push@Content\/Method$/.test(o.words.push) &&
      /Vary@Content\/Method/.test(o.words.vary) && /Spread@Content\/Method/.test(o.words.spread);
    inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(160);
    return o;
  });
  ok('the ⚙ Generated panel is IN the finder’s index — every row stamped, none twice, the groups intact',
    stampRun.genAll && stampRun.nested === 0 && stampRun.stampedN > 100 &&
    stampRun.groupsIntact && stampRun.bothHomes && stampRun.wordsResolve,
    JSON.stringify(stampRun));

  // ▶ PREVIEW AUDITIONS THE RECORD ON THE CARD. With per-part content on, the
  // emitter swaps in whichever part is SOUNDING — right for playback, wrong
  // for an audition, because the stopped clock resolves to part 0 while the
  // card is editing the part the strip selected. Before the edit pin, seeding
  // changed the stored rules every press and left the preview byte-identical.
  const ppEditRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const cfg0 = E.getCfg();
    const svProg = JSON.stringify(cfg0.prog || null);
    const svLayer = JSON.stringify(L());
    cfg0.prog = { on: true, parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }],
      chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
               { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }] };
    E.getCfg();
    L().on = true; L().present = true;
    // per part, EDITING part 1 — the part the stopped clock does NOT resolve to
    L().partFor = 1; L().partAll = JSON.parse(JSON.stringify(L().part));
    E.getCfg();
    const o = { partFor: L().partFor | 0, seeds: [] };
    const cap = async () => {
      const got = []; const orig = window.playNote;
      window.playNote = function (f) { got.push(Math.round(f)); return orig.apply(this, arguments); };
      try { window._v2.preview(E, L()); } catch (e) {}
      await wait(60); window.playNote = orig;
      try { window._v2.previewKill(E, L()); } catch (e) {}
      return got.join(',');
    };
    for (const ty of ['bass', 'arp', 'bed']) {
      window._v2.seedLikeV1(E, L(), ty); E.getCfg();
      const q = L().part;
      o.seeds.push({ ty, rules: q.rhythm.kind + '/' + q.pitch.kind, pv: await cap() });
      await wait(80);
    }
    // three seeds, three DIFFERENT auditions — the symptom was all three equal
    const pvs = o.seeds.map((x) => x.pv);
    o.rulesMoved = new Set(o.seeds.map((x) => x.rules)).size === 3;
    o.previewFollows = new Set(pvs).size === 3 && pvs.every((x) => x.length > 0);
    // …and PLAYBACK still swaps: the arrangement, not the card, owns which
    // part sounds. Without this the fix would have silenced per-part content.
    // DETERMINISTIC BY CONSTRUCTION: resolve which part the anchor lands on
    // FIRST, then edit a different one. Asserting against whatever the clock
    // happens to hold is chance-dependent — earlier checks that played leave
    // `_playStartAt` set, and the anchor then resolved to the very part being
    // edited, so the swap correctly did nothing and the check read as failed.
    try {
      const t0 = Tone.now() + 0.5, c2 = E.getCfg();
      const w = _ambPartChordAt(E, c2, t0);
      o.anchorPart = w ? (w.pi | 0) : -1;
      L().partFor = (o.anchorPart === 0) ? 1 : 0;
      E.getCfg();
      const ctx = { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: t0, cycleSec: 2 };
      const swapped = window._v2.notesFor(L(), ctx).map((n) => Math.round(n.freq)).join(',');
      const pinned = window._v2.withEdit(() => window._v2.notesFor(L(), ctx))
        .map((n) => Math.round(n.freq)).join(',');
      o.playbackStillSwaps = swapped !== pinned;
    } catch (e) { o.playbackStillSwaps = 'ERR ' + e.message; }
    // put the whole world back — a progression left behind changes every
    // later check's harmony (the documented one-page-one-state trap)
    try {
      const c3 = E.getCfg();
      if (svProg === 'null') delete c3.prog; else c3.prog = JSON.parse(svProg);
      const cur = L(), fresh = JSON.parse(svLayer);
      Object.keys(cur).forEach((k) => { if (!(k in fresh)) delete cur[k]; });
      Object.assign(cur, fresh);
      E.getCfg();
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(250);
      document.querySelector('.v2-layer').classList.remove('collapsed');
      o.clean = !Number.isFinite(L().partFor) && !L().parts;
    } catch (e) { o.clean = 'ERR ' + e.message; }
    return o;
  });
  ok('▶ Preview auditions the part you are EDITING, while playback still follows the arrangement',
    ppEditRun.rulesMoved && ppEditRun.previewFollows && ppEditRun.playbackStillSwaps === true && ppEditRun.clean === true,
    JSON.stringify(ppEditRun));

  // A MENU OPENED FROM INSIDE THE SHEET MUST PAINT OVER IT. The sheet is a
  // fixed overlay (.v2-pop-wrap, z 10290) and showCtxMenu is body-attached —
  // at its old z 10001 the Transform menu opened UNDERNEATH the sheet.
  // Asserted by HIT-TEST, not by z-index alone: a number that merely looks
  // bigger proves nothing about what is under the finger.
  const menuZRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    const h = document.getElementById('bloom-v2-layers');
    L().part.kind = 'recorded';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.5, midi: 64, dur: 0.1 }];
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    window.__toContent(); await wait(300);
    const o = { openedFromSheet: !!document.querySelector('.v2-pop-wrap .v2-tform') };
    const tf = document.querySelector('.v2-pop-wrap .v2-tform') || document.querySelector('.v2-tform');
    if (tf) tf.click();
    await wait(400);
    const m = document.querySelector('.ctx-menu');
    o.menu = !!m;
    if (m) {
      const wrap = document.querySelector('.v2-pop-wrap');
      o.z = +getComputedStyle(m).zIndex;
      // RESTATED: the editor is in the flow with no stacking context of its
      // own, so there is no number to out-rank — the claim was always about
      // what is under the finger, which `covered` measures directly.
      o.wrapZ = wrap ? getComputedStyle(wrap).zIndex : 'auto';
      o.above = o.z >= 10900;
      const r = m.getBoundingClientRect();
      o.onScreen = r.width > 0 && r.left >= -1 && r.top >= -1 &&
        r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      o.covered = [];
      m.querySelectorAll('button').forEach((bt) => {
        const q = bt.getBoundingClientRect();
        if (q.width < 1 || q.height < 1) return;
        const el = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
        if (!el || !m.contains(el)) o.covered.push(bt.textContent.trim().slice(0, 20));
      });
      o.items = m.querySelectorAll('button').length;
    }
    // LEAVE NO TRACE. The menu's dismiss listens on POINTERDOWN, not click,
    // so a body.click() leaves it open and it covers the next check's targets;
    // and the sheet MOVES the card's rows into itself, so a sheet left open
    // measures every later row at zero size (both hit, in one run).
    // dispatch on an ELEMENT — the dismiss handler does e.target.closest(),
    // and a pointerdown aimed at `document` has no closest() to call
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(150);
    await wait(250);
    try { L().part = JSON.parse(svPart); } catch (e) {}
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    o.clean = !document.querySelector('.ctx-menu') &&
      document.querySelectorAll('.v2-pop-wrap').length === 1;
    return o;
  });
  ok('a menu opened from inside the layer sheet paints OVER it and every item is hit-testable',
    menuZRun.openedFromSheet && menuZRun.menu && menuZRun.above && menuZRun.onScreen &&
    menuZRun.items >= 2 && menuZRun.covered.length === 0 && menuZRun.clean,
    JSON.stringify(menuZRun));

  ok('✨ Transform reworks the notes — exact reverse, rhythm-keeping shuffle, scoped to tapped bars',
    tfRun.present && tfRun.liveRefuses && tfRun.reversedMoved && tfRun.involution &&
    tfRun.shuffleKeepsRhythm && tfRun.stamped && tfRun.scoped && tfRun.replaceAsks,
    JSON.stringify(tfRun));
  // `series` was the FIELD VALUE leaking into the hint; the sentence says what
  // it does instead, which is the same claim made readable.
  ok('a part with NO provenance stamp still lights the material its rules ARE',
    // 'Roll · STATIC' since 2026-09-16 — the provenance line names the STATE,
    // and the state's word changed; what it is a take OF is unchanged.
    /Roll/.test(inferRun.legacy.on) && /Roll a line · STATIC/.test(inferRun.legacy.hint) &&
    /Arpeggiate/.test(inferRun.hand.on) && /one note at a time|sweeping the chord/.test(inferRun.hand.hint) &&
    inferRun.lockMark === 'none' && inferRun.liveMark === 'none' &&
    /Generate instead/.test(inferRun.lockCap) && /Write it down/.test(inferRun.liveCap),
    JSON.stringify(inferRun).slice(0, 240));

  // ONE AXIS, ONE PAIR OF WORDS, ONE CONTROL. The card said the same thing
  // three ways — `kind: live/recorded` inside, a Source select offering
  // "Generated / Fixed", and "Written / Generated" over the Material clusters
  // — so "Generated" named both a cluster and a state and "Fixed"/"Written"
  // named one state twice ("the nature of the Material still feels opaque").
  // A part is GENERATED or STATIC, and the take bar's second button is the
  // transition; the Source select is gone (it was the destructive door — it
  // wrote the field and captured nothing, so a generating part became an
  // EMPTY written one).
  // RESTATED 2026-09-16 — THE STATE'S WORD IS STATIC (user: "i don't like
  // 'written' as the word for the state, i like 'static', 'written' makes more
  // sense as meaning by hand"). Measured before the rename: 21 user-visible
  // uses of WRITTEN meant the state and 1 meant by-hand, and the state gave the
  // word up anyway — so WRITTEN now has exactly one job and exactly one home,
  // the by-hand heading in the actions popover. That makes the ABSENCE clause
  // here sharper, not weaker: nothing on the closed card, titles included, may
  // say Written, because the state reaching for it again is precisely the
  // collision this rename undid.
  // THIS CHECK'S OWN NAME WAS THE TELL (2026-09-13): it claimed "one pair of
  // words" while asserting a SECOND pair — the faces said Lock/Unlock for the
  // very axis the hints called WRITTEN/GENERATED. The transition names its
  // destination in the axis's own words now, and the clause with teeth is the
  // ABSENCE: no visible text on the card may say Lock or Unlock, because "we
  // stopped saying it two ways" is exactly the claim that regresses quietly.
  // (The padlock is not free to reuse either — v1's Bar Lock and Area Write
  // both mean "freeze a loop and repeat it verbatim" in this same panel.)
  const vocab = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const show = async () => { const h = document.getElementById('bloom-v2-layers');
      if (h) h._sig = ''; window._v2.render(E); await wait(240);
      card().classList.remove('collapsed'); };
    const hint = () => (card().querySelector('.v2-notecount') || {}).textContent || '';
    const cap = () => (card().querySelector('.v2-capture') || {}).textContent.trim();
    const o = {};
    // GENERATED
    L().part.kind = 'live'; delete L().part.made; E.getCfg(); await show();
    o.liveHint = hint(); o.liveCap = cap();
    // STATIC, from a rolled take
    window._v2.capture(E, L()); E.getCfg(); await show();
    o.lockHint = hint(); o.lockCap = cap();
    // STATIC, by hand — ONE face for both static cases: `made` used to
    // split them ("Unlock" a rolled take, "Generate instead" notes you drew),
    // which is a distinction the new wording does not need to make.
    L().part.made = 'compose'; E.getCfg(); await show();
    o.handHint = hint(); o.handCap = cap();
    // ONE CONTROL for the axis: the select is gone
    o.selects = card().querySelectorAll('[data-f="part.kind"]').length;
    // …and no VISIBLE text on the card calls the state "Fixed" any more
    const vis = [];
    card().querySelectorAll('*').forEach((el) => {
      if (el.children.length || !el.textContent.trim()) return;
      if (el.getBoundingClientRect().height > 0) vis.push(el.textContent);
    });
    o.saysFixed = vis.filter((t) => /\bFixed\b/.test(t)).length;
    // …nor WRITTEN, which is the by-hand word now and nothing else. Capital W
    // deliberately: the ACTION keeps its verb ("✎ written down" in ℹ Why?,
    // ✎ Write it down on the face) — it is the STATE wearing the word that was
    // the collision. The one surviving heading (✎ Written — you choose the
    // notes) lives in the actions popover, which is shut here.
    o.saysWritten = vis.filter((t) => /\bWritten\b/.test(t)).length;
    o.writtenTitles = [...card().querySelectorAll('[title]')]
      .filter((el) => el.getBoundingClientRect().height > 0 && /\bWRITTEN\b/i.test(el.title))
      .map((el) => el.title.slice(0, 60));
    // …and NOTHING visible names the axis in the other language. Titles count:
    // a tooltip is where the second vocabulary hid longest.
    const lk = /\b(Lock|Unlock|Locked|Unlocked)\b/;
    o.saysLock = vis.filter((t) => lk.test(t)).length;
    o.lockTitles = [...card().querySelectorAll('[title]')]
      .filter((el) => el.getBoundingClientRect().height > 0 && lk.test(el.title))
      .map((el) => el.title.slice(0, 60));
    try { L().part = JSON.parse(svPart); E.getCfg(); await show(); } catch (e) {}
    return o;
  });
  ok('a part is GENERATED or STATIC — ONE pair of words, and the take bar is the only door between them',
    vocab.selects === 0 && vocab.saysFixed === 0 &&
    vocab.saysWritten === 0 && vocab.writtenTitles.length === 0 &&
    /GENERATED/.test(vocab.liveHint) && /STATIC/.test(vocab.lockHint) &&
    /STATIC/.test(vocab.handHint) &&
    // the transition names its DESTINATION, in the same two words as the state
    /Write it down/.test(vocab.liveCap) && /Generate instead/.test(vocab.lockCap) &&
    vocab.handCap === vocab.lockCap &&
    // …and there is no second vocabulary anywhere on the card, titles included
    vocab.saysLock === 0 && vocab.lockTitles.length === 0,
    JSON.stringify(vocab).slice(0, 360));

  // TWO AXES, AND THEY MAY NEVER SHARE A WORD (2026-09-16). The card answers
  // two different questions at once, four pixels apart: WHAT MAKES THE NOTES
  // (GENERATED ⟷ STATIC, the provenance line) and DOES IT CHANGE PER CYCLE
  // (LIVE ⟷ SAME EVERY PASS, the drawing's readout). For a day both used the
  // word "Static", which is how one axis's answer gets read as the other's —
  // this file's own documented failure ("a readout that names one axis is read
  // as naming all of them"). Renaming one pole alone would have relocated the
  // collision rather than ended it, so BOTH moved, and this pins the split:
  // the same card, both readouts, in both states, with neither word crossing.
  const wordRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const show = async () => { if (h) h._sig = ''; window._v2.render(E); await wait(260);
      card().classList.remove('collapsed'); };
    // READ BOTH READOUTS AT ONCE, off one card — the whole claim is that they
    // are on screen together and still say different words.
    const read = () => ({
      state: ((card().querySelector('.v2-notecount') || {}).textContent || '').trim(),
      live: ((card().querySelector('.v2-vizlab') || {}).textContent || '').trim(),
      line: ((card().querySelector('.v2-liveline') || {}).textContent || '').trim(),
      capTitle: ((card().querySelector('.v2-capture') || {}).title || ''),
    });
    const o = {};
    // (1) A STATIC PART WHOSE SETTINGS ARE LIVE — the combination that cannot
    // be said at all if the two axes share a vocabulary.
    L().part.kind = 'live'; delete L().part.made; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();      // → STATIC, made: 'take'
    L().part.vary = 1; E.getCfg();               // …and the dice are on
    await show();
    o.staticLive = read();
    o.isStatic = L().part.kind === 'recorded';
    o.saysStatic = /STATIC/.test(o.staticLive.state);
    o.saysLive = /^LIVE \(/.test(o.staticLive.live);
    // (2) …AND THE OTHER CORNER: generated, nothing re-rolling.
    delete L().part.vary; L().part.kind = 'live'; delete L().part.made; E.getCfg();
    await show();
    o.genSame = read();
    o.saysGenerated = /GENERATED/.test(o.genSame.state);
    o.saysSame = /^FIXED\b/.test(o.genSame.live);
    // (3) NEITHER WORD CROSSES. The liveness surfaces may never say "static"
    // in any case, and the state surfaces may never answer the per-cycle
    // question — measured in BOTH states, because a collision that only shows
    // in one of them is the one that ships.
    const crosses = (r) => ({
      liveSaysStatic: /static/i.test(r.live) || /static/i.test(r.line),
      stateSaysCycle: /same every pass|\bFIXED\b/.test(r.state) || /\blive\b/i.test(r.state) ||
        /same every pass|\bFIXED\b/.test(r.capTitle),
    });
    o.crossA = crosses(o.staticLive);
    o.crossB = crosses(o.genSame);
    // (4) …AND THE THIRD AXIS KEEPS ITS OWN WORD. WHO CHOSE THE NOTES is
    // ✎ Written, and after the rename that heading is meant to be the ONLY
    // place the word appears — which the absence sweep beside this check
    // cannot tell apart from the word being deleted outright. So the surviving
    // use is pinned POSITIVELY, through the door that shows it.
    //
    // MEASURED 2026-09-16, AND VACUOUS TODAY: nothing renders `.v2-compose`.
    // The handler branch that opens `_ambActionsPopover('✎ Written — you
    // choose the notes', …)` is still there, but its trigger was retired with
    // the ✎ Written door on 2026-09-14 (the check "draw · grid · clear are each
    // reachable without the retired ✎ Written door" pins that retirement), so
    // that heading cannot currently be reached and the word appears in NO live
    // surface. Reported, not asserted as an absence — pinning "the door does
    // not exist" would make restoring it look like a regression. The clause is
    // written to judge the heading IF the door is ever rendered again, and
    // `byHandDoor` is reported so this vacuity stays visible instead of
    // passing as though it had judged something.
    const cb = card().querySelector('.v2-compose');
    o.byHandDoor = !!cb;
    if (cb) { cb.click(); await wait(320); }
    const ovT = document.querySelector('.ambient-addpop-ov .sm-title');
    o.byHandTitle = ovT ? (ovT.textContent || '').trim() : null;
    o.byHandOk = !cb || /\u270e Written \u2014 you choose the notes/.test(o.byHandTitle || '');
    { const xb = document.querySelector('.ambient-addpop-ov .addpop-close');
      if (xb) xb.click(); await wait(220); }
    o.popClosed = !document.querySelector('.ambient-addpop-ov');
    o.noCross = !o.crossA.liveSaysStatic && !o.crossA.stateSaysCycle &&
      !o.crossB.liveSaysStatic && !o.crossB.stateSaysCycle;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    await show();
    return o;
  });
  ok('the STATE and the LIVENESS readouts never share a word — STATIC · LIVE on one card',
    wordRun.isStatic && wordRun.saysStatic && wordRun.saysLive &&
    wordRun.saysGenerated && wordRun.saysSame && wordRun.noCross &&
    wordRun.byHandOk && wordRun.popClosed,
    JSON.stringify(wordRun));

  // ✦ PITCH QUANTIZE — the rename, the three destinations, and the hint that
  // is the point of the row (2026-09-16). It was "Follows changes", which the
  // user read as a question rather than an answer ("what is Follows changes
  // for… that sounds more like Pitch Quantize, with three modes, off, on (key)
  // and on (chord)"). It is exactly that, so it says so.
  //
  // MEASURED, NOT QUERIED. A `querySelector` hit proves nothing about a tab —
  // this file has recorded that failure six times — so the tab is checked the
  // way a finger meets it: a real rect, an `offsetParent`, the centre point
  // hit-testing to itself, and a press that lands on the select. The row's own
  // LABEL is hidden as a duplicate of the tab name, which is why the hint had
  // to exist: without it the tab opened onto a bare dropdown of three phrases
  // with nothing saying what question they answered.
  const pqRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part), svHarm = L().harmony;
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    // `kind:recorded` — the row, and therefore the TAB, exist for a STATIC
    // part. `syncSheet` drops a tab whose every row is gated off, so a live
    // fixture would measure "no tab" and call it a regression.
    L().part.kind = 'recorded'; L().part.made = 'take';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 64, dur: 0.2 }];
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(280);
    card().classList.remove('collapsed');
    window.__sec('Generate'); await wait(340);
    const o = {};
    const strip = document.querySelector('.v2-secpop .v2-pop-tabs');
    o.tabs = strip ? [...strip.querySelectorAll('[data-tab]')].map((x) => x.getAttribute('data-tab')).join(',') : '';
    const pq = strip && [...strip.querySelectorAll('[data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Pitch quantize');
    o.tabFound = !!pq;
    if (pq) {
      pq.scrollIntoView({ block: 'center' });
      const r = pq.getBoundingClientRect();
      o.tabRect = Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.top);
      // a 0×0 rect is the tell, and `offsetParent` catches a tab inside
      // something collapsed — both documented, both cheap
      o.tabReachable = r.width > 0 && r.height >= 32 && !!pq.offsetParent &&
        (() => { const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return el === pq || pq.contains(el); })();
      pq.click(); await wait(260);
      o.tabOpens = pq.classList.contains('on');
    }
    // …AND IT OPENS ONTO THE CONTROL. A tab that lights with nothing behind it
    // is the empty room this rule exists to prevent.
    const sel = document.querySelector('.v2-secpop .v2-pop-pane [data-f="harmony"]');
    o.selFound = !!sel;
    if (sel) {
      const rs = sel.getBoundingClientRect();
      o.selRect = Math.round(rs.width) + 'x' + Math.round(rs.height);
      o.selShown = rs.width > 0 && rs.height > 0;
      // THE THREE DESTINATIONS. Values are the DATA keys and are untouched by
      // the rename (`fixed`/`diatonic`/`chordlock`) — asserting the faces and
      // the values together is what catches a list restated in one half only,
      // which renders a select BLANK (this file's documented trap).
      o.vals = [...sel.options].map((x) => x.value).join(',');
      o.faces = [...sel.options].map((x) => (x.textContent || '').trim());
      o.facesOk = /^Off\b/.test(o.faces[0] || '') && /^Key\b/.test(o.faces[1] || '') &&
        /^Chord\b/.test(o.faces[2] || '');
      // …and each face is "Name — gloss", the shape the rhythm and pitch lists
      // already used and this one alone did not.
      o.glossed = o.faces.every((f) => /—/.test(f));
      const row = sel.closest('.ambient-ctrl');
      o.rowVisible = !!row && row.getBoundingClientRect().height > 0 &&
        !row.classList.contains('v2-rowoff');
      o.rowLabel = ((row.querySelector('label') || {}).textContent || '').trim();
      // THE HINT IS THE POINT OF THE ROW. The label is hidden as a duplicate of
      // the tab above it, so the hint is the only thing on screen that says
      // what the three phrases answer — and it states the exemption, which is
      // invisible everywhere else: a note edited by hand keeps its drawn pitch.
      o.hint = ((row.querySelector('.ambient-hint') || {}).textContent || '').trim();
      o.hintSays = o.hint.length > 10 && /by hand/i.test(o.hint);
      o.labelDup = !!row.querySelector('label') &&
        getComputedStyle(row.querySelector('label')).display === 'none';
    }
    // THE OLD NAME IS GONE — visible text and titles, with the section open.
    const vis = [];
    card().querySelectorAll('*').forEach((el) => {
      if (el.children.length || !el.textContent.trim()) return;
      if (el.getBoundingClientRect().height > 0) vis.push(el.textContent);
    });
    o.saysOld = vis.filter((t) => /Follows changes/i.test(t)).length +
      [...card().querySelectorAll('[title]')]
        .filter((el) => /Follows changes/i.test(el.title)).length;
    // …AND THE OPTIONAL HINT ARG IS INERT FOR EVERY OTHER CALLER. `sel` gained
    // a 7th argument and fills the `.ambient-hint` span it always emitted
    // empty; 20 of the 21 call sites pass six arguments or fewer, so their
    // markup is byte-identical. Measured rather than trusted: outside the
    // ⚙ panel (whose `gsel` has always had hints of its own) exactly two select
    // rows carry hint text — `harmony`, which is this change, and
    // `instrument.tone`, a hand-built row that predates it. A row joining this
    // list is either a new hint (restate the line, with the reason) or the
    // optional arg leaking into a caller that never asked for one.
    const selRows = [...card().querySelectorAll('.ambient-ctrl')]
      .filter((r) => r.querySelector('select[data-f]') && !r.closest('.v2-genpop'));
    o.hinted = selRows
      .filter((r) => ((r.querySelector('.ambient-hint') || {}).textContent || '').trim())
      .map((r) => r.querySelector('select[data-f]').getAttribute('data-f')).sort().join(',');
    o.hintInert = o.hinted === 'harmony,instrument.tone';
    window.__toContent(); await wait(200);
    try { L().part = JSON.parse(svPart); } catch (e) {}
    if (svHarm == null) delete L().harmony; else L().harmony = svHarm;
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(220);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('✦ Pitch quantize is a REACHABLE tab onto three destinations, and the row says what they answer',
    pqRun.tabs === 'Method,Transpose,Pitch quantize' &&
    pqRun.tabFound && pqRun.tabReachable && pqRun.tabOpens &&
    pqRun.selFound && pqRun.selShown && pqRun.rowVisible &&
    pqRun.vals === 'fixed,diatonic,chordlock' && pqRun.facesOk && pqRun.glossed &&
    pqRun.hintSays && pqRun.saysOld === 0 && pqRun.hintInert,
    JSON.stringify(pqRun));

  // THE MATERIAL TAB IS TWO DOORS AND A LINE — NOT A READING (2026-09-13,
  // user: "this popover feels noisy and overly complicated"). Measured at
  // 390px before the cut: the tab was 228px of which 150px (66%) was TEXT,
  // against two buttons — a static 73px model paragraph, a 51px LABELLED ROW
  // carrying a dice signpost and NO control, and a 26px provenance line that
  // ended by repeating the note count and bar count the section head states
  // four pixels above it. Three facts, each said two or three times.
  // The clauses with teeth are the ones that regress quietly: a pure-prose row
  // creeping back, and the head's own summary being echoed in the line.
  const noiseRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    // a GENERATED part — the state that carries the most text
    L().part.kind = 'live'; L().part.mat = 'roll';
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 5, rotate: 2 };
    L().part.pitch = { kind: 'walk', span: 3 }; L().part.bars = 4; E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(260);
    card().classList.remove('collapsed');
    window.__sec('Generate'); await wait(320);
    const mt = [...card().querySelectorAll('.v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (mt) { mt.click(); await wait(240); }
    const pane = card().querySelector('.v2-secpop-pane') || card().querySelector('.v2-pop-pane');
    const body = (pane && pane.querySelector('.ambient-grp-body')) || pane;
    const H = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
    const rows = [...body.children].filter((el) => H(el) > 0).map((el) => ({
      h: H(el), ctrls: el.querySelectorAll('button,select,input,canvas').length,
      lab: ((el.querySelector(':scope > label') || {}).textContent || '').trim(),
    }));
    const o = { rows, tabH: rows.reduce((a, r) => a + r.h, 0) };
    // THE MATERIAL BLOCK, separately (2026-09-15, the old-GEOMETRY fork). This
    // check measured a tab that held the doors and the line and nothing else;
    // ✦ Method now also holds the RHYTHM RULE and its knob row, which moved in
    // when the Rhythm tab was merged into it — so the whole tab's height stopped
    // being a statement about copy creep. The rows this claim is about are the
    // ones carrying the doors and the provenance line, and they are pinned at
    // the number they were measured at.
    o.matH = [...body.children]
      .filter((el) => H(el) > 0 && (el.querySelector('.v2-notesrow') || el.querySelector('.v2-notecount')))
      .reduce((a, el) => a + H(el), 0);
    // EVERY block in the tab must DO something — a labelled row of prose with
    // no control is a reading, not a control surface
    o.allActed = rows.length > 0 && rows.every((r) => r.ctrls > 0);
    o.noParagraph = !card().querySelector('.v2-matmodel') && !card().querySelector('.v2-varysign');
    const nc = card().querySelector('.v2-notecount');
    o.line = nc ? (nc.textContent || '').trim() : '';
    o.textH = H(nc);
    o.doors = card().querySelectorAll('.v2-notesrow .ambient-seg').length;
    // THE HEAD STATES THE SIZE, THE LINE STATES THE MATERIAL. Both visible at
    // once while this tab is open, so neither may say the other's fact.
    const hd = [...card().querySelectorAll('.v2-secpop-head *')]
      .filter((e) => !e.children.length && (e.textContent || '').trim() && H(e) > 0)
      .map((e) => e.textContent.trim()).join(' | ');
    o.head = hd;
    o.headSizes = /\bbars?\b/.test(hd);
    // the two EXACT forms that were duplicated — the line's old length tail
    // ("over 4 bars") and its old count suffix ("· 15 notes"). A loose /notes/
    // here is a false positive: "3 notes of the scale" is a pitch SPAN, not a
    // count of what the part holds.
    o.lineNoSizes = !/over \d+(\.\d+)? bars?\b/.test(o.line) && !/·\s*\d+ notes?\s*$/.test(o.line);
    // …and the tab is mostly CONTROL, not copy
    o.textShare = o.tabH ? Math.round((o.textH / o.tabH) * 100) : 100;
    // the forwarding address for the dice survived the row's deletion
    o.signposts = /Every pass/.test(o.line);
    try { L().part = JSON.parse(sv); E.getCfg(); if (h) h._sig = '';
      window._v2.render(E); await wait(200);
      card().classList.remove('collapsed'); } catch (e) {}
    return o;
  });
  ok('the Method tab is two doors and a line — no block without a control, nothing said twice',
    // two doors since ⌫ Clear moved to the drawing's head (2026-09-16)
    noiseRun.allActed && noiseRun.noParagraph && noiseRun.doors === 2 &&
    noiseRun.headSizes && noiseRun.lineNoSizes && noiseRun.signposts &&
    // a watchdog, not a target: it measured 66% text before the cut
    noiseRun.textShare <= 50 && noiseRun.matH <= 190,
    JSON.stringify(noiseRun).slice(0, 420));

  // 🎲 NEW TAKE REACHES THE EAR. Reported as "it's playing the old take after
  // pressing New take": the press rolls the take and redraws, but audio for
  // this layer was already SCHEDULED — a running preview had a whole cycle in
  // flight, and while the transport runs there is a lookahead — so the old
  // take kept sounding against a drawing that had moved. The press still never
  // STARTS audio; it retracts the audio it superseded, and a preview that is
  // already playing follows it.
  const takeEarRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svPart = JSON.stringify(L().part);
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.rhythm = { kind: 'euclid', steps: 16, n: 5 };
    L().part.pitch = { kind: 'walk', range: 7 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(280);
    card().classList.remove('collapsed');
    const seen = []; const orig = window.playNote;
    window.playNote = function (f) {
      if ((window._ambEmitKey || '').indexOf('v2:') === 0) seen.push(Math.round(f));
      return orig.apply(this, arguments);
    };
    const o = {};
    try {
      window._v2.preview(E, L()); await wait(500);
      o.before = seen.join(',');
      o.take0 = L().part.take | 0;
      const n0 = seen.length;
      await window.__gate(card().querySelector('.v2-newtake'), 'roll'); await wait(700);
      o.after = seen.slice(n0).join(',');
      o.take1 = L().part.take | 0;
      o.stillPreviewing = !!window._v2.previewing(L());
      window._v2.previewKill(E, L()); await wait(200);
    } finally { window.playNote = orig; }
    try { L().part = JSON.parse(svPart); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return o;
  });
  ok('🎲 New take reaches the ear — a running preview follows the press, the superseded take does not',
    takeEarRun.take1 === takeEarRun.take0 + 1 && takeEarRun.before.length > 0 &&
    takeEarRun.after.length > 0 && takeEarRun.after !== takeEarRun.before &&
    takeEarRun.stillPreviewing,
    JSON.stringify(takeEarRun));

  // ── THE PICTURE IS DRAWN IN THE CLOCK THE NOTES WERE MADE IN (2026-09-18) ──
  // ▶ Preview pins `_progAnchor` / `_playStartAt` / `_barGridAnchor` to the press
  // so the changes start from the top, and restores them in its `finally` —
  // synchronously, before a single note has sounded. Every draw AFTER the press
  // then resolved the harmony at the same absolute times against a DIFFERENT
  // progression origin, so the picture showed the progression ROTATED under the
  // same notes: chord tones a third away, and once the span folds them, an
  // octave away. `Tone.now()` moves between presses, so the rotation moved too.
  // Reported as "notes are moving around and are not representing exactly what's
  // playing … chords seem to move octaves in the visualizer but playback stays
  // the same".
  //
  // MISALIGNED ON PURPOSE. The disagreement is invisible when the press happens
  // to land a whole number of chord spans from whatever origin the draw falls
  // back to — which it does often enough that one press proves nothing
  // (measured: press 1 agreed, press 2 was rotated by a whole chord). Parking a
  // KNOWN stale anchor a half-chord away makes it deterministic rather than a
  // coin toss. Poison-verified: short-circuiting the draw's clock scope gives
  // played D·D·Em·Em·F♯m·F♯m·G·G against drawn D·D·D·Em·Em·F♯m·F♯m·G.
  const vizAnchorRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    // D · Em · F♯m · G, a bar each, under a 4-bar live part taking its pitches
    // from the chord — so every group of three NAMES its chord and a rotation is
    // legible in the failure text instead of inferred from a diff.
    const cfg = E.getCfg();
    cfg.prog = { on: true, name: 'ANCHOR',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
               { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] }] };
    L().part.kind = 'live'; L().part.bars = 4; L().part.notes = [];
    L().part.rhythm = { kind: 'pulse', n: 8, steps: 16 };
    L().part.pitch = { kind: 'chord', span: 12 };
    E.getCfg();
    const h0 = document.getElementById('bloom-v2-layers'); if (h0) h0._sig = '';
    window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
    E._progAnchor = now + 1.0;          // half of a 2 s chord span at 120 bpm
    E._playStartAt = now + 1.0;
    const played = [];
    const orig = window.playNote;
    window.playNote = function (f) {
      if (f > 0) played.push(Math.round(69 + 12 * Math.log2(f / 440)));
      return orig.apply(this, arguments);
    };
    try { window._v2.preview(E, L()); } finally { window.playNote = orig; }
    await wait(700);
    card().classList.remove('collapsed');
    if (h0) h0._sig = ''; window._v2.render(E); await wait(450);
    const cv = card().querySelector('.v2-vizcv');
    const drawn = (cv && cv._hits || []).slice().sort((a, b) => a.t - b.t).map((x) => x.midi);
    window._v2.previewKill(E, L());
    delete E._progAnchor; delete E._playStartAt;
    // RESTORE — these cases share one project, and a progression left on is the
    // next check's bug.
    if (svProg) cfg.prog = svProg; else delete cfg.prog;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    E.getCfg(); if (h0) h0._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    // the picture draws ONE cycle and the emit window runs a hair past it, so
    // the claim is that the drawing is a PREFIX of what played, in order
    return { played, drawn,
             prefix: JSON.stringify(played.slice(0, drawn.length)) === JSON.stringify(drawn) };
  });
  ok('▶ Preview’s drawing shows the notes it PLAYED — not the progression rotated under them',
    vizAnchorRun.drawn.length > 0 && vizAnchorRun.prefix,
    'played=' + vizAnchorRun.played.join(',') + ' drawn=' + vizAnchorRun.drawn.join(','));

  // …AND THE PRESS MUST NOT MOVE THE PICTURE AT ALL. ▶ Preview lands the first
  // note ON the press, so the cycle begins `off` EARLIER — and the pin anchored
  // the changes at `t0`, which put chord 1 that far INTO the part instead of at
  // its top, while the stopped drawing aligns them with the part's own first
  // pass. The two disagreed by `off`, so the picture JUMPED the first time you
  // pressed Preview and neither state was the other's. Invisible whenever the
  // first onset is on beat 1 (`off` is 0 and they coincide) — hence a euclid
  // pattern ROTATED so the first onset is late. Five chords under a four-bar
  // part, the last a 7th, so a misalignment is a different note COUNT and not
  // only different pitches. Poison-verified: anchoring at `t0` again gives a
  // before-picture one chord short of what plays, and an after-picture that
  // does not match it.
  // READ THE VISIBLE CANVAS. There is more than one `.v2-vizcv` in the document
  // (the card body and the section sheet each carry the drawing), so a bare
  // `querySelector` can answer for the stale hidden copy nothing has redrawn —
  // which is how the "after" reading came back as the "before" draw.
  const vizSeamRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    const cfg = E.getCfg();
    cfg.prog = { on: true, name: 'SEAM',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
               { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] },
               { root: 9, intervals: [0, 4, 7, 10] }] };
    L().part.kind = 'live'; L().part.bars = 4; L().part.notes = [];
    L().part.rhythm = { kind: 'euclid', pulses: 7, steps: 16, rotate: 5 };
    L().part.pitch = { kind: 'chord', span: 12, voices: 4 };
    delete E._progAnchor; delete E._playStartAt; delete E._barGridAnchor;
    E.getCfg();
    const h0 = document.getElementById('bloom-v2-layers');
    const shot = async () => {
      card().classList.remove('collapsed');
      if (h0) h0._sig = ''; window._v2.render(E);
      await wait(450);
      const all = [...document.querySelectorAll('.v2-vizcv')];
      const cv = all.find((x) => x.offsetParent && x.getBoundingClientRect().height > 10) || all[0];
      return (cv && cv._hits || []).slice().sort((a, b) => a.t - b.t).map((x) => x.midi);
    };
    const before = await shot();
    const played = [];
    const orig = window.playNote;
    window.playNote = function (f) {
      if (f > 0) played.push(Math.round(69 + 12 * Math.log2(f / 440)));
      return orig.apply(this, arguments);
    };
    try { window._v2.preview(E, L()); } finally { window.playNote = orig; }
    await wait(700);
    const after = await shot();
    window._v2.previewKill(E, L());
    // RESTORE — one project, many cases; a progression left on is the next
    // check's bug.
    if (svProg) cfg.prog = svProg; else delete cfg.prog;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    E.getCfg(); if (h0) h0._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    return { before, after, played,
             still: before.length > 0 && before.join(',') === after.join(','),
             honest: before.length > 0 &&
               played.slice(0, before.length).join(',') === before.join(',') };
  });
  ok('a ▶ Preview press does not MOVE the picture — same take, same notes',
    vizSeamRun.still,
    'before=' + vizSeamRun.before.join(',') + ' after=' + vizSeamRun.after.join(','));
  ok('…and the un-previewed picture already showed what a preview would play',
    vizSeamRun.honest,
    'played=' + vizSeamRun.played.join(',') + ' drawn=' + vizSeamRun.before.join(','));

  // ── DRAWING THE PICTURE MUST NOT CHANGE THE PICTURE (2026-09-18) ────────
  // Strum's play order came from v1's `_ambStrumOrder`, which draws from
  // `_ambRand` — the ENGINE-WIDE stream (`_E.rng`). `notesFor` is what the
  // DRAWING asks, so merely repainting advanced the stream that decides the
  // notes: one call made 118 writes to `_E.rng`, every one from there. Three
  // consequences, all reported as one bug — the same take drew a different
  // order on the next repaint ("notes are moving around"), playback pulled at
  // its own point in that stream and disagreed with the picture ("not
  // representing exactly what's playing"), and a v2 layer silently shifted
  // every OTHER layer's draws as a side effect of being looked at.
  // FIDELITY MUST BE > 0 or this sees nothing: fidelity 0 is low→high every
  // time and spends no draw. Poison-verified: restoring the `_ambStrumOrder`
  // call gives SIX distinct pictures from six repaints.
  const vizStreamRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    const svStrum = { s: L().strum, f: L().strumFidelity };
    const cfg = E.getCfg();
    cfg.prog = { on: true, name: 'STREAM',
      chords: [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
               { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] }] };
    L().part.kind = 'live'; L().part.bars = 4; L().part.notes = [];
    L().part.rhythm = { kind: 'euclid', pulses: 7, steps: 16, rotate: 3 };
    L().part.pitch = { kind: 'chord', span: 12, voices: 4 };
    L().strum = 45; L().strumFidelity = 70;
    E.getCfg();
    const h0 = document.getElementById('bloom-v2-layers');
    // READ THE VISIBLE CANVAS — `.v2-vizcv` is in both the card body and the
    // section sheet, and the first in DOM order can be the stale hidden copy.
    const draw = async () => {
      card().classList.remove('collapsed');
      if (h0) h0._sig = ''; window._v2.render(E);
      await wait(400);
      const all = [...document.querySelectorAll('.v2-vizcv')];
      const cv = all.find((x) => x.offsetParent && x.getBoundingClientRect().height > 10) || all[0];
      return (cv && cv._hits || []).slice().sort((a, b) => a.t - b.t)
        .map((x) => Math.round(x.t * 1000) + ':' + x.midi).join(' ');
    };
    const shots = [];
    for (let i = 0; i < 5; i++) shots.push(await draw());
    const rng0 = E.rng;
    window._v2.withEdit(() => window._v2.withTake(window._v2.pinOf(L()), () =>
      window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: 8 })));
    const rngTouched = E.rng !== rng0;
    // RESTORE — one project, many cases.
    if (svProg) cfg.prog = svProg; else delete cfg.prog;
    try { L().part = JSON.parse(svPart); } catch (e) {}
    if (svStrum.s == null) delete L().strum; else L().strum = svStrum.s;
    if (svStrum.f == null) delete L().strumFidelity; else L().strumFidelity = svStrum.f;
    E.getCfg(); if (h0) h0._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    return { distinct: [...new Set(shots)].length, rngTouched, first: shots.slice(0, 2) };
  });
  ok('repainting the drawing does not CHANGE the drawing — five repaints, one picture',
    vizStreamRun.distinct === 1,
    vizStreamRun.distinct + ' distinct: ' + (vizStreamRun.first || []).map((x) => x.slice(0, 90)).join(' | '));
  ok('…because asking for the notes never touches the engine’s SHARED rng',
    !vizStreamRun.rngTouched, 'the draw consumed from _E.rng');

  // THE ROLL LIGHTS UP AS IT PLAYS, and RING OUT is the door for the chord
  // choke. "It sounds like some notes may be getting cut off" — measured, with
  // a progression on: 3 of 4 notes clamped, 1200ms → 738 / 238 / 738. That is
  // `_ambNoteChoke` and it is deliberate (a note is released by the next change
  // so a pad does not ring three chords later), but its opt-out is a v1 field
  // with a v1 control, so on this card the behaviour had no door — and the
  // drawing showed the FULL length while the ear heard the cut one.
  const playRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    const svRing = L().ring;
    const o = {};
    E.getCfg().prog = { on: true, name: 'RG',
      chords: [0, 5, 7, 9].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 2;
    L().part.rhythm = { kind: 'euclid', steps: 16, n: 5 };
    L().part.pitch = { kind: 'chord', voices: 2 };
    L().part.shape = Object.assign({}, L().part.shape || {}, { lenRatio: 100 });
    delete L().ring;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(280);
    card().classList.remove('collapsed');
    // THE CHOKE ITSELF, asked directly — one implementation, so the drawing and
    // the ear cannot disagree about it.
    const chokeOf = () => {
      const cv = card().querySelector('.v2-vizcv');
      const cs = Number.isFinite(cv._cs) ? cv._cs : 0;
      const cyc = window._v2.cycleSec(L(), E.getCfg());
      const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: cs, cycleSec: cyc })) || [];
      // a long note that starts INSIDE a chord, which is the case that gets cut
      const n = ns.find((x) => x && x.durMs > 400);
      if (!n) return null;
      const got = window._ambNoteChoke('v2:' + L().id, Tone.now() + 0.2, n.durMs, {});
      return { req: Math.round(n.durMs), got: Math.round(got) };
    };
    try { await Tone.start(); } catch (e) {}
    _ambStartGenerator(E); await wait(1500);
    o.playing = !!E.timer;
    o.chokeOff = chokeOf();
    // THE SWEEP IS DRAWN — on its own overlay, so the roll is not regenerated
    // per frame
    const lit = () => { const ph = card().querySelector('.v2-vizph');
      if (!ph || !ph.width) return -1;
      const d = ph.getContext('2d').getImageData(0, 0, ph.width, ph.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n; };
    o.sweep = lit();
    await wait(500);
    o.sweep2 = lit();
    // …ON THE AUDIBLE CLOCK. `Tone.now()` is `currentTime + lookAhead` — what
    // notes are SCHEDULED on — while what you hear is `currentTime − output
    // latency`, and in the shell the broadcast adds most of a second. Reported
    // as "the playhead is not in sync, it starts too early". The sweep records
    // the time it was drawn for, so the clock it used is measurable.
    o.clock = (() => {
      const ph = card().querySelector('.v2-vizph');
      if (!ph || !Number.isFinite(ph._at)) return null;
      const aud = (typeof _shapeAudibleNow === 'function') ? _shapeAudibleNow() : Tone.now();
      // BOTH CLOCKS FROM THE SAME FRAME. Reading `Tone.now()` here instead
      // let wall time since the last frame stand in for the latency, and the
      // poison (the schedule clock) passed.
      return { behindSchedule: +((ph._sched || 0) - ph._at).toFixed(4),
               offAudible: +(ph._at - (aud + 0.016)).toFixed(4) };
    })();
    o.overlayBox = (() => { const ph = card().querySelector('.v2-vizph');
      const cv = card().querySelector('.v2-vizcv');
      return (ph && cv) ? (Math.abs(parseFloat(ph.style.width) - cv.clientWidth) < 1.5 &&
                           Math.abs(parseFloat(ph.style.top) - cv.offsetTop) < 1.5) : false; })();
    // …and THE DRAWING SHOWS THE CHOKED LENGTH while playing, so the picture
    // and the ear agree. Compared against the choke's own answer for the SAME
    // notes at the SAME anchor — a full-length drawing beside a cut note is
    // exactly what "some notes are getting cut off" looked like.
    // FORCE A PLAYING DRAW FIRST. This clause asserts that the picture shows
    // the CHOKED length *while playing* — and the presses above it commit,
    // which drops `E._v2Phase` (the re-anchor idiom), so the next draw takes
    // the HELD path and correctly does not choke (nothing is playing that
    // record). Reading whichever draw happened to be last made the clause pass
    // by luck of timing; wait for the layer to be anchored again, then draw.
    for (let i = 0; i < 20; i++) {
      if (E._v2Phase && E._v2Phase['v2:' + L().id]) break;
      await wait(120);
    }
    window._v2.render(E); await wait(200);
    o.drawn = (() => {
      const cv = card().querySelector('.v2-vizcv');
      const geo = cv._plotGeo; const hits = cv._hits || [];
      if (!geo || !hits.length) return null;
      const cs = Number.isFinite(cv._cs) ? cv._cs : 0;
      const ns = (window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: cs, cycleSec: geo.cyc })) || [])
        .filter((n) => n && n.freq > 0);
      // PER NOTE, not per max: only the notes that start INSIDE a chord get
      // cut, so a maximum over all of them is always an uncut one (that
      // version passed with the drawn choke disabled — the poison found it).
      const inCyc = ns.filter((n) => n.at - cs >= -1e-6 && n.at - cs < geo.cyc);
      if (inCyc.length !== hits.length) return { mismatch: [inCyc.length, hits.length] };
      let found = null;
      for (let i = 0; i < inCyc.length; i++) {
        const raw = inCyc[i].durMs;
        const cut = window._ambNoteChoke('v2:' + L().id, inCyc[i].at, raw, {});
        if (!(cut < raw - 30)) continue;
        found = { raw: Math.round(raw), cut: Math.round(cut),
                  drawnMs: Math.round((hits[i].w / geo.w) * geo.cyc * 1000),
                  playing: !!geo.playing };
        break;
      }
      return found || { none: true };
    })();
    // RING OUT — reachable, and it stops the cut
    const gt = card().querySelector('.v2-gototab[data-goto="Pitch"]'); if (gt) gt.click();
    await wait(260);
    const lt = [...card().querySelectorAll('.v2-pop-tab')]
      .find((x) => x.getAttribute('data-tab') === 'Length');
    if (lt) lt.click(); await wait(220);
    const rb = card().querySelector('.v2-ringtoggle');
    o.door = !!rb && rb.getBoundingClientRect().height > 0;
    o.faceOff = rb ? rb.textContent.trim() : '';
    if (rb) rb.click(); await wait(500);
    o.ring = L().ring | 0;
    o.faceOn = (card().querySelector('.v2-ringtoggle') || {}).textContent || '';
    o.chokeOn = chokeOf();
    _ambStopGenerator(E); await wait(400);
    o.sweepAfterStop = lit();
    try {
      if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
      L().part = JSON.parse(svPart);
      if (svRing) L().ring = svRing; else delete L().ring;
      E.getCfg();
      E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  });
  ok('the roll lights up as it plays — a sweep on its own overlay, cleared on stop',
    playRun.playing && playRun.sweep > 20 && playRun.sweep2 > 20 &&
    playRun.sweep !== playRun.sweep2 && playRun.overlayBox &&
    playRun.sweepAfterStop === 0 &&
    // it reads the AUDIBLE clock: behind the schedule clock, and within a
    // frame of `currentTime − latency`
    playRun.clock && playRun.clock.behindSchedule > 0.005 &&
    Math.abs(playRun.clock.offAudible) < 0.05,
    JSON.stringify(playRun));
  // …AND IT ONLY CUTS WHAT GENUINELY RINGS OVER. Reported as "the second two
  // notes of a rolled part are dramatically truncated when I press play" — a
  // note landing three quarters of the way through a chord had 500 ms of room
  // and went 844 -> 488, so a line that was even before play came out ragged.
  // The tail is the NOTE now (a release is a decay, and one that fades over the
  // change is what legato sounds like) and a note may ring past by half its own
  // length, capped at one beat.
  const chokeRule = await page.evaluate(async () => {
    const E = _masterEng, L = () => window.__Lv2(E);
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svClk = [E._playStartAt, E._progAnchor, E._barGridAnchor];
    const svRing = L().ring;
    delete L().ring;
    E.getCfg().prog = { on: true, name: 'CK',
      chords: [0, 5, 7, 9].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    E.getCfg();
    E._playStartAt = 0; E._progAnchor = 0; E._barGridAnchor = 0;
    const q = (dur, at, rel) =>
      Math.round(window._ambNoteChoke('v2:' + L().id, at, dur, { release: rel }));
    // THE MATERIAL DECIDES. A LINE (one note at a time) is never choked — a
    // melody's note length comes from its rhythm, and clipping only the notes
    // near a change is what made an even line ragged. HARMONY is what the rule
    // is for, so the same numbers are asked of both.
    const svPitch = JSON.stringify(L().part.pitch);
    const svKind = L().part.kind;
    L().part.kind = 'live';
    L().part.pitch = { kind: 'walk', span: 3 }; E.getCfg();
    const o = { lineLong: q(3200, 1.5, 400), lineMid: q(844, 1.5, 400) };
    L().part.pitch = { kind: 'chord', voices: 3 }; E.getCfg();
    // a PAD, 8 s over a 2 s chord: clamped to the change
    o.pad = q(8000, 0.02, 3000);
    // …and one that genuinely swamps the next chord
    o.long = q(2600, 1.5, 400);
    // a short one is never touched, whatever the material
    o.short = q(200, 1.9, 100);
    // …and a note that fits with room to spare keeps its length
    o.fits = q(600, 0.02, 200);
    try { L().part.pitch = JSON.parse(svPitch); } catch (e) {}
    L().part.kind = svKind; E.getCfg();
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    if (svRing) L().ring = svRing;
    E.getCfg();
    E._playStartAt = svClk[0]; E._progAnchor = svClk[1]; E._barGridAnchor = svClk[2];
    return o;
  });
  ok('the choke holds HARMONY to the change and never touches a line',
    chokeRule.lineLong === 3200 && chokeRule.lineMid === 844 &&
    chokeRule.short === 200 && chokeRule.fits === 600 &&
    chokeRule.pad > 1500 && chokeRule.pad < 2000 &&
    chokeRule.long > 400 && chokeRule.long < 600,
    JSON.stringify(chokeRule));

  ok('Ring out is the door for the chord choke — off cuts the note, on lets it ring',
    playRun.door && /released by the next change/.test(playRun.faceOff) &&
    playRun.ring === 1 && /through the changes/.test(playRun.faceOn) &&
    playRun.chokeOff && playRun.chokeOff.got < playRun.chokeOff.req - 1 &&
    playRun.chokeOn && playRun.chokeOn.got === playRun.chokeOn.req &&
    // …AND THE PICTURE SAYS SO: the widest drawn note is the CHOKED length,
    // not the requested one (the poison that draws the full length passes
    // every other clause).
    playRun.drawn && playRun.drawn.playing &&
    playRun.drawn.cut < playRun.drawn.raw - 30 &&
    Math.abs(playRun.drawn.drawnMs - playRun.drawn.cut) < 90,
    JSON.stringify({ off: playRun.chokeOff, on: playRun.chokeOn, door: playRun.door,
                     drawn: playRun.drawn }));

  // THE TAKE YOU ROLLED IS WHAT PLAYS. Reported as "I created a new take, the
  // visualizer updated, but when it starts playing both playback and viz revert
  // to the prior take" — and that is exactly what it was: the drawing pinned
  // `part.take` while the EMITTER seeded off the CYCLE INDEX, so pressing play
  // after rolling take 1 gave cycle 0, which IS take 0. Per-cycle dice are a
  // choice now (`part.vary`), absent by default.
  const takePlays = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svPart = JSON.stringify(L().part);
    L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 2;
    L().part.rhythm = { kind: 'euclid', steps: 16, n: 5 };
    L().part.pitch = { kind: 'walk', range: 7 };
    delete L().part.vary;
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(260);
    card().classList.remove('collapsed');
    const cyc = window._v2.cycleSec(L(), E.getCfg());
    const cycleAt = (c) => (window._v2.notesFor(L(),
      { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: c * cyc, cycleSec: cyc }) || [])
      .map((n) => Math.round(n.freq)).join(',');
    const drawnTake = () => window._v2.withTake(window._v2.pinOf(L()), () =>
      (window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: cyc }) || [])
        .map((n) => Math.round(n.freq)).join(','));
    const o = {};
    o.before = { drawn: drawnTake(), c0: cycleAt(0), c3: cycleAt(3) };
    window._v2.newTake(L(), null); E.getCfg();
    o.take = L().part.take | 0;
    o.after = { drawn: drawnTake(), c0: cycleAt(0), c3: cycleAt(3) };
    // EVERY cycle plays the take the drawing shows
    o.playsTheTake = o.after.drawn === o.after.c0 && o.after.c0 === o.after.c3;
    o.movedWithTake = o.after.c0 !== o.before.c0;
    // …and the dice are still there, as a choice
    const tg = card().querySelector('.v2-varytoggle');
    o.door = !!tg;
    o.faceOff = tg ? tg.textContent.trim() : '';
    if (tg) tg.click(); await wait(400);
    o.vary = L().part.vary | 0;
    o.faceOn = (card().querySelector('.v2-varytoggle') || {}).textContent || '';
    o.varies = cycleAt(0) !== cycleAt(3);
    delete L().part.vary; E.getCfg();
    try {
      L().part = JSON.parse(svPart); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  });
  ok('the take you rolled is what PLAYS — every cycle, and the dice are a choice',
    takePlays.take === (takePlays.before.drawn === takePlays.after.drawn ? -1 : takePlays.take) &&
    takePlays.playsTheTake && takePlays.movedWithTake &&
    takePlays.door && /Play this take/.test(takePlays.faceOff) &&
    takePlays.vary === 1 && /Re-roll every cycle/.test(takePlays.faceOn) && takePlays.varies,
    JSON.stringify(takePlays).slice(0, 320));

  // A PER-PART LAYER'S CYCLE IS THE PART PASS. Reported as "the visualization
  // is not resized by part; first part is 5 chords, second is 4, when showing
  // the 2nd it's still 5". It was not only the picture: the TICK laid every
  // part's record over the EDITED record's cycle, so part B (4 bars) PLAYED
  // over 5 bars because part A happened to be selected — the "what a part
  // plays depends on which part is selected" wart the ice model exists to
  // remove. The cycle grid is the part passes now, and the drawing and the
  // playhead ask the same function the tick walks.
  const ppCyc = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svParts = L().parts ? JSON.stringify(L().parts) : null;
    const svClk = [E._playStartAt, E._progAnchor, E._barGridAnchor];
    E.getCfg().prog = { on: true, name: 'PL',
      parts: [{ name: 'A', len: 5 }, { name: 'B', len: 4 }],
      chords: [0, 2, 4, 5, 7, 9, 11, 0, 2].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.rhythm = { kind: 'ground', steps: 8, n: 1 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    L().partFor = 0;
    E.getCfg();               // the reconciler fits each record to its part
    E._playStartAt = 0; E._progAnchor = 0; E._barGridAnchor = 0;
    const barSec = (60 / (+document.getElementById('tempo-input').value || 120)) * 4;
    const at = (bar) => bar * barSec + 0.01;
    const w = (bar) => {
      const q = window._v2.cycleWindowAt(L(), E, E.getCfg(), at(bar), { startAt: 0 });
      return { cs: +(q.cs / barSec).toFixed(2), cyc: +(q.cyc / barSec).toFixed(2), part: !!q.part };
    };
    const n = (bar) => {
      const q = window._v2.cycleWindowAt(L(), E, E.getCfg(), at(bar), { startAt: 0 });
      return (window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
        cycleStart: q.cs, cycleSec: q.cyc }) || []).length;
    };
    const o = { bars: { edited: L().part.bars, b: (L().parts && L().parts[1]) ? L().parts[1].bars : null } };
    o.a = w(1); o.b = w(6); o.a2 = w(10);
    o.notesA = n(1); o.notesB = n(6);
    // …and an ordinary layer keeps the uniform lattice, byte-identical
    delete L().partFor; delete L().parts; delete L().partAll;
    L().part.bars = 2; E.getCfg();
    const q2 = window._v2.cycleWindowAt(L(), E, E.getCfg(), at(6), { startAt: 0 });
    o.plain = { cs: +(q2.cs / barSec).toFixed(2), cyc: +(q2.cyc / barSec).toFixed(2), part: !!q2.part };
    try {
      if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svParts) L().parts = JSON.parse(svParts); else delete L().parts;
      E.getCfg();
      E._playStartAt = svClk[0]; E._progAnchor = svClk[1]; E._barGridAnchor = svClk[2];
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  });
  ok('a per-part layer\u2019s cycle IS the part pass — its own length, not the edited part\u2019s',
    ppCyc.bars.edited === 5 && ppCyc.bars.b === 4 &&
    ppCyc.a.cs === 0 && ppCyc.a.cyc === 5 && ppCyc.a.part &&
    ppCyc.b.cs === 5 && ppCyc.b.cyc === 4 && ppCyc.b.part &&
    ppCyc.a2.cs === 9 && ppCyc.a2.cyc === 5 &&
    // the content follows: 5 changes × 3 voices vs 4 × 3
    ppCyc.notesA === 15 && ppCyc.notesB === 12 &&
    // …and a layer that is NOT per-part keeps the uniform lattice
    ppCyc.plain.part === false && ppCyc.plain.cyc === 2 && ppCyc.plain.cs === 6,
    JSON.stringify(ppCyc));

  // WATCHING vs WORKING. Three asks, one shape: an AREA control decides what a
  // layer plays as much as its own do (so its picture has to follow), the strip
  // that names which part you are EDITING said nothing about which one is
  // PLAYING, and with per-part content the drawing could only ever show the
  // record you had selected — so you could not watch the arrangement run.
  const watchRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    const svFor = L().partFor, svParts = L().parts ? JSON.stringify(L().parts) : null;
    const o = {};
    E.getCfg().prog = { on: true, name: 'WV',
      parts: [{ name: 'A', len: 2 }, { name: 'B', len: 2 }],
      chords: [0, 5, 7, 9].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    L().on = true; L().present = true; L().part.kind = 'live'; L().part.bars = 2;
    L().part.rhythm = { kind: 'pulse', steps: 16, n: 2 };
    // THREE VOICES for the salt step: a colour changes the chord's added tones,
    // so at one voice you get the root either way and the picture cannot move.
    L().part.pitch = { kind: 'chord', voices: 3 };
    // PER-PART: the edited record has 2 onsets, part B's has 7 — a count, not a
    // pitch set, because the chords differ between the parts and pitches would
    // differ with the swap broken too (the documented confound).
    L().partFor = 0;
    L().parts = { 1: JSON.parse(JSON.stringify(L().part)) };
    L().parts[1].rhythm = { kind: 'pulse', steps: 16, n: 7 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    _ambSyncFxVis(E); await wait(200);
    const drawn = () => (card().querySelector('.v2-vizcv')._hits || []);
    const pitches = () => drawn().map((x) => Math.round(x.midi)).join(',');
    // (1) AN AREA EDIT REPAINTS. Salt recolours the chords, so the same rules
    // make different notes — and only the LAYER's own commit used to repaint.
    const beforeSalt = pitches();
    E.getCfg().prog.chords[0].root = 3;          // an AREA control, not the layer's
    E.getCfg();
    _ambSyncFxVis(E); await wait(260);
    o.salt = { before: beforeSalt, after: pitches() };
    o.saltRepaints = beforeSalt !== o.salt.after && beforeSalt.length > 0;
    E.getCfg().prog.chords[0].root = 0;
    L().part.pitch.voices = 1;
    if (L().parts && L().parts[1]) L().parts[1].pitch.voices = 1;
    E.getCfg();
    // (2) and (3) need it playing
    try { await Tone.start(); } catch (e) {}
    _ambStartGenerator(E); await wait(1300);
    const stripState = () => {
      const el = document.getElementById('mix-bloom-curpart');
      if (!el) return null;
      const ps = el.querySelector('.ambient-curpart-sel');
      if (!ps) return null;
      // EDITING is the select's value; PLAYING is the same select wearing the
      // green mark, which only 👁 View puts on it.
      return { editing: [ps.value | 0],
               playing: ps.classList.contains('playing') ? [ps.value | 0] : [] };
    };
    const seenPlay = new Set(); const counts = { edit: new Set(), view: new Set() };
    let editingStayed = true;
    // RESTATED (2026-09-09): the DEFAULT is VIEW now — the drawing follows what
    // PLAYS, so the first loop samples the follow (both parts' counts) and the
    // ✎ Edit press is what pins the edited record. The old Edit default is
    // exactly the "one part only plays one of each chord in the visualization"
    // report: the picture held one part's record while another part sounded.
    o.refuse = null;
    for (let i = 0; i < 9; i++) {
      const st = stripState();
      if (st) { st.playing.forEach((x) => seenPlay.add(x));
        if (st.editing.join() !== '0') editingStayed = false; }
      counts.view.add(drawn().length);
      // WHILE ANOTHER PART'S RECORD IS DRAWN, an edit gesture must REFUSE —
      // the hit boxes index into the DRAWN record. On this LIVE fixture an
      // unguarded tap LOCKS the take (kind flips to 'recorded'), which is
      // what makes the poison loud.
      const cvv = card().querySelector('.v2-vizcv');
      if (o.refuse == null && cvv && cvv._vmOther != null && (cvv._hits || []).length) {
        const rr = cvv.getBoundingClientRect(), hb = cvv._hits[0];
        cvv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true,
          clientX: rr.left + hb.x + 2, clientY: rr.top + hb.y + 2 }));
        cvv.dispatchEvent(new MouseEvent('click', { bubbles: true,
          clientX: rr.left + hb.x + 2, clientY: rr.top + hb.y + 2 }));
        await wait(200);
        o.refuse = { kind: L().part.kind,
                     editor: !!card().querySelector('.v2-neinline .ambient-ctrl') };
      }
      await wait(850);
    }
    o.playSeen = [...seenPlay].sort().join(',');
    o.editingStayed = editingStayed;
    o.defaultMode = window._v2.vizModeOf(L());
    o.viewCounts = [...counts.view].sort((a, b) => a - b).join(',');
    // ✎ EDIT pins the record being edited while the parts cycle
    const vb = card().querySelector('.v2-modepick');
    o.door = !!vb && vb.getBoundingClientRect().height > 0 &&
      [...vb.options].some((x) => x.value === 'edit');
    if (vb) { vb.value = 'edit'; vb.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(700);
    o.mode = window._v2.vizModeOf(L());
    for (let i = 0; i < 9; i++) { counts.edit.add(drawn().length); await wait(850); }
    o.editCounts = [...counts.edit].sort().join(',');
    _ambStopGenerator(E); await wait(300);
    try {
      if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
      L().part = JSON.parse(svPart);
      if (Number.isFinite(svFor)) L().partFor = svFor; else delete L().partFor;
      if (svParts) L().parts = JSON.parse(svParts); else delete L().parts;
      window._v2.vizMode(L(), 'view');   // the default
      E.getCfg();
      E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  });
  ok('an AREA edit repaints every layer drawing — salt moves the notes, so it moves the picture',
    watchRun.saltRepaints, JSON.stringify(watchRun.salt).slice(0, 200));
  ok('the current-part strip marks the part that is PLAYING, beside the one being edited',
    /0/.test(watchRun.playSeen) && /1/.test(watchRun.playSeen) && watchRun.editingStayed,
    JSON.stringify({ playing: watchRun.playSeen, editingStayed: watchRun.editingStayed }));
  ok('the drawing FOLLOWS what plays by default; \u270e Edit pins the record being edited',
    watchRun.door && watchRun.defaultMode === 'view' && watchRun.mode === 'edit' &&
    watchRun.viewCounts === '2,7' && watchRun.editCounts === '2',
    JSON.stringify({ def: watchRun.defaultMode, view: watchRun.viewCounts,
                     edit: watchRun.editCounts, door: watchRun.door }));
  ok('an edit gesture on a drawing showing ANOTHER part\u2019s record refuses \u2014 no lock, no editor',
    !!watchRun.refuse && watchRun.refuse.kind === 'live' && !watchRun.refuse.editor,
    JSON.stringify(watchRun.refuse));

  // THE DRAWING HAS A PITCH AXIS — a keyboard down the left and one SEMITONE
  // per row ("the content visualization needs a Y axis, use piano graphic, so
  // it's clear what note each event is"). It was a continuous squeeze of
  // whatever range the take happened to span: you could see that one note was
  // higher than another and not which note either of them was.
  const rollRun3 = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svPart = JSON.stringify(L().part);
    // a DETERMINISTIC part with known pitches, so the rows can be checked
    // against the notes rather than against each other
    L().on = true; L().present = true;
    L().part.kind = 'recorded'; L().part.bars = 2; L().part.made = 'take';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.25, midi: 61, dur: 0.2 },
                      { t: 0.5, midi: 67, dur: 0.2 }, { t: 0.75, midi: 60, dur: 0.2 }];
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    const cv = card().querySelector('.v2-vizcv');
    const hits = (cv._hits || []).slice().sort((a, b) => a.t - b.t);
    const o = { n: hits.length, geo: cv._barsGeo, h: Math.round(cv.getBoundingClientRect().height) };
    // ONE ROW PER SEMITONE: same pitch → same row; a semitone apart → exactly
    // one row apart; and the row is the same size everywhere.
    const yOf = {};
    hits.forEach((b) => { yOf[Math.round(b.midi)] = b.y; });
    const step = (yOf[60] - yOf[61]);
    o.samePitchSameRow = Math.abs(hits[0].y - hits[3].y) < 0.01;
    o.semitoneStep = step > 1;
    o.linear = Math.abs((yOf[60] - yOf[67]) - step * 7) < 0.75;
    // …AND ON THE KEY IT PLAYS. Every note's centre must sit inside the row the
    // KEYBOARD drew for that pitch — the whole point of the axis, and the one
    // clause the old continuous squeeze cannot satisfy (it is linear too, so a
    // linearity check passes with it restored).
    const pg = cv._pitchGeo || {};
    o.pg = pg;
    o.rowsExact = Math.abs(pg.rowH - (o.h - pg.top) / (pg.hiM - pg.loM + 1)) < 0.01;
    o.onItsKey = hits.every((b) => {
      const m = Math.round(b.midi);
      const rowTop = pg.top + (pg.hiM - m) * pg.rowH;
      const c = b.y + b.h / 2;
      return c > rowTop && c < rowTop + pg.rowH;
    });
    // …and every note starts AFTER the keyboard gutter
    o.pastGutter = hits.every((b) => b.x >= (cv._barsGeo.x0 || 0) - 0.01);
    o.gutter = (cv._barsGeo || {}).x0 || 0;
    // THE KEYBOARD IS DRAWN, not merely reserved: the gutter carries both white
    // keys and black ones. Read the pixels — a reserved-but-empty gutter is
    // exactly the failure this is for.
    try {
      const g2 = cv.getContext('2d');
      const dpr = cv.width / Math.max(1, cv.getBoundingClientRect().width);
      const px = Math.round(3 * dpr);
      const d = g2.getImageData(px, Math.round(20 * dpr), 1,
                                Math.round((o.h - 20) * dpr)).data;
      let light = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (d[i + 3] > 200 && lum > 180) light++;
        if (d[i + 3] > 200 && lum < 60) dark++;
      }
      o.whiteKeys = light; o.blackKeys = dark;
    } catch (e) { o.pxErr = String(e && e.message); }
    try { L().part = JSON.parse(svPart); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return o;
  });
  ok('the drawing has a piano Y axis — a drawn keyboard, one semitone per row',
    rollRun3.n === 4 && rollRun3.gutter >= 16 && rollRun3.pastGutter &&
    rollRun3.samePitchSameRow && rollRun3.semitoneStep && rollRun3.linear &&
    rollRun3.rowsExact && rollRun3.onItsKey &&
    rollRun3.whiteKeys > 20 && rollRun3.blackKeys > 8,
    JSON.stringify(rollRun3));

  // A MATERIAL PRESS DOES ONE OF THREE THINGS, and it says which. Reported as
  // "changing between material modes is still janky… it feels nondeterministic
  // as to when a new take is rolled and why; before a new take is rolled there
  // needs to be a confirmation". ADOPT (already in that mode) is silent and
  // changes nothing; RESTORE (a material you have used before) and BUILD FRESH
  // both replace what you are looking at, so both ask first and name which one
  // they are.
  const matAsk = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svPart = JSON.stringify(L().part);
    L().on = true; L().present = true; L().part.kind = 'live';
    delete L().part.mat; delete L().part.mem; delete L().part.made;
    // a KNOWN starting shape that is not the one pressed first, so "first" is
    // genuinely a switch
    L().part.rhythm = { kind: 'pulse', steps: 16, n: 1 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(280);
    card().classList.remove('collapsed');
    // RESTATED 2026-09-16 — ⚙ Deep is a DRAFT: nothing inside it asks (✕ Cancel
    // is the undo), and what a press did is said by its TOAST instead
    const asked = []; const svC = window.confirm;
    window.confirm = (m) => { asked.push(String(m)); return true; };
    const toasts = []; const svT = window.showToast;
    window.showToast = (m, o2) => { toasts.push(String(m)); try { return svT && svT(m, o2); } catch (e) {} };
    const before0 = JSON.stringify([L().part.rhythm, L().part.pitch, L().part.bars]);
    const shape = () => JSON.stringify([L().part.rhythm, L().part.pitch, L().part.bars]);
    // the four shapes live in the ⚙ Shape panel; it re-renders on every choice,
    // so re-open and re-query for each press (the documented detached-node trap)
    const press = async (sel) => {
      window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]);
      await wait(380);
      const el = card().querySelector(sel); if (!el) return { missing: true };
      const was = shape(); const n0 = asked.length, t0 = toasts.length;
      el.click(); await wait(430);
      return { changed: shape() !== was, asked: asked.length - n0,
               msg: toasts.length > t0 ? toasts[toasts.length - 1] : '' };
    };
    const o = {};
    o.first = await press('.v2-mkpart[data-mk="arp"]');
    o.again = await press('.v2-mkpart[data-mk="arp"]');
    o.roll = await press('.v2-rollrun');
    o.back = await press('.v2-mkpart[data-mk="arp"]');
    // ✕ CANCEL KEEPS WHAT YOU HAD — every press above was a draft
    window.confirm = svC; window.showToast = svT;
    const cl2 = card().querySelector('.v2-shapepop .v2-gencancel'); if (cl2) cl2.click();
    await wait(300);
    o.declinedKeeps = shape() === before0;
    o.panelClosed = !card().classList.contains('v2-genopen');
    try {
      L().part = JSON.parse(svPart); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(220);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  });
  ok('a material press inside ⚙ Deep never asks, says whether it builds fresh or restores, and ✕ Cancel keeps what you had',
    matAsk.first.asked === 0 && matAsk.first.changed &&
    /built fresh/i.test(matAsk.first.msg) &&
    // …and a repeat press on the LIT one adopts: no question, no change
    matAsk.again.asked === 0 && matAsk.again.changed === false &&
    matAsk.roll.asked === 0 && matAsk.roll.changed &&
    // coming BACK to a material restores its settings, and says so
    matAsk.back.asked === 0 && matAsk.back.changed &&
    /saved/i.test(matAsk.back.msg) &&
    matAsk.declinedKeeps && matAsk.panelClosed,
    JSON.stringify(matAsk).slice(0, 1400));

  // EXACTLY ONE MATERIAL DOOR IS LIT, AND IT TRACKS THE MATERIAL. Reported as
  // "clicking through the Written/Generated modes is buggy; options stay
  // highlighted, Composed gets stuck on". Two causes, both measured: the lit
  // map still named the four shape buttons, which MOVED INTO the Shape panel,
  // so a generated part lit NOTHING in the row (mat 'ground', lit []); and an
  // open compose session wrote `.on` — the class that means "this material
  // made the notes" — onto ✎ Composed, so it stayed lit on a part Groundwork
  // had made. One class, one meaning: the session has its own mark.
  const doorRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const show = async () => { const h = document.getElementById('bloom-v2-layers');
      if (h) h._sig = ''; window._v2.render(E); await wait(240);
      card().classList.remove('collapsed'); };
    const lit = () => ['v2-genbtn']
      .filter((c) => { const e = card().querySelector('.' + c);
        return e && e.classList.contains('on'); });
    const o = {};
    // a default generated card: the shape door owns hand-built shapes too
    L().part.kind = 'live'; delete L().part.mat; delete L().part.made;
    L().part.rhythm = { kind: 'euclid', steps: 16, n: 3 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg(); await show();
    o.dflt = lit();
    // …Groundwork, through the Generated panel (its fifth shape now)
    const svCf8 = window.confirm; window.confirm = () => true;
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(300);
    card().querySelector('.v2-shapepop .v2-mkpart[data-mk="ground"]').click(); await wait(500);
    card().classList.remove('collapsed');
    o.ground = lit(); o.mat = L().part.mat;
    const dn = card().querySelector('.v2-shapepop .v2-gendone'); if (dn) dn.click(); await wait(350);
    o.groundAfter = lit();
    window.confirm = svCf8;
    // …and a compose session must not claim the material — ▦ Compose is one
    // press in the row above the drawing now (2026-09-14)
    card().querySelector('.v2-gridbtn').click(); await wait(800);
    o.composing = card().classList.contains('v2-composing');
    o.whileComposing = lit();
    o.sessMark = !!(card().querySelector('.v2-gridbtn') || {}).classList;
    const gc = card().querySelector('.v2-gacts .v2-gcancel'); if (gc) gc.click(); await wait(600);
    o.afterCancel = lit();
    try { L().part = JSON.parse(svPart); E.getCfg(); await show(); } catch (e) {}
    return o;
  });
  ok('exactly one Method door is lit, and it names the material — a compose session is not one',
    // RESTATED 2026-09-09: ground lights the ⚙ Generated door (its own door
    // is gone), so every ground state reads 'v2-genbtn'.
    doorRun.dflt.join() === 'v2-genbtn' && doorRun.mat === 'ground' &&
    doorRun.ground.join() === 'v2-genbtn' && doorRun.groundAfter.join() === 'v2-genbtn' &&
    doorRun.composing && doorRun.sessMark &&
    doorRun.whileComposing.join() === 'v2-genbtn' &&
    doorRun.afterCancel.join() === 'v2-genbtn',
    JSON.stringify(doorRun));

  // ---- ✎ WRITTEN IS NOT A DOOR ANY MORE (2026-09-14): it named a STATE, and
  // a new layer is in it already. Its three options each found a better home —
  // ▦ Compose in the row above the drawing, ✎ Draw in that row's mode picker,
  // ⌫ Clear beside the generators it undoes — and this check follows them
  // there. The CLAIM is unchanged and is still the one from 2026-09-09 ("add
  // ability to Clear content so user can be working with an empty
  // visualization"): Clear leaves an EMPTY WRITTEN part with ✎ Draw on, so the
  // very next tap on the roll adds a note, and the generated rules survive.
  const writRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const svPart = JSON.stringify(L().part);
    const svCf = window.confirm; window.confirm = () => true;
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 5 };
    L().part.pitch = { kind: 'walk', span: 3 };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(280);
    card().classList.remove('collapsed');
    const gt = (window.__toContent(), null);
    if (gt && !gt.classList.contains('on')) { gt.click(); await wait(220); }
    // ALL THREE ARE REACHABLE WITHOUT THE RETIRED DOOR — measured, not assumed:
    // a control that merely exists in the DOM proves nothing, so each is
    // required to have a box and to be the thing at its own centre.
    const reach = (sel) => { const e = card().querySelector(sel); if (!e || !e.offsetParent) return false;
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect(); if (r.width < 20 || r.height < 12) return false;
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!t && (t === e || e.contains(t)); };
    // ⌫ Clear sits in the drawing's head, right of the 👁 View picker
    // (moved out of ✦ Generate 2026-09-16) — measured there, on the same row.
    const o = { hasGrid: reach('.v2-gridbtn'),
                hasRoll: !!card().querySelector('.v2-modepick option[value="draw"]') };
    o.hasClear = reach('.v2-vizhead .v2-clearpart');
    { const cp = card().querySelector('.v2-vizhead .v2-clearpart'),
            mp = card().querySelector('.v2-vizhead .v2-modesel');
      o.clearBesideView = !!cp && !!mp && !!(mp.compareDocumentPosition(cp) & 4) &&
        !card().querySelector('.v2-matgrp .v2-clearpart'); }
    // …and ✎ Written is GONE, not merely moved
    o.noDoor = !card().querySelector('.v2-compose');
    const cb = card().querySelector('.v2-clearpart');
    if (cb) cb.click(); await wait(500);
    o.kind = L().part.kind; o.notes = (L().part.notes || []).length;
    o.rulesKept = (L().part.rhythm || {}).kind === 'euclid';
    card().classList.remove('collapsed');
    o.drawOn = (card().querySelector('.v2-modepick') || {}).value === 'draw';
    // …the very next tap on the empty roll draws
    const cv = card().querySelector('.v2-vizcv');
    cv.scrollIntoView({ block: 'center' }); await wait(180);
    const r2 = cv.getBoundingClientRect(), pg = cv._pitchGeo, pl = cv._plotGeo;
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r2.left + pl.x0 + pl.w * 0.3,
      clientY: r2.top + pg.top + (pg.hiM - 64) * pg.rowH + pg.rowH / 2 }));
    await wait(450);
    o.drew = (L().part.notes || []).length === 1;
    const dn0 = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (dn0) dn0.click(); await wait(150);
    // put Draw back OFF (a later check pins its unlit face) and the part back
    const db = card().querySelector('.v2-modepick');
    if (db) { db.value = 'view'; db.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(150);
    window.confirm = svCf;
    try { L().part = JSON.parse(svPart); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(200);
          card().classList.remove('collapsed'); } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('draw · grid · clear are each reachable without the retired ✎ Written door, and Clear leaves an empty roll with Draw on',
    writRun.noDoor && writRun.hasRoll && writRun.hasGrid && writRun.hasClear && writRun.clearBesideView &&
    writRun.kind === 'recorded' && writRun.notes === 0 && writRun.rulesKept &&
    writRun.drawOn && writRun.drew,
    JSON.stringify(writRun));

  // ---- ⊕ EXPAND — build a chord ON the open note (2026-09-09): every chord
  // that CONTAINS the note's sounding pitch class is offered, labelled with
  // the note's role in it; IN KEY is green, OUTSIDE the key orange; picking
  // one adds the other tones at the note's own position and length.
  const exRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const svPart = JSON.stringify(L().part);
    const svKey = [c0.keyOn, c0.keyRoot, c0.keyScale, c0.keyFollow];
    const svHarm = L().harmony || null;
    c0.keyOn = true; c0.keyRoot = 0; c0.keyScale = 'major'; c0.keyFollow = false;
    delete L().harmony;
    L().part.kind = 'recorded'; L().part.bars = 2;
    delete L().part.transpose; delete L().part.reg;
    L().part.notes = [{ t: 0.25, midi: 64, dur: 0.125 }];   // E4
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(280);
    card().classList.remove('collapsed');
    const gt = (window.__toContent(), null);
    if (gt && !gt.classList.contains('on')) { gt.click(); await wait(220); }
    const cv = card().querySelector('.v2-vizcv');
    cv.scrollIntoView({ block: 'center' }); await wait(150);
    const r2 = cv.getBoundingClientRect(), hb = (cv._hits || [])[0];
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r2.left + hb.x + hb.w / 2, clientY: r2.top + hb.y + 3 }));
    await wait(400);
    const ex = document.querySelector('.v2-layer .v2-neinline [data-na="expand"]');
    const o = { btn: !!ex };
    if (ex) ex.click(); await wait(280);
    const nx = document.querySelector('.v2-layer .v2-nex');
    o.open = !!nx && !nx.hidden;
    o.inN = nx ? nx.querySelectorAll('.v2-nexbtn.v2-nex-in').length : 0;
    o.outN = nx ? nx.querySelectorAll('.v2-nexbtn.v2-nex-out').length : 0;
    // the green/orange CLAIM, checked against the actual chords: every in-key
    // button's tones all sit in C major; some orange button holds one outside
    const CM = { 0: 1, 2: 1, 4: 1, 5: 1, 7: 1, 9: 1, 11: 1 };
    const tonesOK = (b) => {
      const r0 = +b.getAttribute('data-root');
      return String(b.getAttribute('data-ivs')).split(',').every((k) => CM[(r0 + (+k)) % 12]);
    };
    o.greensInKey = nx ? [...nx.querySelectorAll('.v2-nexbtn.v2-nex-in')].every(tonesOK) : false;
    o.orangesOut = nx ? [...nx.querySelectorAll('.v2-nexbtn.v2-nex-out')].every((b) => !tonesOK(b)) : false;
    // pick the in-key chord where the note is the ROOT → E minor on E4
    const pick = nx && [...nx.querySelectorAll('.v2-nexbtn.v2-nex-in')].find((b) => /root/.test(b.textContent));
    o.pick = pick ? pick.textContent.trim() : null;
    if (pick) pick.click(); await wait(400);
    const ns = (L().part.notes || []).slice().sort((a, b) => a.midi - b.midi);
    o.after = ns.map((n) => [Math.round(n.t * 100) / 100, n.midi]);
    o.chordBuilt = ns.length === 3 && ns.every((n) => Math.abs(n.t - 0.25) < 1e-6) &&
                   ns.map((n) => n.midi).join() === '64,67,71';
    const dn0 = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (dn0) dn0.click(); await wait(150);
    try {
      L().part = JSON.parse(svPart);
      if (svHarm) L().harmony = svHarm; else delete L().harmony;
      c0.keyOn = svKey[0]; c0.keyRoot = svKey[1]; c0.keyScale = svKey[2]; c0.keyFollow = svKey[3];
      E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      card().classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('⊕ Expand offers every chord holding the note — green really in key, orange really out — and builds the picked one',
    exRun.btn && exRun.open && exRun.inN > 0 && exRun.outN > 0 &&
    exRun.greensInKey && exRun.orangesOut && /root/.test(exRun.pick || '') &&
    exRun.chordBuilt,
    JSON.stringify(exRun));

  // ---- THE INSTRUMENT SHEET IS TWO TABS AND TWO FOLDS ---------------------
  // It was five tabs — Tone type, Tone, Register, Tone cycle, Envelope — which
  // is five presses to find out what the sheet holds. The type belongs WITH the
  // tone (it is the question above it, not a peer), the envelope is how that
  // voice behaves rather than a peer of it, and Register is the one control you
  // reach for while listening, so it sits in the head.
  const instShape = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    const sel2 = card.querySelector('[data-f="instrument.voice"]');
    sel2.value = 'synth'; sel2.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(320);
    // the card is REBUILT by that change, so re-resolve it before clicking
    const c2 = document.querySelector('.v2-layer');
    c2.classList.remove('collapsed');
    const gb = [...c2.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === 'Instrument');
    if (!gb) return { err: 'no Instrument button' };
    gb.click();
    await wait(320);
    const tabs = [...document.querySelectorAll('.v2-pop-tab')].map((t) => t.getAttribute('data-tab'));
    const head = document.querySelector('.v2-secpop-head');
    const reg = head && head.querySelector('[data-f="instrument.register"]');
    const regBox = reg ? reg.closest('.v2-pop-xtra').getBoundingClientRect() : null;
    const btns = reg ? [...reg.closest('.ambient-stepper').querySelectorAll('.ambient-step-btn')]
      .map((b2) => Math.round(b2.getBoundingClientRect().height)) : [];
    // the folds start SHUT, and their rows are not on screen until opened
    const envRow = () => document.querySelector('.v2-pop-pane [data-f="instrument.attack"]');
    const shown = (el) => !!el && el.closest('.ambient-ctrl') &&
      getComputedStyle(el.closest('.ambient-ctrl')).display !== 'none';
    const shut = !shown(envRow());
    const d = document.querySelector('.v2-pop-pane .v2-discbtn[data-disc="env"]');
    if (!d) return { err: 'no envelope fold', tabs: tabs };
    d.click(); await wait(200);
    const open = shown(envRow());
    d.click(); await wait(200);
    const shutAgain = !shown(envRow());
    return { tabs, reg: !!reg, regInHead: !!reg, regBtnH: btns,
             regFont: reg ? parseFloat(getComputedStyle(reg).fontSize) : 0,
             regW: regBox ? Math.round(regBox.width) : 0,
             headOverflow: head ? head.scrollWidth - head.clientWidth : 0,
             shut, open, shutAgain,
             inTabs: !!document.querySelector('.v2-pop-pane [data-f="instrument.register"]') };
  });
  ok('the Instrument sheet is Live + Tone set, with no tab for the type or the envelope',
    instShape.tabs.indexOf('Live') === 0 && instShape.tabs.indexOf('Tone set') > 0 &&
    instShape.tabs.indexOf('Tone type') < 0 && instShape.tabs.indexOf('Envelope') < 0 &&
    instShape.tabs.indexOf('Register') < 0, JSON.stringify(instShape.tabs));
  ok('Register is a ± in the sheet head, thumb-sized, and gone from the tabs',
    instShape.regInHead && !instShape.inTabs && instShape.regBtnH.every((h2) => h2 >= 40) &&
    instShape.regFont >= 16 && instShape.headOverflow <= 0,
    JSON.stringify({ h: instShape.regBtnH, f: instShape.regFont, w: instShape.regW,
                     over: instShape.headOverflow, inTabs: instShape.inTabs }));
  ok('the envelope is a fold inside Live — shut, opens, shuts again',
    instShape.shut && instShape.open && instShape.shutAgain, JSON.stringify(instShape));
  await page.evaluate(() => { const c = document.querySelector('.v2-pop-close'); if (c) c.click(); });
  await zz(200);

  // ---- REGISTER MOVES THE PART, RECORDED OR NOT ---------------------------
  // It is read by the LIVE pitch path only, so on a fixed part it was a control
  // on screen that moved nothing — reported as "register should shift the part
  // up or down an octave". Measured at playNote, because a config value that
  // nothing plays is exactly the failure being tested for.
  const regRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    L().part.kind = 'live'; E.getCfg(); window._v2.render(E);
    await wait(200);
    window._v2.rollRun(E, L()); window._v2.render(E); await wait(200);
    const hear = async () => {
      const seen = []; const orig = window.playNote;
      window.playNote = function (f) { seen.push(Math.round(f)); return orig.apply(this, arguments); };
      window._v2.preview(E, L()); await wait(160); window._v2.previewKill(E, L());
      window.playNote = orig; return seen;
    };
    L().instrument.register = 4; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();          // a fixed part, made at register 4
    const base = await hear();
    L().instrument.register = 5; E.getCfg();
    const up = await hear();
    L().instrument.register = 3; E.getCfg();
    const down = await hear();
    L().instrument.register = 4; L().part.transpose = 2; E.getCfg();
    const tr = await hear();
    const ratio = (a2, b2, r) => a2.length > 0 && a2.length === b2.length &&
      a2.every((f, i) => Math.abs(b2[i] / f - r) < 0.02);
    return { kind: L().part.kind, reg: L().part.reg, n: base.length,
      up: ratio(base, up, 2), down: ratio(base, down, 0.5),
      withTranspose: ratio(base, tr, Math.pow(2, 2 / 12)) };
  });
  ok('Register moves a RECORDED part by whole octaves, and composes with Transpose',
    regRun.n > 0 && regRun.reg === 4 && regRun.up && regRun.down && regRun.withTranspose,
    JSON.stringify(regRun));

  // ---- TONE TYPE NARROWS TONE ---------------------------------------------
  // "Voice" named the KIND of sound and sat beside "Tone" as if it were a peer;
  // and the list WAS constrained, by having three separate rows, which in a
  // tabbed sheet reads as a Tone tab that ignores the kit you chose.
  const toneNarrow = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng;
    // "Live" — the tab that holds the type, the tone and the folded envelope.
    const row = () => [...document.querySelectorAll('.v2-layer [data-v2tab="Live"]')]
      .find((r2) => r2.querySelector('select[data-f^="instrument."]') &&
                    /^Tone$/.test(((r2.querySelector('label') || {}).textContent || '').trim()));
    const read = () => {
      const r2 = row(); if (!r2) return { f: null, n: 0, opts: [] };
      const s2 = r2.querySelector('select');
      return { f: s2.getAttribute('data-f'), n: s2.options.length,
               opts: [...s2.options].slice(0, 40).map((o) => o.value),
               label: (r2.querySelector('label') || {}).textContent };
    };
    const set = async (v) => {
      const s2 = document.querySelector('.v2-layer [data-f="instrument.voice"]');
      s2.value = v; s2.dispatchEvent(new Event('input', { bubbles: true })); await wait(300);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    };
    await set('synth'); const synth = read();
    await set('kit'); const kit = read();
    await set('speech'); const speech = read();
    await set('synth');
    const typeLabel = (document.querySelector('.v2-layer [data-f="instrument.voice"]')
      .closest('.ambient-ctrl').querySelector('label') || {}).textContent;
    return { synth, kit, speech, typeLabel };
  });
  ok('the type is called Tone type, and ONE Tone row follows it',
    /Tone type/.test(toneNarrow.typeLabel) &&
    toneNarrow.synth.f === 'instrument.tone' && toneNarrow.kit.f === 'instrument.kit' &&
    toneNarrow.speech.f === 'instrument.speechVoice' &&
    /^Tone$/.test((toneNarrow.synth.label || '').trim()),
    JSON.stringify({ t: toneNarrow.typeLabel, s: toneNarrow.synth.f, k: toneNarrow.kit.f, p: toneNarrow.speech.f }));
  // The group head is a dashboard, so it must name the SOUND — the generated
  // kit's id is literally 'synth', so a drum layer summarised as "synth · A 400"
  // and read as a synth one.
  const instSum = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    // THE SUMMARY MOVED WITH THE GRID: it was on each group's button, and the
    // buttons came down with the sheet — it is the head's own `.v2-grpsum`
    // for the section you are in (and each tab's tooltip).
    const sum = () => {
      const t2 = [...card().querySelectorAll('.v2-gototab')]
        .find((x) => x.getAttribute('data-goto') === 'Instrument');
      if (t2 && !t2.classList.contains('on')) t2.click();
      const el = card().querySelector('.v2-secpop-head .v2-grpsum[data-grp="Instrument"]');
      return el ? el.textContent.replace(/\s+/g, ' ') : '';
    };
    const set = async (v) => { const s2 = card().querySelector('[data-f="instrument.voice"]');
      s2.value = v; s2.dispatchEvent(new Event('input', { bubbles: true })); await wait(320);
      card().classList.remove('collapsed'); };
    await set('kit'); await wait(200); const synthKit = sum();
    L().instrument.kit = 'tr808'; E.getCfg(); window._v2.render(E); await wait(260);
    card().classList.remove('collapsed');
    await wait(200); const named = sum();
    // PUT BACK WHAT THIS CHECK BORROWED. These cases run in ONE page against
    // ONE cfg, so a kit id left behind is the next check's bug — it failed the
    // synth-drum check, which reasonably expects the synth kit (the documented
    // state-leak trap, one store over).
    L().instrument.kit = 'synth'; E.getCfg();
    await set('synth');
    return { synthKit, named };
  });
  ok('the Instrument head names the KIT, not its id',
    /Synth kit/.test(instSum.synthKit) && /TR-808/.test(instSum.named),
    JSON.stringify(instSum));
  ok('a drum type offers KITS and no oscillators; a synth type offers oscillators',
    toneNarrow.kit.opts.indexOf('synth') >= 0 && toneNarrow.kit.opts.indexOf('sawtooth') < 0 &&
    toneNarrow.synth.opts.indexOf('sawtooth') >= 0 && toneNarrow.synth.n > toneNarrow.kit.n,
    JSON.stringify({ kit: toneNarrow.kit.opts.slice(0, 6), kitN: toneNarrow.kit.n, synthN: toneNarrow.synth.n }));

  // ---- THE TAKE: PREVIEW AUDITIONS, IT DOES NOT RE-WRITE ------------------
  // Reported as "Preview should not re-write the part". A live part's seeded
  // draws key on the CYCLE INDEX, so before the take was pinned every press
  // landed on whatever cycle the clock had reached and played something else —
  // the take you liked was gone the moment you played it again.
  //
  // MEASURE THE AUDIO, not the drawing: the picture is derived from the same
  // call, so a picture that agrees with itself proves only that one function is
  // consistent with itself. And SPACE THE PRESSES BEYOND ONE CYCLE — the
  // clock-derived index only moves once per cycle, so three presses inside one
  // cycle cannot tell a pinned take from an unpinned one. Poison-verified with
  // the spacing in place (unpinned: 2 distinct takes over a 3-cycle span).
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; E.getCfg();
    window._v2.rollRun(E, L);
    window._v2.render(E);
  });
  await zz(250);
  const takeRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const orig = window.playNote;
    const once = async () => {
      const seen = [];
      window.playNote = function (f) { seen.push(Math.round(f)); return orig.apply(this, arguments); };
      window._v2.preview(E, L()); await wait(160); window._v2.previewKill(E, L());
      window.playNote = orig;
      return seen.join(',');
    };
    const takes = [];
    for (let i = 0; i < 3; i++) { takes.push(await once()); await wait(1300); }
    const t0 = window._v2.takeOf(L());
    await window.__gate(document.querySelector('.v2-layer .v2-newtake'), 'roll');
    await wait(300);
    const rolled = await once();
    // DETERMINISTIC PROOF that the take is what selects the roll — three
    // presses being identical can pass by luck (the clock-derived index only
    // moves once per cycle, so a run of fast presses agrees either way). Ask
    // two different takes for their notes directly and compare.
    const ask = (tk) => {
      const cfg = E.getCfg();
      return window._v2.withTake(tk, () => window._v2.notesFor(L(),
        { E, cfg, key: 'v2:' + (L().id | 0), cycleStart: 0, cycleSec: 2 }))
        .map((n) => Math.round(n.freq)).join(',');
    };
    return { notes: takes[0].split(',').filter(Boolean).length,
             stable: takes.every((t) => t === takes[0]),
             takeMatters: ask(0) !== ask(5),
             take0: t0, take1: window._v2.takeOf(L()),
             rolledDiffers: rolled !== takes[0] };
  });
  ok('preview auditions the SAME take however often it is pressed',
    takeRun.notes > 0 && takeRun.stable && takeRun.takeMatters, JSON.stringify(takeRun));
  ok('🎲 New take is the only thing that re-rolls it',
    takeRun.take1 === takeRun.take0 + 1 && takeRun.rolledDiffers, JSON.stringify(takeRun));

  // ---- THE DRAWING IS THE EDITOR ------------------------------------------
  // Tap a note and change it. A LIVE part has no notes of its own, so tapping
  // one LOCKS the take first — which is also the check that locking freezes
  // exactly what was DRAWN rather than rolling once more (the reported "lock
  // the part Live came up with, before preview re-writes it").
  const noteEdit = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, o = {};
    const L = () => window.__Lv2(E);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    // COME OUT OF THE SECTION POPOVER FIRST (2026-09-13). Instrument · Pitch ·
    // Shape · Mix · FX open OVER the card, so one left open by an earlier probe
    // covers the drawing — `elementFromPoint` then answers about the scrim and
    // the covered-target check correctly refuses.
    { const c0 = document.querySelector('.v2-layer .v2-secpop-close'); if (c0) c0.click(); }
    await wait(160);
    const cv = () => document.querySelector('.v2-layer .v2-vizcv');
    o.hitsRecorded = ((cv()._hits) || []).length;
    const drawn = ((cv()._hits) || []).map((x) => Math.round(x.midi)).sort().join(',');
    const hit = ((cv()._hits) || [])[1];
    if (!hit) return o;
    // a REAL pointer at the note's own coordinates, and the element under that
    // point must be the canvas (the documented covered-target check)
    cv().scrollIntoView({ block: 'center' });
    const r = cv().getBoundingClientRect();
    const px = r.left + hit.x + hit.w / 2, py = r.top + hit.y + 3;
    o.hitTop = (document.elementFromPoint(px, py) || {}).className || '';
    cv().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: px, clientY: py }));
    await wait(320);
    o.kind = L().part.kind;
    o.lockedIsDrawn = (L().part.notes || []).map((n) => n.midi).sort().join(',') === drawn;
    // THE EDITOR IS PART OF THE CARD, not a dialog over it: it opens INSIDE the
    // viz block, directly under the drawing it edits. So it must be a live,
    // visible child of `.v2-partviz` — not merely present in the DOM.
    const ov = document.querySelector('.v2-layer .v2-partviz .v2-neinline');
    o.modal = !!ov && !ov.hidden && ov.getBoundingClientRect().height > 0;
    o.underTheDrawing = !!ov && !!ov.previousElementSibling &&
      /v2-vizcv|v2-vizph/.test(ov.previousElementSibling.className || '');
    if (!ov) return o;
    // THE DRAWING MARKS THE NOTE BEING EDITED — with the editor inline the
    // picture stays visible, and "Note 2 of 4" names a place in a list rather
    // than a mark on the picture.
    o.selDrawn = (document.querySelector('.v2-layer .v2-vizcv') || {})._sel;
    o.rows = [...ov.querySelectorAll('.ambient-ctrl label')].map((x) => x.textContent.trim()).filter(Boolean);
    // EVERY READOUT MUST NAME ITS UNIT. `_ambSl` folds its hint into a TITLE
    // attribute, which a phone never shows, so the first build rendered
    // "Position 1 · Length 2 · Attack 400" — nine sliders and not one unit
    // between them, reported as "much of these controls are unintelligible".
    // A bare number is the tell, and it is checkable.
    o.readouts = [...ov.querySelectorAll('.ambient-ctrl')].map((row) => {
      const rd = row.querySelector('.ambient-sl-v') || row.querySelector('.ambient-hint');
      return ((rd && rd.textContent) || '').trim();
    }).filter(Boolean);
    o.bare = o.readouts.filter((t) => /^-?\d+(\.\d+)?$/.test(t));
    const idxOf = () => { const m = ov.querySelector('.v2-netitle').textContent.match(/Note (\d+)/); return m ? +m[1] - 1 : -1; };
    const set = (sf, v) => { const el = ov.querySelector('[data-sf="' + sf + '"]');
      el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    // AN UNEDITED NOTE CARRIES NOTHING — absent means "the layer decides", and
    // that is what keeps a locked part byte-identical to the take it froze.
    // ---- THE DRAWN PIANO IS A CONTROL --------------------------------------
    // Pitch had ONE control, a ± stepper over 0..127 — nine taps to move a
    // fifth, with a keyboard naming every pitch three pixels away. A tap on a
    // key moves the selected note there.
    {
      const cvk = cv(), pg = cvk._pitchGeo, plot = cvk._plotGeo;
      o.keyPxSel = pg ? Math.round(pg.rowH * 10) / 10 : 0;
      const nn0 = L().part.notes[idxOf()];
      o.kbGeo = !!(pg && plot && pg.rowH > 0);
      if (o.kbGeo) {
        o.kbFrom = nn0.midi;
        // a target inside the drawn window, never the row it is already on
        const want = (nn0.midi + 3 <= pg.hiM) ? nn0.midi + 3 : nn0.midi - 3;
        o.kbWant = Math.max(pg.loM, Math.min(pg.hiM, want));
        const rk = cvk.getBoundingClientRect();
        const kx = rk.left + plot.x0 / 2;
        const ky = rk.top + pg.top + (pg.hiM - o.kbWant) * pg.rowH + pg.rowH / 2;
        cvk.scrollIntoView({ block: 'center' });
        const rk2 = cvk.getBoundingClientRect();
        const kx2 = rk2.left + plot.x0 / 2;
        const ky2 = rk2.top + pg.top + (pg.hiM - o.kbWant) * pg.rowH + pg.rowH / 2;
        // the key must actually be under the finger, not covered
        o.kbTop = ((document.elementFromPoint(kx2, ky2) || {}).className || '');
        cvk.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: kx2, clientY: ky2 }));
        await wait(320);
        o.kbGot = L().part.notes[idxOf()].midi;
        // …and the editor followed: its own title and stepper must not go stale
        const ovk = document.querySelector('.v2-layer .v2-neinline');
        o.kbTitle = ovk ? (ovk.querySelector('.v2-netitle') || {}).textContent || '' : '';
        // MOVED 2026-09-12: the Note field NAMES the pitch ("A3"), with the
        // number in `data-sv` (the shared ± delegation's opt-in). Same claim
        // — the field follows the key that was tapped — read where the
        // number now lives.
        const kbEl = ovk && ovk.querySelector('[data-sf="midi"]');
        o.kbStep = kbEl ? +kbEl.getAttribute('data-sv') : -1;
        o.kbFace = kbEl ? kbEl.value : '';
        // THE LIT KEY, read off the CANVAS. The gutter is a control now, so it
        // has to show which key the note is on — a reserved-and-blank strip is
        // exactly the failure being tested for, so assert the PIXELS.
        // RE-READ THE GEOMETRY. The pitch window is derived from the notes'
        // own range, so MOVING one can widen it — `rowH` and every row's y
        // shift, and the geometry captured before the tap samples the wrong
        // row (it read a neighbouring black key and looked like a missing
        // highlight). Re-query after every click, geometry included.
        const cx = cv().getContext('2d');
        const dpr = cv().width / cv().getBoundingClientRect().width;
        const pg2 = cv()._pitchGeo, plot2 = cv()._plotGeo;
        const pxAt = (m2) => {
          const yy = Math.round((pg2.top + (pg2.hiM - m2) * pg2.rowH + pg2.rowH / 2) * dpr);
          const d = cx.getImageData(Math.round((plot2.x0 / 2) * dpr), yy, 1, 1).data;
          return d[0] + ',' + d[1] + ',' + d[2];
        };
        // the accent marks the DRAWN pitch of the selected note (hit boxes
        // carry it as `midi`) — transpose/register sit between stored and
        // drawn, and this gate state carries a +2 shift, so sampling at the
        // STORED row read a plain key and called the accent missing
        const hbLit = ((cv()._hits) || []).find((x) => x.i === idxOf());
        const litM = hbLit ? Math.round(hbLit.midi) : o.kbGot;
        o.kbLit = pxAt(litM);
        const other = (litM + 5 <= pg2.hiM) ? litM + 5 : litM - 5;
        o.kbUnlit = pxAt(Math.max(pg2.loM, Math.min(pg2.hiM, other)));
        // the two KEY colours, so "lit" cannot pass merely by landing on a
        // black key while the comparison row is a white one
        o.kbKeyCols = ['232,228,242', '21,21,31',       // no key: plain
                       '196,169,240', '91,74,134',       // in scale
                       '142,139,158', '14,14,21'];       // out of scale
        // …and with NOTHING selected a key press must not silently move a note
        ov.querySelector('[data-na="done"]').click(); await wait(220);
        const before2 = L().part.notes.map((x) => x.midi).join(',');
        cv().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: kx2, clientY: ky2 }));
        await wait(220);
        o.kbNoSel = L().part.notes.map((x) => x.midi).join(',') === before2;
        // …and with the editor shut the drawing goes back to its reading size
        o.keyPxIdle = (cv()._pitchGeo || {}).rowH || 0;
        o.keyPxIdle = Math.round(o.keyPxIdle * 10) / 10;
        // …then re-open the same note so the checks below carry on as before
        const hb = ((cv()._hits) || []).find((x) => Math.round(x.midi) === o.kbGot) || ((cv()._hits) || [])[0];
        const r3 = cv().getBoundingClientRect();
        cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
          clientX: r3.left + hb.x + hb.w / 2, clientY: r3.top + hb.y + 3 }));
        await wait(300);
      }
    }
    if (!document.querySelector('.v2-layer .v2-neinline') ||
        document.querySelector('.v2-layer .v2-neinline').hidden) return o;
    o.cleanBefore = Object.keys(L().part.notes[idxOf()]).sort().join(',');
    set('vel', 25); set('atk', 1234); set('rel', 4321); set('glide', 333); await wait(120);
    const n = L().part.notes[idxOf()];
    o.stored = { vel: n.vel, atk: n.atk, rel: n.rel, glide: n.glide };
    // …and it must be HEARD, not merely stored (the dead-control class)
    const orig = window.playNote; const seen = [];
    window.playNote = function (f, pr) { seen.push({ f: Math.round(f), vol: pr && pr.volume,
      atk: pr && pr.attack, rel: pr && pr.release, glide: pr && pr.glideMs }); return orig.apply(this, arguments); };
    window._v2.preview(E, L()); await wait(160); window._v2.previewKill(E, L());
    window.playNote = orig;
    const mine = seen[idxOf()] || {};
    o.heard = { atk: mine.atk, rel: mine.rel, glide: mine.glide };
    // back to the layer's value = the field is DELETED, so absent stays the one
    // representation of "the layer decides"
    set('vel', 100); await wait(80);
    o.velCleared = !('vel' in L().part.notes[idxOf()]);
    const before = L().part.notes.length;
    ov.querySelector('[data-na="rm"]').click(); await wait(140);
    o.removed = L().part.notes.length === before - 1;
    const ov2 = document.querySelector('.v2-layer .v2-neinline');
    o.closed = !ov2 || ov2.hidden;
    return o;
  });
  ok('a note in the drawing is a tap target, and tapping one locks the take shown',
    noteEdit.hitsRecorded > 0 && /v2-vizcv/.test(noteEdit.hitTop) &&
    noteEdit.kind === 'recorded' && noteEdit.lockedIsDrawn, JSON.stringify(noteEdit).slice(0, 400));
  ok('every readout in the note editor names its unit — never a bare number',
    (noteEdit.readouts || []).length >= 8 && (noteEdit.bare || []).length === 0,
    JSON.stringify(noteEdit.readouts));
  ok('the note editor opens INSIDE the card, directly under the drawing, and the drawing marks the note',
    noteEdit.modal && noteEdit.underTheDrawing && noteEdit.selDrawn >= 0,
    JSON.stringify({ open: noteEdit.modal, under: noteEdit.underTheDrawing, sel: noteEdit.selDrawn }));
  ok('a tap on the drawn piano moves the selected note to that key',
    noteEdit.kbGeo && /v2-vizcv/.test(noteEdit.kbTop) &&
    noteEdit.kbGot === noteEdit.kbWant && noteEdit.kbGot !== noteEdit.kbFrom &&
    noteEdit.kbStep === noteEdit.kbWant &&
    // …and the FIELD says it in note names, which is what the title says too
    noteEdit.kbFace && noteEdit.kbTitle.indexOf(noteEdit.kbFace) >= 0 &&
    new RegExp('\u00b7 ').test(noteEdit.kbTitle),
    JSON.stringify({ from: noteEdit.kbFrom, want: noteEdit.kbWant, got: noteEdit.kbGot,
                     step: noteEdit.kbStep, face: noteEdit.kbFace,
                     title: noteEdit.kbTitle, top: noteEdit.kbTop }));
  // INVERTED 2026-09-08 with the reason: rows used to GROW while a note was
  // selected so the gutter keys were finger-sized — and the resize itself was
  // reported as the defect ("the grid resizes the moment I click a note").
  // One geometry, always: selecting changes NOTHING about the drawing; the
  // gutter keys stay reading-sized and the editor's ± Note stepper is the
  // precision path.
  ok('selecting a note changes NOTHING about the drawing — the key row holds its size',
    // 0.2, not 0.01: the two samples straddle the block's keyboard re-pitch,
    // which may legitimately WIDEN the sticky window a row (content change)
    // and shift rowH by ~0.1. The defect this guards is the 2x editing growth
    // (5.2 vs 10.2), which 0.2 separates with room.
    noteEdit.keyPxIdle > 0 && Math.abs(noteEdit.keyPxSel - noteEdit.keyPxIdle) <= 0.2,
    JSON.stringify({ selected: noteEdit.keyPxSel, idle: noteEdit.keyPxIdle }));
  ok('…the key it sits on is LIT, and a key press with nothing selected moves nothing',
    noteEdit.kbLit !== noteEdit.kbUnlit && noteEdit.kbNoSel &&
    (noteEdit.kbKeyCols || []).indexOf(noteEdit.kbLit) < 0 &&
    (noteEdit.kbKeyCols || []).indexOf(noteEdit.kbUnlit) >= 0,
    JSON.stringify({ lit: noteEdit.kbLit, unlit: noteEdit.kbUnlit, noSel: noteEdit.kbNoSel }));
  ok('the note editor offers length, position, volume, envelope and portamento',
    noteEdit.modal && ['Note', 'Position', 'Length', 'Volume', 'Attack', 'Decay', 'Sustain', 'Release', 'Portamento']
      .every((r2) => (noteEdit.rows || []).indexOf(r2) >= 0), JSON.stringify(noteEdit.rows));
  // ---- THE KEYBOARD SAYS WHICH KEYS BELONG --------------------------------
  // It named every pitch and said nothing about which of them are IN the
  // scale — and it is a control now, so "will this note fit" is asked exactly
  // when you aim at a key. Read off the CANVAS: a reserved-and-unpainted
  // gutter is precisely the failure being tested for.
  const scaleRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, h = document.getElementById('bloom-v2-layers');
    const c0 = E.getCfg();
    const sv = { on: c0.keyOn, follow: c0.keyFollow, root: c0.keyRoot, scale: c0.keyScale };
    const card0 = document.querySelector('.v2-layer');
    const was = { grp: ((card0.querySelector('.v2-gototab.on') || {}).getAttribute
                        && card0.querySelector('.v2-gototab.on').getAttribute('data-goto')) || '',
                  tab: ((card0.querySelector('.v2-pop-tab.on') || {}).getAttribute
                        && card0.querySelector('.v2-pop-tab.on').getAttribute('data-tab')) || '' };
    const NM = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const cv = () => document.querySelector('.v2-layer .v2-vizcv');
    const show = async (mut) => {
      const c = E.getCfg(); mut(c); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(340);
      const card = document.querySelector('.v2-layer');
      card.classList.remove('collapsed');
      const g = (window.__toContent(), null);
      if (g) { g.click(); await wait(260); }
    };
    // ONE PIXEL PER PITCH CLASS, in the gutter — geometry re-read every time,
    // because the pitch window follows the notes' range and shifts every row.
    const lit = () => {
      const c = cv(), bw = c.getBoundingClientRect().width;
      if (!bw) return null;
      const pg = c._pitchGeo, plot = c._plotGeo, cx = c.getContext('2d'), dpr = c.width / bw;
      const seen = {};
      for (let m = pg.loM; m <= pg.hiM; m++) {
        const pc = ((m % 12) + 12) % 12;
        if (seen[NM[pc]]) continue;
        const yy = Math.round((pg.top + (pg.hiM - m) * pg.rowH + pg.rowH / 2) * dpr);
        const d = cx.getImageData(Math.round((plot.x0 / 2) * dpr), yy, 1, 1).data;
        // the two PLAIN key colours; anything else is the in-scale mark
        const px = d[0] + ',' + d[1] + ',' + d[2];
        seen[NM[pc]] = (px === '196,169,240' || px === '91,74,134') ? 1 : 0;
        seen['?' + NM[pc]] = px;
      }
      return Object.keys(seen).filter((k) => k[0] !== '?' && seen[k]).sort().join(' ');
    };
    const o = {};
    await show((c) => { c.keyOn = true; c.keyFollow = false; c.keyRoot = 0; c.keyScale = 'major'; });
    o.cMaj = lit();
    // …and it MOVES with the key. A static "some keys are marked" would pass
    // whatever the scale is, which is the asserting-on-nothing trap.
    await show((c) => { c.keyRoot = 6; });
    o.fsMaj = lit();
    // a 12-tone scale lights every key, which says as much as lighting none
    await show((c) => { c.keyRoot = 0; c.keyScale = 'chromatic'; });
    o.chromatic = lit();
    // …and with no key at all there is nothing to be in or out of
    await show((c) => { c.keyOn = false; });
    o.keyOff = lit();
    // A GENUINELY FREE AREA — no key, no progression, no per-layer source.
    // `_ambKeyRootPc` still answers "what key WOULD apply" here, so without
    // the guard the gutter lights C major on an area that has no key at all.
    const svProg = E.getCfg().prog ? E.getCfg().prog.on : null;
    const svNotes = JSON.stringify((E.getCfg().layers || [])[0].notes || null);
    await show((c) => { c.keyOn = false; c.keyRoot = 0; c.keyScale = 'major';
                        if (c.prog) c.prog.on = false;
                        const L0 = (c.layers || [])[0]; if (L0) delete L0.notes; });
    o.free = lit();
    o.freeScale = !!window._v2.scaleAt(E, E.getCfg(), 0, (E.getCfg().layers || [])[0]);
    await show((c) => { if (c.prog && svProg !== null) c.prog.on = svProg;
                        const L0 = (c.layers || [])[0];
                        if (L0 && svNotes && svNotes !== 'null') L0.notes = JSON.parse(svNotes); });
    await show((c) => { c.keyOn = sv.on; c.keyFollow = sv.follow;
                        c.keyRoot = sv.root; c.keyScale = sv.scale; });
    // …and back to the sheet the checks below are standing in
    try {
      const cd = document.querySelector('.v2-layer');
      const g2 = [...cd.querySelectorAll('.v2-gototab')]
        .find((x) => x.getAttribute('data-goto') === was.grp);
      if (g2) { g2.click(); await wait(260); }
      const t2 = [...document.querySelector('.v2-layer').querySelectorAll('.v2-pop-tabs [data-tab]')]
        .find((x) => x.getAttribute('data-tab') === was.tab);
      if (t2) { t2.click(); await wait(240); }
    } catch (e) {}
    return o;
  });
  ok('the drawn piano marks the keys that are IN the scale, and follows the key',
    scaleRun.cMaj === 'A B C D E F G' && scaleRun.fsMaj === 'A# B C# D# F F# G#' &&
    scaleRun.chromatic === '' && scaleRun.keyOff === '' &&
    scaleRun.free === '' && scaleRun.freeScale === false,
    JSON.stringify(scaleRun));

  ok('an unedited note carries no overrides — absent is "the layer decides"',
    noteEdit.cleanBefore === 'dur,midi,t', noteEdit.cleanBefore);
  ok('a note edit is STORED and HEARD, not merely stored',
    noteEdit.stored && noteEdit.stored.vel === 25 && noteEdit.stored.glide === 333 &&
    noteEdit.heard && noteEdit.heard.atk === 1234 && noteEdit.heard.rel === 4321 &&
    noteEdit.heard.glide === 333, JSON.stringify({ s: noteEdit.stored, h: noteEdit.heard }));
  ok('setting a note field back to the layer’s value deletes it, and Remove removes',
    noteEdit.velCleared && noteEdit.removed && noteEdit.closed, JSON.stringify(noteEdit).slice(0, 200));

  // ---- DOOR 2: THE PATTERN GRID -------------------------------------------
  // The user named two existing surfaces that should be able to make a part.
  // This is the first: a grid of cells you edit, over the pattern the rules
  // drew — the same relationship v1's `euclidPattern` override has to its own
  // formula.
  //
  // RESTATED 2026-09-15 — WHERE THAT GRID LIVES. There were two of them: a
  // COMPUTED euclid preview over `r.steps` in the Rhythm tab, and the body's
  // ▦ Pattern grid over the STORED `r.cells` at bars × grid. Two lengths, two
  // sources, one label ("it's confusing having both Rhythm → Euclid as well as
  // Pattern in the same layer, they even contain different content"). The
  // preview is gone, so the probe moves to the body, which is the grid the user
  // actually has — CLAUDE.md wrote this move down before it happened ("the
  // gate's `gridOf` moves to the body with them"). What survives in the pane is
  // the `drawn` case, under its own name: a hand-drawn Roll's ONLY editor.
  await page.evaluate(() => {
    const L0 = (_masterEng.getCfg().layers || [])[0];
    L0.part.kind = 'live'; delete L0.part.form;     // ⌗ Roll, by the rules
    _masterEng.getCfg(); window._v2.render(_masterEng);
    const r = document.querySelector('.v2-layer [data-f="part.rhythm.kind"]');
    r.value = 'euclid'; r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await zz(300);

  // (A) THE DUPLICATION CANNOT COME BACK. On a GENERATED roll, ✦ Generate ▸
  // Method must carry no cell grid at all — pinned by ABSENCE in the view the
  // user has open, because "we removed it" is exactly the claim that quietly
  // regresses (and it has been re-added twice already, for reasons this file
  // records). The kit lanes row keeps its `.v2-cellrow` class and is NOT the
  // duplicate — lanes drive emission whatever the form — so it is asked about
  // separately rather than swept up by the class.
  const paneGrid = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    window.__sec('Generate'); await wait(300);
    const t = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (t) t.click(); await wait(260);
    const pane = document.querySelector('.v2-secpop .v2-pop-pane');
    const L0 = (_masterEng.getCfg().layers || [])[0];
    const rows = pane ? [...pane.querySelectorAll('.v2-cellrow')] : [];
    const o = {
      tabOn: !!t && t.classList.contains('on'),
      rhythm: L0.part.rhythm.kind, form: L0.part.form || 'roll',
      rows: rows.map((r) => (/v2-lanerow/.test(r.className) ? 'lanes' : 'cells') + ':' +
        (getComputedStyle(r).display === 'none' ? 'off' : 'ON')).join(' '),
      // nothing cell-shaped is on screen in this pane
      cells: pane ? [...pane.querySelectorAll('.v2-cellrow .ambient-euclid-cell')]
        .filter((c) => c.getBoundingClientRect().height > 0).length : -1,
      // …and the row that survives is called DRAWN STEPS. "Pattern" is the
      // FORM's word now, and one word for two mechanisms is how a control gets
      // misread — the report this whole change answers.
      labs: rows.map((r) => ((r.querySelector('label') || {}).textContent || '')
        .replace(/[↻]/g, '').trim()).join('|'),
      // the LANES row is still in the markup (a kit in ⌗ Roll would otherwise
      // have no lane editor anywhere), merely gated off on a synth
      laneRow: rows.filter((r) => /v2-lanerow/.test(r.className)).length,
    };
    window.__toContent(); await wait(220);
    return o;
  });

  // …AND INTO ▦ PATTERN, through the button in the drawing's own chrome —
  // one press, driven with a real touch.
  await page.evaluate(() => {
    // the fold is module state (VIZOFF), invisible to a config restore, and it
    // hides the whole head with the grid — unfold through its own control
    const vt = document.querySelector('.v2-layer .v2-partviz .v2-viztog');
    if (vt && !vt.classList.contains('on')) vt.click();
  });
  await zz(250);
  const toPat = await tap('.v2-layer .v2-formbtn');
  await zz(420);
  // THE BODY'S GRID. `.v2-cells` is on both builders, so the probe is scoped to
  // `.v2-partsteps` — and the cells are CHUNKED 8-per-row under 540px, so it
  // reads every block rather than one container's children (the documented
  // pairing fix; a probe that asks the first block answers for half the grid).
  const gridOf = () => page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const p = (_masterEng.getCfg().layers || [])[0].part;
    const wrap = card.querySelector('.v2-partsteps');
    if (!wrap) return { missing: 'no ▦ Pattern surface', form: p.form || 'roll' };
    const cells = [...wrap.querySelectorAll('.v2-stepsgrid .v2-cell')];
    if (!cells.length) return { missing: 'no cells', form: p.form || 'roll' };
    const c = cells[0].getBoundingClientRect();
    const rg = wrap.querySelector('.v2-regen');
    return {
      form: p.form || 'roll',
      shown: getComputedStyle(wrap).display !== 'none' && c.height > 0,
      dom: cells.map((x) => (x.classList.contains('on') ? 1 : 0)).join(''),
      // What the ENGINE will play. A cell tap toggles one cell's class in place
      // (a rebuild would detach the cell under the finger), so the DOM alone
      // cannot tell a correct edit from one that silently rewrote the rest of
      // the row — the two have to be compared. In ▦ Pattern the store IS
      // `r.cells` whatever `kind` says (`viewCells`), which is the whole reason
      // this form has no second source to disagree with.
      model: (p.rhythm.cells || []).join(''),
      modelShown: (p.rhythm.cells || []).slice(0, cells.length).join(''),
      kind: p.rhythm.kind,
      selValue: (card.querySelector('[data-f="part.rhythm.kind"]') || {}).value,
      // SCOPED TO ONE SELECT — the Generated panel carries a second copy of
      // this field, and an unscoped sweep returned the list TWICE and read as
      // extra modes (the two-copies trap, on the probe side).
      opts: (() => { const s0 = card.querySelector('[data-f="part.rhythm.kind"]');
        return s0 ? [...s0.options].map((o) => o.value).join(',') : ''; })(),
      cells: cells.length, steps: p.rhythm.steps, blocks: wrap.querySelectorAll('.v2-stepblock').length,
      cellH: Math.round(c.height), cellW: Math.round(c.width),
      regen: !!rg && getComputedStyle(rg).display !== 'none',
      hint: (wrap.querySelector('.v2-stepslab') || {}).textContent || '',
    };
  });
  let g = await gridOf();
  ok('the pattern grid has ONE home — ✦ Generate ▸ Method carries no second copy of it',
    paneGrid.tabOn && paneGrid.cells === 0 && !/cells:ON/.test(paneGrid.rows) &&
    paneGrid.laneRow === 1 && /Drawn steps/.test(paneGrid.labs) && !/Pattern/.test(paneGrid.labs) &&
    !toPat && g.shown && /1/.test(g.dom),
    JSON.stringify({ pane: paneGrid, toPat, body: g }));
  // RESTATED 2026-09-09: 'ground' JOINED the options — without it a Groundwork
  // part's select rendered BLANK (value matched nothing) and invited the pick
  // that drifted the rules to Pulse. 'drawn' stays internal, which is what
  // "no extra mode" was pinning.
  ok('the grid is visible on EUCLID, with no extra mode to find (drawn stays internal; ground is a real choice)',
    g.shown && g.opts === 'pulse,euclid,chance,ground', JSON.stringify(g));
  // Generated, not blank: the knobs ARE the pattern until you touch a cell —
  // ▦ Pattern is SEEDED from them on the way in, which is what makes the grid
  // and the rules one material rather than two.
  ok('euclid draws its generated pattern (not blank)',
    /1/.test(g.dom) && g.kind === 'euclid' && g.dom === g.modelShown, JSON.stringify(g));
  ok('the grid meets the touch floor', g.cellH >= 28, 'cell ' + g.cellW + 'x' + g.cellH);
  // RESTATED with the move: the body's readout says whose the pattern is ("from
  // the rules" until you touch it) and what a tap does. The pane hint it
  // replaces said the same two things about the grid that is gone.
  ok('the grid says the knobs own it',
    /from the rules/.test(g.hint) && /tap a step to toggle it/.test(g.hint), g.hint);

  // A TAP EDITS EXACTLY THE CELL IT LANDS ON, and the store follows the picture.
  const before = g.dom;
  e = await tap('.v2-layer .v2-partsteps .v2-cell:nth-child(2)');
  g = await gridOf();
  const flipped = before.split('').filter((c, i) => c !== g.modelShown[i]).length;
  // Compared against the MODEL, not the DOM: an in-place toggle only restyles
  // the cell it touched, so an edit that silently rewrote the rest of the row
  // would look right on screen while the engine plays something else.
  ok('tapping a cell edits exactly it, keeping the generated pattern',
    !e && flipped === 1 && g.dom === g.modelShown,
    e || (before + ' -> model ' + g.modelShown + ' dom ' + g.dom));
  // RESTATED 2026-09-15 (the old-CONTRACT fork). This pinned "the first edit
  // becomes an override" — a ROLL-form rule, where a tap snapshots the formula
  // and stamps `kind = 'drawn'`. In ▦ Pattern the grid IS the material and was
  // seeded on the way in, so there is nothing to snapshot, and stamping the
  // kind would reach across and change the ROLL's own rhythm — which the two
  // forms being PARALLEL forbids. The claim is the same one, pointed the other
  // way: the edit lands in the cells and nowhere else.
  ok('a ▦ Pattern edit writes the grid and does NOT restamp the ROLL’s rule',
    g.kind === 'euclid' && g.selValue === 'euclid' && g.dom === g.modelShown,
    JSON.stringify(g));

  // A STRUCTURAL REBUILD must not lose the edit or mislabel the rhythm.
  await tap('.v2-layer .ambient-toggle');
  await tap('.v2-layer .ambient-toggle');
  g = await gridOf();
  ok('an edited pattern survives a card rebuild, still labelled Pattern',
    g.form === 'steps' && g.selValue === 'euclid' && g.shown && g.dom === g.modelShown,
    JSON.stringify(g));

  // ---- DOOR 2b: THE HAND-DRAWN ROLL'S OWN EDITOR --------------------------
  // `rhythm.kind === 'drawn'` is what a Roll-form grid edit leaves behind, and
  // it is the ONE case the pane's grid still serves: the cells are what the
  // emitter plays (`onsetsOf` takes one branch for `kind === 'drawn'` and for
  // ▦ Pattern alike), so without this row a project carrying one would have no
  // way to see or unpick it. Seeded through the STORE, deliberately — the only
  // other door into `drawn` is a tap on this very grid, so driving it through
  // the UI would be circular.
  const paneGridOf = () => page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const g0 = card.querySelector('.v2-cells');           // ⌗ Roll: the pane's is the only one
    const p = (_masterEng.getCfg().layers || [])[0].part;
    if (!g0) return { missing: true };
    const row = g0.closest('.ambient-ctrl') || g0.parentElement;
    const c = g0.children[0].getBoundingClientRect();
    const rg = row.querySelector('.v2-regen');
    return {
      shown: !!row && getComputedStyle(row).display !== 'none',
      lab: ((row.querySelector('label') || {}).textContent || '').replace(/[↻]/g, '').trim(),
      dom: [...g0.children].map((x) => (x.classList.contains('on') ? 1 : 0)).join(''),
      model: (p.rhythm.kind === 'drawn' ? (p.rhythm.cells || [])
              : window._v2.euclidCells(p.rhythm.pulses, p.rhythm.steps, p.rhythm.rotate)).join(''),
      // THE VISIBLE PREFIX. `cells` is ONE array serving two length authorities
      // — the roll's `r.steps` knob and ▦ Pattern's derived bars × grid — and it
      // keeps the LONGER so neither form can truncate the other's pattern, so
      // the stored array can be longer than the grid draws.
      modelShown: (p.rhythm.cells || []).slice(0, p.rhythm.steps | 0).join(''),
      kind: p.rhythm.kind, cells: g0.children.length, steps: p.rhythm.steps,
      cellH: Math.round(c.height), cellW: Math.round(c.width),
      regen: !!rg && getComputedStyle(rg).display !== 'none',
      hint: (row.querySelector('.v2-cellhint') || {}).textContent || '',
    };
  });
  // back to ⌗ Roll, and hand the part a drawn grid
  const backToRoll = await tap('.v2-layer .v2-formbtn');
  await zz(420);
  const drawnSeed = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L0 = (E.getCfg().layers || [])[0];
    L0.part.rhythm = { kind: 'euclid', pulses: 3, steps: 16, rotate: 0 };
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(260);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    window.__sec('Generate'); await wait(300);
    const t = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (t) t.click(); await wait(240);
    const row = () => document.querySelector('.v2-secpop .v2-cellrow:not(.v2-lanerow)');
    const o = { form: L0.part.form || 'roll',
                euclidRow: !!row() && getComputedStyle(row()).display !== 'none' };
    // …now make it a drawn one, exactly as a Roll-form cell tap leaves it
    L0.part.rhythm.cells = window._v2.euclidCells(3, 16, 0);
    L0.part.rhythm.kind = 'drawn'; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    window.__sec('Generate'); await wait(300);
    const t2 = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (t2) t2.click(); await wait(240);
    o.drawnRow = !!row() && getComputedStyle(row()).display !== 'none';
    return o;
  });
  g = await paneGridOf();
  // BOTH DIRECTIONS — the row appears for the one rule it edits and is gone for
  // the other, which is the whole difference between an editor and a preview.
  ok('a hand-drawn Roll keeps its editor — ✦ Method ▸ Drawn steps, and a generated one has none',
    !backToRoll && drawnSeed.form === 'roll' && !drawnSeed.euclidRow && drawnSeed.drawnRow &&
    g.shown && g.lab === 'Drawn steps' && g.kind === 'drawn' && g.dom === g.modelShown,
    JSON.stringify({ seed: drawnSeed, grid: g }));
  ok('↻ is offered on a hand-drawn grid, and the hint says the knobs will redraw it',
    g.regen && /edited/.test(g.hint), JSON.stringify(g));

  // ↻ is the way BACK — the only one, which is why it is a control and not a mode.
  const wasFormula = await page.evaluate(() => {
    const p = (_masterEng.getCfg().layers || [])[0].part;
    return (window._v2.euclidCells(p.rhythm.pulses, p.rhythm.steps, p.rhythm.rotate) || []).join('');
  });
  e = await tap('.v2-layer .v2-secpop .v2-cellrow:not(.v2-lanerow) .v2-cell:nth-child(2)');
  g = await paneGridOf();
  const edited = g.dom;
  e = e || await tap('.v2-layer .v2-secpop .v2-regen');
  g = await paneGridOf();
  ok('↻ restores the generated pattern',
    !e && g.kind === 'euclid' && g.model === wasFormula && edited !== wasFormula && !g.shown,
    e || JSON.stringify({ edited, formula: wasFormula, g }));

  // THE KNOBS OWN AN EDITED GRID — v1's own contract, so the two editors behave
  // alike, and the hint under the grid says so (a silent wipe of drawn cells is
  // exactly what gets reported as data loss).
  //
  // THE KNOBS ARE THE ⚙ PANEL'S NOW (2026-09-15) — ✦ Method's copies of them
  // were duplicates and went. So the probe walks the path a user does: Method,
  // ⚙ Generate, turn the knob in the panel, close it, look at the grid. The
  // claim is untouched; only the hand that reaches the knob moved.
  const reDrawn = async () => page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L0 = (E.getCfg().layers || [])[0];
    L0.part.rhythm.kind = 'drawn'; E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(260);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    window.__sec('Generate'); await wait(300);
    const t = [...document.querySelectorAll('.v2-secpop .v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (t) t.click(); await wait(240);
  });
  // …and TURN ONE, in the panel, through its own door. Returns what it found so
  // a missing knob reads as a named failure rather than a null dereference.
  const genKnob = (field, value) => page.evaluate(async (f, v) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const card = () => document.querySelector('.v2-layer');
    if (!card().classList.contains('v2-genopen')) {
      window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(320);
    }
    const o = { opened: card().classList.contains('v2-genopen') };
    let el = card().querySelector('.v2-shapepop .v2-genrows [data-f="' + f + '"]');
    // a knob on another Fine-tune tab, or inside ⚠ Advanced: recipe, is
    // reached by pressing that tab / fold (RESTATED 2026-09-17: was one fold)
    if (el && el.getBoundingClientRect().height === 0) {
      const row = el.closest('.ambient-ctrl');
      const ftk = row && [...row.classList].find((k) => /^v2-ft-/.test(k));
      if (ftk) { const tb = card().querySelector('.v2-shapepop .v2-fttab[data-ft="' + ftk.slice(6) + '"]'); if (tb) { tb.click(); await wait(200); } }
      if (row && row.classList.contains('v2-sub-recipe') && !card().classList.contains('v2-so-recipe')) {
        const fb = card().querySelector('.v2-shapepop .v2-discbtn[data-disc="recipe"]'); if (fb) { fb.click(); await wait(200); } }
      el = card().querySelector('.v2-shapepop .v2-genrows [data-f="' + f + '"]');
    }
    o.found = !!el;
    o.visible = !!el && el.getBoundingClientRect().height > 0;
    if (el) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(320);
    // the commit may have re-rendered the card; the panel survives it (GENPOP
    // is module state re-applied on render), so close it by its own ✕
    if (card().classList.contains('v2-so-recipe')) {
      const fb = card().querySelector('.v2-shapepop .v2-discbtn[data-disc="recipe"]'); if (fb) fb.click();
    }
    const gc = document.querySelector('.v2-layer .v2-shapepop .v2-gendone');
    if (gc) gc.click();
    await wait(240);
    return o;
  }, field, value);
  await reDrawn();
  const kPulses = await genKnob('part.rhythm.pulses', 5);
  g = await paneGridOf();
  ok('Pulses redraws the grid live',
    kPulses.opened && kPulses.visible && g.dom.split('1').length - 1 === 5,
    JSON.stringify({ knob: kPulses, g }));

  await reDrawn();
  const kSteps = await genKnob('part.rhythm.steps', 12);
  g = await paneGridOf();
  ok('Steps resizes the grid (model and DOM agree)',
    kSteps.opened && kSteps.visible &&
    g.steps === 12 && g.cells === 12 && g.dom.length === 12,
    JSON.stringify({ knob: kSteps, g }));

  // An edit then a knob nudge: the knob wins and says so (v1's contract).
  await reDrawn();
  await tap('.v2-layer .v2-secpop .v2-cellrow:not(.v2-lanerow) .v2-cell:nth-child(1)');
  const kRot = await genKnob('part.rhythm.rotate', 2);
  g = await paneGridOf();
  ok('a knob nudge takes an edited grid back to the formula',
    kRot.opened && kRot.visible && g.kind === 'euclid' && !g.regen,
    JSON.stringify({ knob: kRot, g }));
  await page.evaluate(() => { window.__toContent(); });
  await zz(200);

  // ---- DOOR 3: A TAKE FROM THE BANK ---------------------------------------
  // The second surface the user named. Phrases are composed in a layer's ✎ Grid
  // and saved to `savedSequences`; v2 needs a reader, not an editor of its own.
  // RESTATED TWICE, and the second restatement RETIRES the door. First ♪ Phrase
  // opened a PICKER over the same list the tab draws; then it became a signpost
  // that merely navigated there. Both were one list wearing two words ("do we
  // need both Phrases and Phrase"), and both filed the bank under WRITTEN —
  // which it is not, since a GENERATED roll banks as readily as a drawn phrase.
  // So the Material row carries no phrase door at all, and the tab is BANK.
  const bankTab = () => page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const row = c && c.querySelector('.v2-pop-pane .v2-bankrow');
    if (!row || !row.getBoundingClientRect().height) return null;
    return { tab: (c.querySelector('.v2-pop-tab.on') || {}).getAttribute('data-tab'),
             items: [...row.querySelectorAll('.v2-bankit .v2-bkload')].map((b) => b.textContent.trim()),
             empty: (row.querySelector('.ambient-hint') || {}).textContent || '',
             pickers: document.querySelectorAll('.ambient-addpop-ov').length };
  });
  // THE DOOR IS GONE — pinned by ABSENCE, in the view the user has open, since
  // "we removed it" is exactly the kind of claim that quietly regresses.
  const goneRun = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const row = c.querySelector('.v2-notesrow');
    return { adopt: c.querySelectorAll('.v2-adopt').length,
             written: [...(row ? row.querySelectorAll('.v2-matgrp') : [])]
               .map((g) => [...g.querySelectorAll('.ambient-seg')].map((b) =>
                 (b.childNodes[0] || {}).textContent.trim()).join('+')).join(' | '),
             sayPhrase: [...c.querySelectorAll('.ambient-seg')]
               .filter((b) => /^\u266a Phrase$/.test((b.childNodes[0] || {}).textContent.trim())).length };
  });
  ok('the Method row carries NO phrase door — the Bank tab is the one home',
    // ✨ Quick then ⚙ Deep since 2026-09-16 (were ⚙ Generate · ✨ Auto)
    goneRun.adopt === 0 && goneRun.sayPhrase === 0 && /^✨ Quick\+⚙ Deep$/.test(goneRun.written),
    JSON.stringify(goneRun));
  // …and the bank is reachable from the strip, as its own collapsed chip.
  const toBank = () => page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    window.__sec('Bank');
    await wait(300);
    const t = [...document.querySelectorAll('.v2-pop-tabs [data-tab]')]
      .find((x) => x.getAttribute('data-tab') === 'Bank');
    if (!t) return false; t.click(); return true;
  });
  ok('Bank is its own section button, and it opens the one list', await toBank());
  await zz(400);
  let pop = await bankTab();
  // An empty bank is not an error — it is a "here is where these come from",
  // and it must name BOTH origins now that it is not filed under Written.
  ok('the Bank tab opens the one list — no second picker',
    !!pop && pop.tab === 'Bank' && pop.pickers === 0, JSON.stringify(pop));
  ok('an empty bank names the DOOR that fills it, and both origins',
    pop && !pop.items.length && /New take/.test(pop.empty) &&
    /Save it to the bank/.test(pop.empty) && /compose/.test(pop.empty) &&
    /generated or written/i.test(pop.empty), JSON.stringify(pop));

  // THE PREMISE, MEASURED: a GENERATED take can be banked, and doing so does NOT
  // freeze the part. 💾 once rendered only on a written one, so the only route
  // was 🔒 Lock first — i.e. "keep this" also meant "and stop generating", which
  // is a different decision — and since 2026-09-18 it is not a button at all but
  // the first answer 🎲 New take offers. The banked notes come from the same
  // helper 🔒 uses, so what lands is what Lock would have written; the press
  // then rolls, which is what makes the gate worth having on a live part.
  const bankGen = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const svPrompt = window.prompt, svConfirm = window.confirm;
    window.prompt = () => 'genTake'; window.confirm = () => true;
    L().part.kind = 'live'; L().part.notes = []; E.getCfg();
    const h0 = document.getElementById('bloom-v2-layers'); if (h0) h0._sig = '';
    window._v2.render(E); await wait(240);
    card().classList.remove('collapsed');
    const o = { kindBefore: L().part.kind };
    try {
      const back = [...card().querySelectorAll('.v2-pop-tabs [data-tab]')]
        .find((x) => x.getAttribute('data-tab') === 'Method');
      if (back) back.click(); await wait(200);
      const b = card().querySelector('.v2-newtake');
      // REACHABLE, not merely present — a 0×0 rect is the tell
      o.button = !!b && b.getBoundingClientRect().height > 0 && !!b.offsetParent;
      o.noOldButton = !card().querySelector('.v2-savetake');
      o.gate = await window.__gate(b, 'save'); await wait(500);
      const ent = savedSequences.find((x) => x && x.name === 'genTake');
      o.banked = !!ent;
      o.notes = ent ? (ent.steps || []).filter((x) => x && (x.freq != null || x.chord)).length : 0;
      o.kindAfter = L().part.kind;
      o.stillGenerating = (L().part.notes || []).length === 0;
    } catch (e2) { o.err = String(e2 && e2.message || e2); }
    // ALWAYS restore — a stub left installed masks a MISSING prompt later on.
    window.prompt = svPrompt; window.confirm = svConfirm;
    try { savedSequences = savedSequences.filter((x) => !x || x.name !== 'genTake');
          if (typeof persistSaved === 'function') persistSaved(); } catch (e3) {}
    return o;
  });
  ok('a GENERATED take banks from the dice’s own gate, and the part keeps generating',
    bankGen.button && bankGen.noOldButton && bankGen.gate === 'ok' &&
    bankGen.banked && bankGen.notes > 0 &&
    bankGen.kindBefore === 'live' && bankGen.kindAfter === 'live' && bankGen.stillGenerating,
    JSON.stringify(bankGen));

  // Seed the bank the way the app does — a phrase with a rest and a chord step,
  // both of which have to survive the trip: a rest contributes TIME and no note,
  // and a chord step carries `chord:[{freq}]` instead of a single `freq`.
  await page.evaluate(() => {
    savedSequences.push({ name: 'gateRiff', kind: 'phrase', bpm: 120, subdivision: 0.5, steps: [
      { freq: 261.63, label: 'C4', cellIndex: 0, duration: 1, subdivision: 0.5 },
      { freq: null, label: '—', cellIndex: null, duration: 1, subdivision: 0.5 },
      { freq: null, label: 'chord', cellIndex: null, duration: 2, subdivision: 0.5,
        chord: [{ freq: 392, label: 'G4' }, { freq: 493.88, label: 'B4' }] },
    ] });
    const h2 = document.getElementById('bloom-v2-layers'); if (h2) h2._sig = '';
    window._v2.render(_masterEng);
  });
  await zz(300);
  await page.evaluate(() => { document.querySelector('.v2-layer').classList.remove('collapsed'); });
  await toBank();
  await zz(400);
  pop = await bankTab();
  ok('the bank lists the phrase with its length',
    pop && pop.items.some((b) => /gateRiff/.test(b)), JSON.stringify(pop));
  // PUT SOMETHING ON THE PART WORTH LOSING, so the load's keep-gate is
  // deterministic rather than dependent on whatever the case above left
  // generating. No re-render — the open pane holds the row being tapped.
  await page.evaluate(() => {
    const E = _masterEng, L = () => window.__Lv2(E);
    L().part.kind = 'recorded'; L().part.made = 'take';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.25 }, { t: 0.5, midi: 64, dur: 0.25 }];
    E.getCfg();
  });
  const chosen = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.v2-layer .v2-pop-pane .v2-bankit .v2-bkload')]
      .find((x) => /gateRiff/.test(x.textContent));
    if (!b) return null; b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (chosen) { await page.touchscreen.tap(chosen.x, chosen.y); await zz(500); }
  // LOADING IS A REPLACE (2026-09-18), so the bank asks the same question the
  // dice asks — keep what is here, or lose it — and it must NAME the phrase
  // being loaded, or the two answers are indistinguishable. Answered by
  // discarding: everything below is about what LANDS on the part.
  const bkGate = await page.evaluate(async () => {
    const pop2 = document.querySelector('.ambient-addpop');
    if (!pop2) return 'nogate';
    const ttl = (pop2.querySelector('.sm-title') || {}).textContent || '';
    const b2 = [...pop2.querySelectorAll('.addpop-btn')]
      .find((x) => /what is here is gone/.test(x.textContent));
    if (!b2) return 'noanswer';
    b2.click(); await new Promise((r) => setTimeout(r, 20));
    return /gateRiff/.test(ttl) ? 'ok' : ('unnamed:' + ttl);
  });
  await zz(500);
  ok('loading from the bank asks before it replaces, and names the phrase',
    bkGate === 'ok', String(bkGate));
  const adopted = await page.evaluate(() => {
    const p = (_masterEng.getCfg().layers || [])[0].part;
    return { kind: p.kind, notes: (p.notes || []).length, bars: p.bars, from: p.from || null,
             midi: (p.notes || []).map((n) => n.midi).join(','),
             at: (p.notes || []).map((n) => Math.round(n.t * 1000) / 1000).join(','),
             liveSpec: (p.rhythm && p.rhythm.kind) || '',
             cells: ((p.rhythm && p.rhythm.cells) || []).length,
             readout: (document.querySelector('.v2-layer .v2-notecount') || {}).textContent || '' };
  });
  ok('adopting makes it recorded, at the PHRASE\'s own length',
    adopted.kind === 'recorded' && adopted.bars === 0.5, JSON.stringify(adopted));
  // The rest occupies its beat and contributes no note; the chord contributes two.
  ok('rests keep their time and a chord step imports every note',
    adopted.notes === 3 && adopted.midi === '60,67,71' && adopted.at === '0,0.5,0.5',
    JSON.stringify(adopted));
  ok('the card names where the notes came from', /gateRiff/.test(adopted.readout), adopted.readout);
  // Provenance must not cost the door back: the live spec is still there.
  // NOT pinned to 'drawn' — the pattern grid is now the euclid option's own
  // surface, and a knob nudge above legitimately took it back to the formula.
  // What matters is that a rhythm spec (and its grid) survived at all.
  ok('the live spec survives adoption (Release still works)',
    /^(pulse|euclid|drawn|chance)$/.test(adopted.liveSpec) && adopted.cells > 0,
    JSON.stringify({ liveSpec: adopted.liveSpec, cells: adopted.cells }));

  // ---- THE DRAWING IS A PIANO-ROLL EDITOR --------------------------------
  // Drag a note to move it, drag its right edge to resize it, and — in ✎ Draw
  // — tap empty space to add one. All three snap to `part.grid`, a note VALUE
  // per bar: it used to be `rhythm.steps` across the WHOLE cycle, which on a
  // 5-bar part put the editing grid at 1.25 beats.
  const rollSet = async () => page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, h = document.getElementById('bloom-v2-layers');
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'recorded'; L.part.bars = 2; delete L.part.grid;
    L.part.notes = [{ t: 0, midi: 60, dur: 0.125 }, { t: 0.5, midi: 64, dur: 0.125 }];
    E.getCfg();
    const c0 = document.querySelector('.v2-layer'); if (c0) c0.classList.remove('collapsed');
    if (h) h._sig = ''; window._v2.render(E); await wait(380);
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const g = (window.__toContent(), null);
    if (g) { g.click(); await wait(300); }
    const cv = c.querySelector('.v2-vizcv');
    cv.scrollIntoView({ block: 'center' });
    return !!cv.getBoundingClientRect().width;
  });
  // WHERE THE FIRST NOTE IS, in page coordinates, plus the grid cell in px —
  // re-read every time, because a commit redraws and the geometry follows the
  // notes' own range.
  const noteAt = () => page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect();
    const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
    if (!hb) return null;
    const L = (_masterEng.getCfg().layers || [])[0];
    return { mid: { x: r.left + hb.x + hb.w / 2, y: r.top + hb.y + 3 },
             edge: { x: r.left + hb.x + hb.w - 2, y: r.top + hb.y + 3 },
             rowH: cv._pitchGeo.rowH,
             cellPx: cv._plotGeo.w / window._v2.gridCells(L) };
  });
  const partNotes = () => page.evaluate(() =>
    (_masterEng.getCfg().layers || [])[0].part.notes.slice()
      .sort((a, b) => a.t - b.t).map((n) => [n.t, n.midi, n.dur]));
  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
    await page.mouse.up();
    await zz(450);
  };
  // …and a PITCH drag. The drawing does NOT grow for the gesture any more —
  // one geometry, always (the stated contract) — and the value is the TOTAL
  // displacement from the press, so the target is measured from `from.y`
  // itself: the arm move is part of the travel, not a rebase point.
  const dragPitch = async (from, dx, semis) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - 8);          // past the 5px threshold: arm
    const rowH = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      return (cv && cv._pitchGeo) ? cv._pitchGeo.rowH : 0;
    });
    // +0.35 rows: the DETENT engages 0.85 past a row boundary (k =
    // ceil(raw − 0.85), the anti-wobble hysteresis), so a target of
    // semis + 0.35 rows sits mid-band for k = semis with half a row of
    // margin either side
    await page.mouse.move(from.x + dx, from.y - (semis + 0.35) * rowH, { steps: 8 });
    await page.mouse.up();
    await zz(450);
    return rowH;
  };
  await rollSet();
  let np = await noteAt();
  const rollBefore = await partNotes();
  const edOpen = () => page.evaluate(() => {
    const o = document.querySelector('.v2-layer .v2-neinline');
    return !!o && !o.hidden;
  });
  const edBefore = await edOpen();
  // DRAG BY A NON-MULTIPLE OF THE CELL. Dragging exactly two cells lands on
  // two cells with or without snapping, so the first version of this check
  // passed its own poison — the asserting-on-something-that-works-regardless
  // trap. 2.4 cells can only read as 2 if it was rounded.
  //
  // RESTATED 2026-09-08 with the reason: ONE GESTURE IS ONE AXIS now. The old
  // check dragged time AND pitch in a single diagonal gesture, which is
  // exactly the coupling reported as the defect ("moving a note vertically
  // and horizontally should be totally independent"). A horizontal drag moves
  // TIME only — 1.35 rows of deliberate vertical drift ride along and must
  // move NOTHING vertically (without the axis lock, the 0.85-row detent flips
  // a row at that drift, so this discriminates); a vertical drag moves PITCH
  // only, with 0.7 cells of horizontal drift that would snap a whole cell.
  await drag(np.mid, np.cellPx * 2.4, -1.35 * np.rowH);
  const movedT = await partNotes();
  ok('a horizontal drag moves the note in TIME only, snapped — vertical drift moves nothing',
    // a 2-bar part at 1/16 = 32 cells, so two cells is 1/16 of the cycle
    movedT[0][0] === 0.0625 && movedT[0][1] === rollBefore[0][1] &&
    movedT[0][2] === rollBefore[0][2] && movedT[1].join() === rollBefore[1].join(),
    JSON.stringify({ before: rollBefore, after: movedT }));
  np = await noteAt();
  const dragRowH = await dragPitch(np.mid, np.cellPx * 0.7, 3);
  const moved = await partNotes();
  ok('a vertical drag moves the note in PITCH only — horizontal drift moves nothing',
    moved[0][0] === movedT[0][0] && moved[0][1] === rollBefore[0][1] + 3 &&
    moved[0][2] === rollBefore[0][2] && moved[1].join() === rollBefore[1].join(),
    JSON.stringify({ before: movedT, after: moved, idleRowH: np.rowH, dragRowH }));
  // …and the row did NOT grow for the gesture. INVERTED 2026-09-08 with the
  // reason: the grow-for-editing design (rows to 10/12px on grab, absorbing
  // scroll, shrink on release) was itself reported as the defect — "the
  // grid resizes, the note events all shift, I lose my bearings". One
  // geometry, always: the drawn row IS the drag resolution on a mouse
  // (total-displacement math, one half-step per row), and a finger gets a
  // 9px gain floor instead of a resize.
  ok('the drawing is IDENTICAL while a note is held — nothing grows for the gesture',
    Math.abs(dragRowH - np.rowH) < 0.01,
    JSON.stringify({ idle: np.rowH, dragging: dragRowH }));
  // …and a DRAG is not also a click: letting go must not toggle the editor.
  ok('a drag does not also open or close the note editor',
    (await edOpen()) === edBefore, JSON.stringify({ before: edBefore }));

  // THE AXIS MUST NOT MOVE UNDER THE FINGER. The pitch window follows the
  // notes' OWN range, so dragging one moves the very thing that defines it —
  // measured on a C4–C6 part, `loM` walked 59 → 71 and the canvas collapsed
  // 181px → 109px while the note's VALUE tracked the finger perfectly.
  // Reported as "hops around skipping notes": the number was right and the
  // PICTURE was moving. Sampled DURING the gesture, which is the only place
  // this is visible — before and after both look fine.
  const axisRun = await (async () => {
    await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
      const E = _masterEng, h = document.getElementById('bloom-v2-layers');
      const L = (E.getCfg().layers || [])[0];
      // a WIDE range, so the window has room to walk if it is going to
      L.part.kind = 'recorded'; L.part.bars = 2;
      L.part.notes = [{ t: 0, midi: 60, dur: 0.125 }, { t: 0.25, midi: 72, dur: 0.125 },
                      { t: 0.5, midi: 84, dur: 0.125 }];
      E.getCfg();
      const c0 = document.querySelector('.v2-layer'); c0.classList.remove('collapsed');
      if (h) h._sig = ''; window._v2.render(E); await wait(380);
      const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
      const g = (window.__toContent(), null);
      if (g) { g.click(); await wait(300); }
      c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
    });
    const st = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const r = cv.getBoundingClientRect();
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      const pg = cv._pitchGeo;
      const n = (_masterEng.getCfg().layers || [])[0].part.notes
        .slice().sort((a, b) => a.t - b.t)[0];
      return { x: r.left + hb.x + hb.w / 2, y: r.top + hb.y + 3, rowH: pg.rowH,
               noteY: Math.round(r.top + pg.top + (pg.hiM - n.midi) * pg.rowH + pg.rowH / 2) };
    });
    await page.mouse.move(st.x, st.y);
    await page.mouse.down();
    await page.mouse.move(st.x, st.y - 7);            // past the threshold: arm (7px sits mid-detent at the 5.15px row)
    const held = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const r = cv.getBoundingClientRect();
      const n = (_masterEng.getCfg().layers || [])[0].part.notes
        .slice().sort((a, b) => a.t - b.t)[0];
      const pg = cv._pitchGeo;
      return { rowH: pg.rowH,
               noteY: Math.round(r.top + pg.top + (pg.hiM - n.midi) * pg.rowH + pg.rowH / 2) };
    });
    const seen = [];
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(st.x, st.y - 7 - i * held.rowH, { steps: 1 });
      await zz(60);
      seen.push(await page.evaluate(() => {
        const cv = document.querySelector('.v2-layer .v2-vizcv');
        const pg = cv._pitchGeo, n = (_masterEng.getCfg().layers || [])[0]
          .part.notes.slice().sort((a, b) => a.t - b.t)[0];
        return { axis: pg.loM + '..' + pg.hiM + '@' + Math.round(pg.rowH * 100) +
                       'h' + Math.round(cv.getBoundingClientRect().height), midi: n.midi };
      }));
    }
    await page.mouse.up();
    await zz(350);
    // …and the RELEASE re-tightens nothing: the window is STICKY (it may
    // only widen, for the life of the material), so letting go of a dragged
    // extremal note must not resize or re-scale the drawing — "the grid
    // should never resize before, during or AFTER" is the stated contract.
    const after = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const pg = cv._pitchGeo;
      return pg.loM + '..' + pg.hiM + '@' + Math.round(pg.rowH * 100) +
             'h' + Math.round(cv.getBoundingClientRect().height);
    });
    const steps = seen.map((x) => x.midi);
    return { after,
             axes: [...new Set(seen.map((x) => x.axis))],
             deltas: steps.slice(1).map((v, i) => v - steps[i]),
             grabJump: Math.abs((held.noteY - (st.y - 7)) - (st.noteY - st.y)),
             heldRowH: Math.round(held.rowH * 100) / 100, idleRowH: Math.round(st.rowH * 100) / 100 };
  })();
  ok('the pitch axis is FROZEN while a note is dragged — it cannot re-scale under the finger',
    axisRun.axes.length === 1 && axisRun.deltas.length === 7 &&
    axisRun.deltas.every((d) => d === 1),
    JSON.stringify(axisRun));
  // …and the GRAB changes nothing about the drawing: same row height as
  // idle (the grow-and-absorb dance this replaces was itself the reported
  // defect — every other note shifting the moment one was held).
  ok('the grab changes NOTHING — the drawing at hold is the drawing at rest',
    Math.abs(axisRun.heldRowH - axisRun.idleRowH) < 0.01,
    JSON.stringify(axisRun));
  ok('the RELEASE changes nothing either — the sticky window never re-tightens',
    axisRun.axes.length === 1 && axisRun.after === axisRun.axes[0],
    JSON.stringify({ during: axisRun.axes, after: axisRun.after }));

  // ---- HAND WOBBLE MUST NOT FLICKER THE NOTE ------------------------------
  // Plain round() flips at every half-row boundary, so ±2px of jitter at a
  // 5-6px row bounced the note between two rows — reported as "still skips
  // around vertically when trying to drag". The drag runs through a DETENT
  // (k = ceil(raw − 0.85)); what matters is the GAP between adjacent
  // thresholds (0.7 rows ≈ 4px), which is what absorbs the jitter. The
  // drive: park mid-band, jitter ±2px, the value must not move once.
  const wobbleRun = await (async () => {
    await rollSet();
    const np8 = await noteAt();
    await page.mouse.move(np8.mid.x, np8.mid.y);
    await page.mouse.down();
    await page.mouse.move(np8.mid.x, np8.mid.y - 7);              // arm
    const base = np8.mid.y - 2.35 * np8.rowH;                     // mid-band, k=2
    await page.mouse.move(np8.mid.x, base, { steps: 2 });
    await zz(80);
    const seen8 = [];
    for (let j = 0; j < 6; j++) {
      await page.mouse.move(np8.mid.x, base + (j % 2 ? 2 : -2));
      await zz(40);
      seen8.push(await page.evaluate(() =>
        (_masterEng.getCfg().layers || [])[0].part.notes
          .slice().sort((a, b) => a.t - b.t)[0].midi));
    }
    await page.mouse.up();
    await zz(300);
    return { vals: seen8 };
  })();
  ok('±2px of hand wobble at a row boundary moves NOTHING — the detent holds',
    new Set(wobbleRun.vals).size === 1, JSON.stringify(wobbleRun));
  await rollSet();

  // ---- A HARMONY-REMAPPED PART: THE HAND WINS -----------------------------
  // A take locked under a progression DEFAULTS to harmony 'chordlock', which
  // remaps stored pitches into the sounding chord — stored ≠ drawn, so the
  // gutter mark (stored) sat rows from the block (drawn) and a semitone drag
  // stuck-then-jumped between chord tones (field report, with a screenshot).
  // Two contracts: the mark resolves from the DRAWN note (`nidx`), and a
  // hand-drag PINS the note (`n.hx`) to exactly the pitch under the hand.
  const chordlockRun = await (async () => {
    const sv = await page.evaluate(() => {
      const E = _masterEng, cfg = E.getCfg();
      const L = (cfg.layers || [])[0];
      const keep = { prog: JSON.stringify(cfg.prog || null), harmony: L.harmony || null };
      cfg.prog = { on: true, chords: [
        { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
        { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }] };
      L.harmony = 'chordlock';
      L.part.key = { root: 0, scale: 'major' };
      L.part.notes = [{ t: 0, midi: 62, dur: 0.125 }, { t: 0.5, midi: 65, dur: 0.125 }];
      E.getCfg();
      const h = document.getElementById('bloom-v2-layers');
      h._sig = ''; window._v2.render(E);
      return keep;
    });
    await zz(400);
    await page.evaluate(async () => {
      const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
      const g = (window.__toContent(), null);
      if (g) { g.click(); }
      await new Promise((r) => setTimeout(r, Math.round(300 * (window.__WS || 1))));
      c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
    });
    await zz(250);
    const o9 = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const L = (_masterEng.getCfg().layers || [])[0];
      const stored = L.part.notes.slice().sort((a, b) => a.t - b.t).map((n) => n.midi);
      const drawn = (cv._hits || []).slice().sort((a, b) => a.t - b.t)
        .map((hb) => Math.round(hb.midi));
      const r = cv.getBoundingClientRect();
      const hb0 = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      return { stored, drawn, x: r.left + hb0.x + hb0.w / 2, y: r.top + hb0.y + 3,
               rowH: cv._pitchGeo.rowH };
    });
    // drag the first note up two detents
    await page.mouse.move(o9.x, o9.y);
    await page.mouse.down();
    await page.mouse.move(o9.x, o9.y - 7);
    await zz(60);
    await page.mouse.move(o9.x, o9.y - 2.35 * o9.rowH, { steps: 2 });
    await zz(80);
    const held9 = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const L = (_masterEng.getCfg().layers || [])[0];
      const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[0];
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      return { hx: !!n.hx, stored: n.midi, drawn: Math.round(hb.midi) };
    });
    await page.mouse.up();
    await zz(400);
    const end9 = await page.evaluate(() => {
      const L = (_masterEng.getCfg().layers || [])[0];
      const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[0];
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      return { hx: !!n.hx, stored: n.midi, drawn: Math.round(hb.midi) };
    });
    await page.evaluate((keep) => {
      const E = _masterEng, cfg = E.getCfg();
      const L = (cfg.layers || [])[0];
      const pr = JSON.parse(keep.prog);
      if (pr) cfg.prog = pr; else delete cfg.prog;
      if (keep.harmony) L.harmony = keep.harmony; else delete L.harmony;
      E.getCfg();
    }, sv);
    return { remaps: o9.stored.join() !== o9.drawn.join(),
             held: held9, end: end9, drawn0: o9.drawn[0] };
  })();
  ok('chordlock: a hand-drag PINS the note — it moves with the hand and stays where dropped',
    chordlockRun.remaps && chordlockRun.held.hx &&
    chordlockRun.held.stored === chordlockRun.held.drawn &&
    chordlockRun.end.stored === chordlockRun.end.drawn &&
    chordlockRun.end.drawn === chordlockRun.drawn0 + 2,
    JSON.stringify(chordlockRun));

  // ---- TIME AND PITCH ARE INDEPENDENT IN THE EDITOR TOO, AND ± NEVER
  // RESIZES (2026-09-08, user: "moving a note past a bar boundary shifts it
  // up or down towards the nearest note; the +/- buttons should not resize").
  // Two contracts: (1) ± Position across a chord change must not move the
  // note's SOUNDING pitch — the chordlock remap is a function of the note's
  // own onset, so an unpinned time move re-voiced it into the new chord's
  // tones; the pos edit pins now, the drag's own rule. (2) ± Note walking a
  // note past the window's edge must not change the canvas height — the held
  // window SHIFTS at a constant row count (the axis scrolls), never grows.
  const indepRun = await (async () => {
    const sv = await page.evaluate(() => {
      const E = _masterEng, cfg = E.getCfg();
      const L = (cfg.layers || [])[0];
      const keep = { prog: JSON.stringify(cfg.prog || null), harmony: L.harmony || null,
                     take: L.part.take, key: JSON.stringify(L.part.key || null) };
      cfg.prog = { on: true, chords: [
        { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }] };
      L.harmony = 'chordlock';
      L.part.kind = 'recorded'; L.part.bars = 2;
      L.part.take = 77;                   // a fresh window sig — no stale hold
      L.part.key = { root: 0, scale: 'major' };
      // one note ONE CELL shy of the bar line (32 cells over 2 bars → cell
      // 15), stored OFF the chord tones so the remap genuinely moves it
      L.part.notes = [{ t: 15 / 32, midi: 62, dur: 0.03125 },
                      { t: 0.75, midi: 65, dur: 0.03125 }];
      E.getCfg();
      const h = document.getElementById('bloom-v2-layers');
      h._sig = ''; window._v2.render(E);
      return keep;
    });
    await zz(400);
    await page.evaluate(async () => {
      const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
      const g = (window.__toContent(), null);
      if (g) g.click();
      await new Promise((r) => setTimeout(r, Math.round(300 * (window.__WS || 1))));
      c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
    });
    await zz(250);
    const t0 = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const r = cv.getBoundingClientRect();
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      return { x: r.left + hb.x + hb.w / 2, y: r.top + hb.y + 3,
               drawn: Math.round(hb.midi) };
    });
    await page.mouse.click(t0.x, t0.y);                 // open the editor
    await zz(450);
    const press = (sf) => page.evaluate((sf) => {
      const inp = document.querySelector('.v2-layer .v2-neinline .ambient-step-inp[data-sf="' + sf + '"]');
      const b = inp && inp.closest('.ambient-ctrl').querySelector('.ambient-step-up');
      if (b) b.click(); return !!b;
    }, sf);
    await press('pos');                                  // across the bar line
    await zz(350);
    const crossed = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const L = (_masterEng.getCfg().layers || [])[0];
      const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[0];
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      return { t: n.t, hx: !!n.hx, drawn: hb ? Math.round(hb.midi) : null };
    });
    // …then walk ± Note upward past the window's edge: height must hold
    const hts = [];
    for (let i = 0; i < 8; i++) {
      await press('midi');
      await zz(250);
      hts.push(await page.evaluate(() => {
        const cv = document.querySelector('.v2-layer .v2-vizcv');
        const L = (_masterEng.getCfg().layers || [])[0];
        const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[0];
        const pg = cv._pitchGeo;
        return { h: Math.round(cv.getBoundingClientRect().height),
                 stored: n.midi, win: pg.loM + '..' + pg.hiM };
      }));
    }
    await page.evaluate(() => {                          // close the editor
      const b = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
      if (b) b.click();
    });
    await zz(250);
    await page.evaluate((keep) => {
      const E = _masterEng, cfg = E.getCfg();
      const L = (cfg.layers || [])[0];
      const pr = JSON.parse(keep.prog);
      if (pr) cfg.prog = pr; else delete cfg.prog;
      if (keep.harmony) L.harmony = keep.harmony; else delete L.harmony;
      // the take and the written key are FIXTURE, not subject — a leaked
      // take draws a different roll for every later live-part probe (the
      // one-page-one-state trap, again)
      if (keep.take != null) L.part.take = keep.take; else delete L.part.take;
      const pk = JSON.parse(keep.key);
      if (pk) L.part.key = pk; else delete L.part.key;
      E.getCfg();
    }, sv);
    return { drawn0: t0.drawn, crossed, hts };
  })();
  ok('± Position across a chord change moves the note in TIME only — the pin holds its pitch',
    Math.abs(indepRun.crossed.t - 0.5) < 1e-9 && indepRun.crossed.hx &&
    indepRun.crossed.drawn === indepRun.drawn0,
    JSON.stringify({ drawn0: indepRun.drawn0, crossed: indepRun.crossed }));
  ok('± Note past the window edge never changes the canvas height — the axis scrolls, it does not grow',
    indepRun.hts.length === 8 &&
    indepRun.hts.every((s) => s.h === indepRun.hts[0].h) &&
    indepRun.hts.every((s, i) => i === 0 || s.stored - indepRun.hts[i - 1].stored === 1) &&
    indepRun.hts[7].win !== indepRun.hts[0].win,        // it DID cross the edge
    JSON.stringify(indepRun.hts));
  await rollSet();
  await rollSet();

  // ---- A PRESS IS NOT A GESTURE: the page must not move until one exists --
  // Growing the rows + the absorbing scroll used to run on the bare
  // pointerdown, so a plain TAP was a grow → shrink → grow-again (the
  // editor opening) — measured 503px of scroll for one tap, reported as
  // "clicking into the visualizer is jittery and the screen jumps". The
  // growth arms at 5px of travel now; a press that never travels changes
  // NOTHING. Sampled DURING the hold, which is the only place this shows.
  const pressRun = await (async () => {
    const np2 = await noteAt();
    const before = await page.evaluate(() => ({
      scroll: Math.round((document.scrollingElement || document.documentElement).scrollTop),
      cvH: Math.round(document.querySelector('.v2-layer .v2-vizcv').getBoundingClientRect().height) }));
    await page.mouse.move(np2.mid.x, np2.mid.y);
    await page.mouse.down();
    await zz(150);
    const held = await page.evaluate(() => ({
      scroll: Math.round((document.scrollingElement || document.documentElement).scrollTop),
      cvH: Math.round(document.querySelector('.v2-layer .v2-vizcv').getBoundingClientRect().height) }));
    await page.mouse.up();
    await zz(450);
    // …and the release opens the editor with a BOUNDED reveal: the editor is
    // taller than a phone viewport, so `scrollIntoView(nearest)` aligned its
    // top and threw the DRAWING off the screen — the note you tapped has to
    // stay visible, because seeing it move is the inline editor's whole point.
    const after = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const r = cv.getBoundingClientRect();
      const vh = window.innerHeight || 780;
      return { scroll: Math.round((document.scrollingElement || document.documentElement).scrollTop),
               cvOnScreen: r.bottom > 40 && r.top < vh - 40,
               edOpen: !!document.querySelector('.v2-layer .v2-neinline:not([hidden])') };
    });
    return { before, held, after };
  })();
  ok('a bare press on a note moves NOTHING — no scroll, no resize, until the drag arms',
    pressRun.held.scroll === pressRun.before.scroll && pressRun.held.cvH === pressRun.before.cvH,
    JSON.stringify(pressRun));
  ok('tapping a note opens the editor WITHOUT throwing the drawing off the screen',
    pressRun.after.edOpen && pressRun.after.cvOnScreen &&
    Math.abs(pressRun.after.scroll - pressRun.before.scroll) <= 220,
    JSON.stringify(pressRun));
  // close the editor the way a finger would — tapping the note again toggles
  await (async () => {
    const np3 = await noteAt();
    if (np3) { await page.mouse.click(np3.mid.x, np3.mid.y); await zz(400); }
  })();
  await rollSet();

  // ---- NATIVE PAN MUST NOT STEAL A TOUCH DRAG -----------------------------
  // The canvas carries `touch-action: manipulation`, which allows the pan: a
  // vertical TOUCH drag also scrolled the page, the browser cancelled the
  // pointer stream ~2 rows in and the canvas slid away under the finger —
  // measured midi deltas -1,-1,0,0,0,0 with the scroll walking, reported as
  // "the note block skips around vertically". A non-passive touchmove guard
  // refuses the pan while a note gesture owns the pointer. Every other drag
  // check here uses page.mouse, which CANNOT pan — only a touch drive sees
  // this, which is how it survived every prior fix.
  const touchDragRun = await (async () => {
    const np4 = await noteAt();
    await page.touchscreen.touchStart(np4.mid.x, np4.mid.y);
    await zz(60);
    // UPWARD: the frozen window's floor sits right below this fixture's
    // lowest note, and clamping there is the stated contract — the headroom
    // is above
    await page.touchscreen.touchMove(np4.mid.x, np4.mid.y - 12);  // arm (12px = raw 1.33 at the 9px gain — mid-detent)
    await zz(90);
    const armed = await page.evaluate(() => ({
      scroll: Math.round((document.scrollingElement || document.documentElement).scrollTop),
      // a FINGER's gain is floored at 9px/semitone (a 5px row is below what
      // a fingertip can place); the handler stamps it for probes
      rowH: document.querySelector('.v2-layer .v2-vizcv')._dragGain ||
            document.querySelector('.v2-layer .v2-vizcv')._pitchGeo.rowH }));
    const seen = [];
    for (let i = 1; i <= 4; i++) {
      await page.touchscreen.touchMove(np4.mid.x, np4.mid.y - 12 - i * armed.rowH);
      await zz(80);
      seen.push(await page.evaluate(() => ({
        scroll: Math.round((document.scrollingElement || document.documentElement).scrollTop),
        midi: (_masterEng.getCfg().layers || [])[0].part.notes
          .slice().sort((a, b) => a.t - b.t)[0].midi })));
    }
    await page.touchscreen.touchEnd();
    await zz(450);
    const ms2 = seen.map((x) => x.midi);
    return { armedScroll: armed.scroll, scrolls: seen.map((x) => x.scroll),
             deltas: ms2.slice(1).map((v, i) => v - ms2[i]),
             firstDown: ms2[0] };
  })();
  ok('a TOUCH drag keeps the gesture — the page does not pan away under the finger',
    touchDragRun.scrolls.every((v) => v === touchDragRun.armedScroll) &&
    touchDragRun.deltas.length === 3 && touchDragRun.deltas.every((d) => d === 1),
    JSON.stringify(touchDragRun));
  await rollSet();

  // ---- THE PANEL IS SOMETIMES ITS OWN SCROLLER ----------------------------
  // `#mix-view` carries `overflow-y: auto`, so in some flex states the Bloom
  // panel scrolls INSIDE it and the document never moves. Scrolls the v2 card
  // makes resolve the NEAREST scrollable ancestor (`scrollerOf`). The drag no
  // longer scrolls at all (one geometry, nothing to absorb), so the gate for
  // `scrollerOf` is the EDITOR REVEAL: with the editor below the container's
  // visible band, opening it must scroll the CONTAINER — pointed at the
  // document it scrolls the page and the editor stays clipped, since moving
  // the pinned container does not move its content past its own edge. (The
  // RENDER restore in this regime is deliberately NOT gated: the rebuild is
  // one atomic innerHTML swap, so headless never sees the container clamp —
  // two shapes of that check passed their own poison, the documented
  // non-discrimination.)
  const revealRun = await (async () => {
    await page.evaluate(() => {
      const mv = document.getElementById('mix-view');
      mv.__sv = mv.getAttribute('style') || '';
      mv.style.setProperty('height', '500px', 'important');
      mv.style.setProperty('flex', '0 0 500px', 'important');
      mv.style.setProperty('overflow-y', 'auto', 'important');
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      // the canvas at the band's END: visible, with the editor's slot below
      // the container's bottom edge
      if (cv) cv.scrollIntoView({ block: 'end' });
    });
    await zz(250);
    // IN-PAGE dispatched clicks, coords computed in the SAME evaluate — the
    // pin/unpin reflows the page, and a real mouse.click at coords measured
    // one evaluate earlier landed on the panel's ⤓ Capture button and left
    // its MENU open over everything (the documented menu-left-open trap,
    // manufactured by this very check's first shape: every later canvas
    // interaction died and the harness wedged on the overlay).
    await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const r = cv.getBoundingClientRect();
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: r.left + hb.x + hb.w / 2, clientY: r.top + hb.y + 3 }));
    });
    await zz(500);
    const o6 = await page.evaluate(() => {
      const mv = document.getElementById('mix-view');
      const mr = mv.getBoundingClientRect();
      const ed = document.querySelector('.v2-layer .v2-neinline:not([hidden])');
      const er = ed ? ed.getBoundingClientRect() : null;
      const out = { edOpen: !!ed,
                    edTop: er ? Math.round(er.top) : null,
                    bandBot: Math.round(mr.bottom),
                    mvScroll: Math.round(mv.scrollTop) };
      mv.setAttribute('style', mv.__sv); delete mv.__sv;
      return out;
    });
    // close the editor again (tapping the note toggles) — in-page, same reason
    await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      if (hb) cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: r.left + hb.x + hb.w / 2, clientY: r.top + hb.y + 3 }));
    });
    await zz(350);
    return o6;
  })();
  ok('opening the editor reveals it INSIDE the panel when the panel is the scroller',
    revealRun.edOpen && revealRun.edTop != null &&
    revealRun.edTop <= revealRun.bandBot - 40,
    JSON.stringify(revealRun));
  // the pin/unpin clamps the DOCUMENT scroll to 0 as a side effect — without
  // a reset the next checks' note coords sit behind the app's fixed footer
  // and every canvas interaction silently lands on it (measured: the edge
  // drag hit `mix-bloom-io-btn` and did nothing)
  await rollSet();

  // RE-READ THE BASELINE. The axis check above resets the part, so the notes
  // `moved` recorded are gone — comparing against a stale snapshot measured a
  // correct resize as a failure.
  const szBefore = await partNotes();
  np = await noteAt();
  await drag(np.edge, np.cellPx * 3.4, 0);
  const sized = await partNotes();
  ok('dragging a note\u2019s right edge resizes it, and moves nothing else',
    Math.abs(sized[0][2] - (szBefore[0][2] + 0.09375)) < 1e-9 &&
    sized[0][0] === szBefore[0][0] && sized[0][1] === szBefore[0][1],
    JSON.stringify({ before: szBefore, after: sized }));

  // A TAP IS NOT A DRAG — below the threshold the gesture falls through to the
  // click handler, which opens the editor. Without that separation letting go
  // after a move would also toggle the editor (the tab-reorder lesson).
  np = await noteAt();
  await page.mouse.click(np.mid.x, np.mid.y);
  await zz(420);
  const tapped = await page.evaluate(() => {
    const o = document.querySelector('.v2-layer .v2-neinline');
    return { open: !!o && !o.hidden,
             notes: (_masterEng.getCfg().layers || [])[0].part.notes.slice()
               .sort((a, b) => a.t - b.t).map((n) => [n.t, n.midi, n.dur]) };
  });
  ok('a TAP on a note still opens its editor and moves nothing',
    tapped.open && JSON.stringify(tapped.notes) === JSON.stringify(sized),
    JSON.stringify(tapped));

  // ---- HOTKEYS ON THE OPEN NOTE: ⇧ arrows move, ⌥ ←/→ resize --------------
  // ⇧ replaced ⌃ as the primary chord (⌃←/→ is the macOS Spaces shortcut, so
  // the browser never saw half the pairs — reported as "arrow keys are not
  // working"); ⌃ survives as an alias and the return path drives it. Routed
  // through `neApply` (a fourth door to the same fields, never a fifth
  // implementation), so pin/sounding-space/persist come along. The editor is
  // open on the tapped note from the check above.
  const hotkeyRun = await (async () => {
    const before = await page.evaluate(() => {
      const o = document.querySelector('.v2-layer .v2-neinline');
      const idx = o && !o.hidden ? o._idx : -1;
      const L = (_masterEng.getCfg().layers || [])[0];
      const n = L.part.notes[idx];
      const g = window._v2.gridCells(L);
      return n ? { idx, t: n.t, midi: n.midi, dur: n.dur, cells: g } : null;
    });
    if (!before) return { before: null };
    const chord = async (mod, key) => {
      await page.keyboard.down(mod); await page.keyboard.press(key);
      await page.keyboard.up(mod); await zz(200);
    };
    await chord('Shift', 'ArrowUp');
    await chord('Shift', 'ArrowRight');
    await chord('Alt', 'ArrowRight');
    const after = await page.evaluate(() => {
      const o = document.querySelector('.v2-layer .v2-neinline');
      const idx = o && !o.hidden ? o._idx : -1;
      const L = (_masterEng.getCfg().layers || [])[0];
      const n = L.part.notes[idx];
      return n ? { t: n.t, midi: n.midi, dur: n.dur } : null;
    });
    // put it back so downstream checks keep their fixture
    await chord('Alt', 'ArrowLeft');
    await chord('Control', 'ArrowLeft');
    await chord('Control', 'ArrowDown');
    return { before, after };
  })();
  ok('⇧↑/⇧→ move the open note and ⌥→ resizes it — one cell or half-step per press (⌃ returns it: the alias)',
    hotkeyRun.before && hotkeyRun.after &&
    hotkeyRun.after.midi === hotkeyRun.before.midi + 1 &&
    Math.abs(hotkeyRun.after.t - (hotkeyRun.before.t + 1 / hotkeyRun.before.cells)) < 1e-9 &&
    Math.abs(hotkeyRun.after.dur - (hotkeyRun.before.dur + 1 / hotkeyRun.before.cells)) < 1e-9,
    JSON.stringify(hotkeyRun));

  // ---- THE READOUT MUST NEVER RESIZE THE STEPPER (2026-09-08, user: "the
  // position readout is still causing the Position buttons to resize").
  // `.ambient-ctrl` is `84px 1fr auto` — an `auto` readout column is sized by
  // its TEXT, so "beat 4.75" → "bar 2 · beat 1" re-flowed the 1fr stepper and
  // moved the + button under the finger on the very press that changed it.
  // The editor's stepper rows fix the readout column; this drives Position
  // ACROSS the bar line (the readout's biggest length jump) and pins the ±
  // buttons' rects byte-identical throughout.
  const stepGeoRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    L().part.kind = 'recorded'; L().part.bars = 2; delete L().part.grid;
    L().part.notes = [{ t: 0.45, midi: 67, dur: 0.05 }];  // one press shy of bar 2
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const g = (window.__toContent(), null);
    if (g) { g.click(); await wait(300); }
    const cv = c.querySelector('.v2-vizcv'); cv.scrollIntoView({ block: 'center' }); await wait(150);
    // the hotkey check leaves an editor OPEN, and `neSync` re-opens it on this
    // fixture's note — so the tap below would be a SECOND tap on an open note,
    // which closes it by design. Close first, then tap to open.
    const dn0 = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (dn0) { dn0.click(); await wait(200); }
    const r = cv.getBoundingClientRect(), hb = (cv._hits || [])[0];
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + hb.x + hb.w / 2, clientY: r.top + hb.y + 3 }));
    await wait(400);
    const rectOf = () => {
      const inp = document.querySelector('.v2-layer .v2-neinline .ambient-step-inp[data-sf="pos"]');
      if (!inp) return null;
      const row = inp.closest('.ambient-ctrl');
      const ru = row.querySelector('.ambient-step-up').getBoundingClientRect();
      const rd = row.querySelector('.ambient-step-dn').getBoundingClientRect();
      // THE READOUT IS THE FIELD NOW (2026-09-12) — the name moved in and the
      // translating column went with it, so the text whose length jumps is
      // `inp.value`. Same contract, read where the text actually lives.
      return { up: [Math.round(ru.left), Math.round(ru.width)],
               dn: [Math.round(rd.left), Math.round(rd.width)],
               txt: inp.value || '' };
    };
    const frames = [rectOf()];
    for (let i = 0; i < 4; i++) {
      const inp = document.querySelector('.v2-layer .v2-neinline .ambient-step-inp[data-sf="pos"]');
      const up = inp && inp.closest('.ambient-ctrl').querySelector('.ambient-step-up');
      if (up) up.click();
      await wait(200);
      frames.push(rectOf());
    }
    // close + restore
    const dn = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (dn) dn.click(); await wait(200);
    try { L().part = JSON.parse(sv); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(200);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return frames;
  });
  ok('the Position readout crossing the bar line never moves or resizes the ± buttons',
    stepGeoRun.every((f) => f && JSON.stringify(f.up) === JSON.stringify(stepGeoRun[0].up) &&
                             JSON.stringify(f.dn) === JSON.stringify(stepGeoRun[0].dn)) &&
    // …and the readout really did make its length jump (or this pins nothing)
    stepGeoRun.some((f) => /bar 2/.test(f.txt)) && stepGeoRun.some((f) => !/bar 2/.test(f.txt)),
    JSON.stringify(stepGeoRun));

  // ---- A NOTE BELONGS TO THE REGION ITS ONSET IS IN, AND IS NEVER CLIPPED
  // (2026-09-12, asked as "how does partial re-rolling work if a note starts
  // before its beginning and/or after its end — i.e. passes through the piece
  // being edited"). Two rules, and they are the whole answer:
  //   · OWNERSHIP IS BY ONSET. A note that starts BEFORE the region and rings
  //     through it is not re-rolled and not truncated — it is the previous
  //     stretch's note and it goes on sounding across the new material.
  //   · LENGTH IS NEVER CLIPPED at a region edge, in either direction. A note
  //     that starts inside and rings past the end is replaced, and its
  //     replacement may overhang the same way.
  // Both paths are driven, because they are two implementations of the rule:
  // the LIVE composite (which decides which roll a note comes from) and the
  // RECORDED splice (which decides which stored notes are kept).
  const crossRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const sv = JSON.stringify(L().part);
    const o = {};
    try {
      const p2 = L().part;
      p2.kind = 'recorded'; p2.bars = 4; p2.made = 'take';
      delete p2.takeb; delete p2.ruleb; delete p2.tf;
      p2.rhythm = { kind: 'pulse', n: 4, steps: 16 };
      p2.pitch = { kind: 'walk', span: 5 };
      // slots of a 4-bar cycle at 48/bar. The region under test is BAR 2 = 48..96.
      //   A 24..96  starts in bar 1, rings to the very end of bar 2  → survives
      //   B 72..144 starts INSIDE bar 2, rings into bar 3            → replaced
      //   C 120..144 sits wholly in bar 3                            → untouched
      p2.notes = [{ t: 24 / 192, midi: 60, dur: 72 / 192 },
                  { t: 72 / 192, midi: 64, dur: 72 / 192 },
                  { t: 120 / 192, midi: 67, dur: 24 / 192 }];
      E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(300);
      const c = () => document.querySelector('.v2-layer');
      c().classList.remove('collapsed');
      const g2 = (window.__toContent(), null);
      if (g2) { g2.click(); await wait(300); }
      const cv = () => c().querySelector('.v2-vizcv');
      cv().scrollIntoView({ block: 'center' }); await wait(150);
      const shot = () => (L().part.notes || []).slice()
        .sort((a, b) => a.t - b.t)
        .map((n) => Math.round(n.t * 192) + '..' + Math.round((n.t + n.dur) * 192) + ':' + n.midi);
      o.before = shot();
      // select bar 2 through the RULER, the only door
      const bg = cv()._barsGeo, cg = cv()._chordGeo;
      const r = cv().getBoundingClientRect();
      const x = (bg.x0 || 0) + ((1.5 / bg.barsF - (bg.f0 || 0)) / ((bg.vsc > 0) ? bg.vsc : 1)) * bg.w;
      cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: r.left + x, clientY: r.top + ((cg ? cg.top : 0) + cv()._pitchGeo.top) / 2 }));
      await wait(300);
      o.face = (c().querySelector('.v2-newtake') || {}).textContent.trim();
      // THE PICTURE'S OWN CLAIM about which notes a roll would replace
      o.go = (cv()._hits || []).slice().sort((a, b) => a.t - b.t)
        .map((hb) => Math.round(hb.t * 192) + (hb.go ? '=go' : '=stay'));
      // …and the roll itself, through the panel (the only door)
      window.confirm = () => true;
      c().querySelector('.v2-newtake').click(); await wait(320);
      const rb = c().querySelector('.v2-barroll'); if (rb) rb.click(); await wait(400);
      o.after = shot();
      const bc = c().querySelector('.v2-barclose'); if (bc) bc.click(); await wait(220);
      // the LIVE composite, same fixture, same region — the other implementation
      const p3 = L().part;
      p3.kind = 'live'; p3.shape = { lenRatio: 150 };   // every note overhangs its slot
      delete p3.takeb; E.getCfg();
      const live = () => {
        const L2 = L();
        const ns = window._v2.withTake(window._v2.pinOf(L2), () => window._v2.notesFor(L2,
          { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 8 })) || [];
        return ns.slice().sort((a, b) => a.at - b.at).map((n) =>
          Math.round((n.at / 8) * 192) + '..' + Math.round(((n.at + n.durMs / 1000) / 8) * 192) + ':' + Math.round(n.freq));
      };
      o.liveBefore = live();
      L().part.takeb = { '48:96': 99 }; E.getCfg();
      o.liveAfter = live();
    } catch (e) { o.err = String(e); }
    try { L().part = JSON.parse(sv); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(200);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return o;
  });
  ok('a note is owned by the region its ONSET is in — one ringing THROUGH the selection is left alone',
    !crossRun.err &&
    // the picture says which: only the note that STARTS inside is marked
    JSON.stringify(crossRun.go) === JSON.stringify(['24=stay', '72=go', '120=stay']) &&
    // …and the splice agrees: A and C come back byte-identical, LENGTHS included
    (crossRun.after || []).indexOf('24..96:60') >= 0 &&
    (crossRun.after || []).indexOf('120..144:67') >= 0 &&
    (crossRun.after || []).indexOf('72..144:64') < 0 &&
    (crossRun.before || []).length === 3,
    JSON.stringify(crossRun));
  ok('…and a LENGTH is never clipped at a region edge — the replacement may overhang too',
    !crossRun.err &&
    // the live composite: the note starting before bar 2 keeps its FULL length
    // across it, and the region's own note is free to ring past the end
    (crossRun.liveBefore || []).length > 0 &&
    (crossRun.liveAfter || []).some((x) => {
      const m = /^(\d+)\.\.(\d+):/.exec(x); return m && +m[1] < 48 && +m[2] > 48; }) &&
    (crossRun.liveAfter || []).some((x) => {
      const m = /^(\d+)\.\.(\d+):/.exec(x); return m && +m[1] >= 48 && +m[1] < 96 && +m[2] > 96; }) &&
    // every note outside the region is byte-identical to what it was
    (crossRun.liveBefore || []).filter((x) => { const st = +(/^(\d+)/.exec(x) || [])[1];
      return !(st >= 48 && st < 96); })
      .every((x) => (crossRun.liveAfter || []).indexOf(x) >= 0),
    JSON.stringify(crossRun));

  // ---- THE CHORD BAND SELECTS A CHANGE (2026-09-12, user: "should also be
  // able to click the Chord headers to select all of a chord (just like bar
  // selection but by chord instead)" — then, when it widened to whole bars:
  // "it's not working, clicking F♯m should only select the F♯m area").
  //   SELECTION IS BY REGION, NOT BY BAR. A region is a half-open range of
  // 1/48-BAR SLOTS, which is the grid every real boundary sits on, so a change
  // that runs from the middle of a bar to its end is representable EXACTLY and
  // a bar is simply `[N·48, (N+1)·48)`. The reported shape is the third case
  // here: on 0.75·0.75·0.5·2, the third change spans bars 1.5–2.0, and the
  // check pins that a roll writes the pin at slots 72:96 and moves NOTHING
  // outside them — a face naming the chord would pass with the old whole-bar
  // widening still in place, so the span is what has teeth.
  const chordSelRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const cfg = E.getCfg();
    const sv = { part: JSON.stringify(L().part), prog: JSON.stringify(cfg.prog || null) };
    const out = {};
    try {
      const run = async (cad, rollIdx) => {
        const c0 = E.getCfg();
        c0.prog = { on: true, chords: cad.map((bars, i) =>
          ({ root: [0, 2, 4, 5][i] || 0, intervals: [0, 4, 7], bars })) };
        const p2 = L().part;
        p2.kind = 'live'; p2.bars = 4; delete p2.takeb; delete p2.ruleb; delete p2.notes;
        p2.rhythm = { kind: 'pulse', n: 16, steps: 16 }; p2.pitch = { kind: 'walk', span: 3 };
        E.getCfg();
        if (h) h._sig = ''; window._v2.render(E); await wait(300);
        const c = () => document.querySelector('.v2-layer');
        c().classList.remove('collapsed');
        const g2 = (window.__toContent(), null);
        if (g2) { g2.click(); await wait(300); }
        const cv = () => c().querySelector('.v2-vizcv');
        cv().scrollIntoView({ block: 'center' }); await wait(150);
        const cg = cv()._chordGeo, bg = cv()._barsGeo;
        if (!cg || !cg.marks || !cg.marks.length) return { err: 'no chord band' };
        const tap = (f, y) => {
          const r = cv().getBoundingClientRect();
          const x = (bg.x0 || 0) + ((f - (bg.f0 || 0)) / ((bg.vsc > 0) ? bg.vsc : 1)) * bg.w;
          cv().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + x, clientY: r.top + y }));
        };
        const face = () => (c().querySelector('.v2-newtake') || {}).textContent.trim();
        // EVERY NOTE, AS A SLOT ON THE 1/48-BAR GRID — the unit the selection is
        // in, so "nothing outside the change moved" is checkable exactly
        const shot = () => {
          const L2 = L();
          const ns = window._v2.withTake(window._v2.pinOf(L2), () => window._v2.notesFor(L2,
            { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 8 })) || [];
          return ns.map((n) => Math.round((n.at / 8) * 4 * 48) + ':' + Math.round(n.freq));
        };
        const res = [];
        for (let i = 0; i < cg.marks.length; i++) {
          const m = cg.marks[i];
          tap((m.f0 + m.f1) / 2, Math.max(2, cg.top / 2)); await wait(260);
          const got = face();
          tap((m.f0 + m.f1) / 2, Math.max(2, cg.top / 2)); await wait(220);   // TOGGLE off
          res.push({ nm: m.nm, got, off: face() });
        }
        // …and ROLL one change: the pin's key is its own span, and every note
        // outside that span is byte-identical
        const mR = cg.marks[rollIdx];
        const before = shot();
        tap((mR.f0 + mR.f1) / 2, Math.max(2, cg.top / 2)); await wait(280);
        c().querySelector('.v2-newtake').click(); await wait(320);
        const rb = c().querySelector('.v2-barroll'); if (rb) rb.click(); await wait(380);
        const after = shot();
        const bc = c().querySelector('.v2-barclose'); if (bc) bc.click(); await wait(220);
        const moved = [];
        before.concat(after).forEach((x) => {
          if (before.indexOf(x) < 0 || after.indexOf(x) < 0) moved.push(+String(x).split(':')[0]); });
        const key = Object.keys(L().part.takeb || {})[0] || null;
        // clear the selection deterministically for the next fixture
        tap((mR.f0 + mR.f1) / 2, Math.max(2, cg.top / 2)); await wait(200);
        // …and the bar-number row below still picks ONE bar
        tap(2.5 / bg.barsF, (cg.top + cv()._pitchGeo.top) / 2); await wait(260);
        const barFace = face();
        tap(2.5 / bg.barsF, (cg.top + cv()._pitchGeo.top) / 2); await wait(220);
        return { res, barFace, chordTop: cg.top, pinKey: key,
                 moved: [...new Set(moved)].sort((x, y) => x - y) };
      };
      // 2·1·1 bars: the first change is TWO bars, which a bar tap can never
      // select — without it this case passes with the chord band not being a
      // handle at all (the poison proved exactly that)
      out.aligned = await run([2, 1, 1], 0);
      // the REPORTED shape: the third change runs bar 2½–3
      out.cadence = await run([0.75, 0.75, 0.5, 2], 2);
    } catch (e) { out.err = String(e); }
    try {
      const c9 = E.getCfg();
      const pr = JSON.parse(sv.prog); if (pr) c9.prog = pr; else delete c9.prog;
      L().part = JSON.parse(sv.part); E.getCfg();
      if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return out;
  });
  ok('a tap on the chord band selects that CHANGE and names it — not the bars under it',
    !chordSelRun.err && chordSelRun.aligned && !chordSelRun.aligned.err &&
    // the face names the change you pressed, whatever it spans
    JSON.stringify((chordSelRun.aligned.res || []).map((r) => r.got)) ===
      JSON.stringify(['\ud83c\udfb2 Retake C\u2026', '\ud83c\udfb2 Retake D\u2026', '\ud83c\udfb2 Retake E\u2026']) &&
    // it TOGGLES, like a bar tap
    (chordSelRun.aligned.res || []).every((r) => /New take/.test(r.off)) &&
    // a TWO-BAR change pins its whole span — slots 0..96 of a 4-bar cycle
    chordSelRun.aligned.pinKey === '0:96' &&
    // …and the numbers below it still pick ONE bar, so the two rows stay two questions
    /Retake bar 3\u2026/.test(chordSelRun.aligned.barFace || ''),
    JSON.stringify(chordSelRun.aligned));
  ok('…and a change that fills HALF a bar re-rolls exactly its own half',
    !chordSelRun.err && chordSelRun.cadence && !chordSelRun.cadence.err &&
    JSON.stringify((chordSelRun.cadence.res || []).map((r) => r.got)) ===
      JSON.stringify(['\ud83c\udfb2 Retake C\u2026', '\ud83c\udfb2 Retake D\u2026',
                      '\ud83c\udfb2 Retake E\u2026', '\ud83c\udfb2 Retake F\u2026']) &&
    // 0.75·0.75·0.5·2 → the third change is bars 1.5–2.0 = slots 72..96
    chordSelRun.cadence.pinKey === '72:96' &&
    // the reported defect, as a measurement: NOTHING outside those slots moved
    (chordSelRun.cadence.moved || []).length > 0 &&
    (chordSelRun.cadence.moved || []).every((sl) => sl >= 72 && sl < 96),
    JSON.stringify(chordSelRun.cadence));

  // ---- ONE BAR'S OWN GENERATED RULES (2026-09-12, user: "when user presses
  // Re-roll it should open a popover showing the current generated settings,
  // and user should be able to edit and apply to just that bar"). Three claims,
  // and the third is the one that regresses silently:
  //   · the press OPENS the settings rather than throwing the dice, seeded
  //     from what that bar currently generates by;
  //   · an edit is stored SPARSELY (only what differs from the part) and a
  //     value set back to the part's is DELETED, so "the part's rules" keeps
  //     one representation;
  //   · and the bar's material follows — in PLAYBACK, not only in the drawing.
  //     A per-bar TAKE is an audition pin and lives behind `withTake`; a per-bar
  //     RULE is what the bar is MADE of, so an unpinned `notesFor` (which is
  //     what the tick calls) must composite it too. Measuring only the drawn
  //     notes would pass with playback ignoring the whole feature.
  const barRuleRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const sv = JSON.stringify(L().part);
    // THE FIXTURE IS RESTORED IN A `finally`, and every control is reached
    // through a GUARD. A poison that CRASHES reports less than one red line —
    // and worse, an early throw skips the restore and takes two downstream
    // checks with it (measured: the press-rolls-immediately poison failed four
    // checks, two of them collateral). Guarded, the same poison names the
    // fault exactly: `opened: false`.
    try {
    const p0 = L().part;
    p0.kind = 'live'; p0.bars = 4; delete p0.notes; delete p0.takeb; delete p0.ruleb;
    p0.rhythm = { kind: 'euclid', steps: 16, pulses: 5, rotate: 0 };
    p0.pitch = { kind: 'walk', span: 3 };
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    const c = () => document.querySelector('.v2-layer');
    c().classList.remove('collapsed');
    const g = (window.__toContent(), null);
    if (g) { g.click(); await wait(300); }
    const cv = c().querySelector('.v2-vizcv'); cv.scrollIntoView({ block: 'center' }); await wait(150);
    // ONE NOTE COUNT PER BAR, through an UNPINNED notesFor — the tick's own call
    const perBar = () => {
      const L2 = L();
      const ns = window._v2.notesFor(L2, { E, cfg: E.getCfg(), key: 'v2:' + L2.id, cycleStart: 0, cycleSec: 8 }) || [];
      const per = [0, 0, 0, 0];
      ns.forEach((n) => { const b = Math.floor((n.at / 8) * 4 + 1e-6); if (b >= 0 && b < 4) per[b]++; });
      return per;
    };
    const o = { before: perBar() };
    // tap the RULER over bar 2 (a tap in the open plot selects nothing)
    const r = cv.getBoundingClientRect(), bg = cv._barsGeo, pg = cv._pitchGeo;
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + bg.x0 + (cv.clientWidth - bg.x0) * (1.5 / bg.vbars),
      clientY: r.top + Math.max(3, pg.top - 6) }));
    await wait(300);
    const nb = () => c().querySelector('.v2-newtake');
    o.face = nb().textContent.trim();
    // the press OPENS — it must not roll
    const takeBefore = JSON.stringify(L().part.takeb || null);
    nb().click(); await wait(350);
    o.opened = c().classList.contains('v2-baropen');
    o.title = (c().querySelector('.v2-bartitle') || {}).textContent || '';
    o.rolledOnOpen = JSON.stringify(L().part.takeb || null) !== takeBefore;
    const fld = (f) => c().querySelector('.v2-barpop [data-bf="' + f + '"]');
    const set = async (f, v) => { const e2 = fld(f); if (!e2) return false;
      e2.value = String(v); e2.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(320); return true; };
    const hit = (sel) => { const e2 = c().querySelector(sel); if (e2) e2.click(); return !!e2; };
    // SEEDED FROM THE PART, and gated to the kinds in force
    o.seed = ['rhythm.kind', 'rhythm.pulses', 'pitch.kind', 'pitch.span']
      .map((f) => f + '=' + (fld(f) ? fld(f).value : 'MISSING'));
    o.noChordRow = !fld('pitch.mix') && !fld('pitch.octaves');   // mixed / series rows
    // EDIT → stored sparsely, marked own, and the BAR's material moves
    o.setPulses = await set('rhythm.pulses', 12);
    o.stored = JSON.stringify(L().part.ruleb || null);
    o.ownMark = !!(fld('rhythm.pulses') && fld('rhythm.pulses').closest('.v2-barrow.v2-barown'));
    o.after = perBar();
    // a KIND change rebuilds the visible set
    o.setKind = await set('pitch.kind', 'chord');
    o.voicesRow = !!fld('pitch.voices');          // chord's own row appeared
    o.spanGone = !fld('pitch.span');              // walk's went
    o.afterKind = perBar();
    // back to the part's value → the override for that field is DELETED
    await set('rhythm.pulses', 5);
    o.dropped = JSON.stringify(L().part.ruleb || null);
    // ↺ the part's rules → gone entirely, and the bar is back where it started
    o.hasReset = hit('.v2-barreset'); await wait(350);
    o.reset = JSON.stringify(L().part.ruleb || null);
    o.afterReset = perBar();
    // the card SAYS a bar has its own rules — state in a closed panel has to be
    // readable from the card (the drum-solo rule)
    await set('rhythm.pulses', 12);
    o.says = ((c().querySelector('.v2-vizlab') || {}).textContent || '');
    o.hasClose = hit('.v2-barclose'); await wait(250);
    o.closed = !c().classList.contains('v2-baropen');
    // ── ↺ RESET IS A FULL RESET, AND IT REFUSES WHEN THERE IS NOTHING ────
    // (2026-09-14, user: "chord menu needs a 'reset' button, also 'Roll
    // again' should return user to the layer (close popover)").
    const reopen = async () => { const nb2 = c().querySelector('.v2-newtake');
      if (nb2) nb2.click(); await wait(360); };
    await reopen();
    o.re1 = c().classList.contains('v2-baropen');
    // …with a rule set, it is offered
    await set('rhythm.pulses', 9);
    const rstEl = () => c().querySelector('.v2-barreset');
    o.rstOn = !!(rstEl() && !rstEl().disabled);
    // 🎲 ROLL AGAIN HANDS THE CARD BACK — the panel sits over the drawing that
    // just changed, so staying open hides the only thing the press produced.
    const rl = c().querySelector('.v2-barroll'); if (rl) rl.click();
    await wait(420);
    o.rollClosed = !c().classList.contains('v2-baropen');
    o.rollPinned = !!(L().part.takeb && Object.keys(L().part.takeb).length);
    // …the bar stays SELECTED, so the door still leads back in
    await reopen();
    o.re2 = c().classList.contains('v2-baropen');
    // A RESET CLEARS THE PINNED TAKE TOO. Clearing only the rules left the
    // throw behind, so a change that had been rolled never came back to "what
    // it would be with nothing set" — the only thing a reset can mean.
    o.beforeReset = JSON.stringify([L().part.ruleb || null, L().part.takeb || null]);
    if (rstEl()) rstEl().click(); await wait(380);
    o.bothCleared = !L().part.ruleb && !L().part.takeb;
    // …and then it REFUSES, on its face, rather than doing nothing on press
    o.rstOff = !!(rstEl() && rstEl().disabled);
    o.rstTitle = rstEl() ? rstEl().title : '';
    o.rstFace = rstEl() ? rstEl().textContent.trim() : '';
    const bc2 = c().querySelector('.v2-barclose'); if (bc2) bc2.click(); await wait(220);
    return o;
    } catch (e) { return { err: String(e) }; } finally {
      try { L().part = JSON.parse(sv); E.getCfg();
            if (h) h._sig = ''; window._v2.render(E); await wait(200);
            document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    }
  });
  ok('🎲 Re-roll bar N OPENS that bar’s generated settings — it does not roll behind your back',
    !barRuleRun.err && /\u2026$/.test(barRuleRun.face) && /bar 2/i.test(barRuleRun.face) &&
    barRuleRun.opened && /bar 2/i.test(barRuleRun.title) && !barRuleRun.rolledOnOpen &&
    JSON.stringify(barRuleRun.seed) ===
      JSON.stringify(['rhythm.kind=euclid', 'rhythm.pulses=5', 'pitch.kind=walk', 'pitch.span=3']) &&
    barRuleRun.noChordRow && barRuleRun.closed,
    JSON.stringify(barRuleRun));
  ok('editing them changes THAT BAR only — in playback, stored sparsely, and back to the part’s is a delete',
    !barRuleRun.err &&
    // only bar 2 moved, and it moved in an UNPINNED notesFor (the tick's call)
    barRuleRun.after[1] !== barRuleRun.before[1] &&
    barRuleRun.after[0] === barRuleRun.before[0] &&
    barRuleRun.after[2] === barRuleRun.before[2] && barRuleRun.after[3] === barRuleRun.before[3] &&
    barRuleRun.setPulses && barRuleRun.setKind && barRuleRun.hasReset && barRuleRun.hasClose &&
    // keyed by REGION: bar 2 of a 4-bar part is slots 48..96
    barRuleRun.stored === '{"48:96":{"rhythm":{"pulses":12}}}' && barRuleRun.ownMark &&
    // a kind change rebuilds the visible set…
    barRuleRun.voicesRow && barRuleRun.spanGone && barRuleRun.afterKind[1] > barRuleRun.after[1] &&
    // …a value set back to the part's is dropped, ↺ clears the rest
    barRuleRun.dropped === '{"48:96":{"pitch":{"kind":"chord"}}}' && barRuleRun.reset === 'null' &&
    JSON.stringify(barRuleRun.afterReset) === JSON.stringify(barRuleRun.before) &&
    /own rules: bar 2/.test(barRuleRun.says),
    JSON.stringify(barRuleRun));
  ok('↺ Reset drops EVERYTHING the stretch states — rules, operations and the take rolled onto it',
    !barRuleRun.err && barRuleRun.re1 && barRuleRun.rstOn && barRuleRun.re2 &&
    /"0:48"|:\{/.test(barRuleRun.beforeReset) && /\d/.test(barRuleRun.beforeReset) &&
    barRuleRun.bothCleared &&
    // …and a press that cannot act refuses on its FACE, with the reason
    barRuleRun.rstOff && /Nothing to reset/.test(barRuleRun.rstTitle) &&
    /Reset/.test(barRuleRun.rstFace),
    JSON.stringify({ err: barRuleRun.err, re1: barRuleRun.re1, rstOn: barRuleRun.rstOn,
      re2: barRuleRun.re2, beforeReset: barRuleRun.beforeReset,
      bothCleared: barRuleRun.bothCleared, rstOff: barRuleRun.rstOff,
      rstTitle: barRuleRun.rstTitle, rstFace: barRuleRun.rstFace }));
  ok('…and 🎲 Roll again hands the card back — it closes the panel over the drawing it just changed',
    !barRuleRun.err && barRuleRun.rollClosed && barRuleRun.rollPinned && barRuleRun.re2,
    JSON.stringify({ err: barRuleRun.err, rollClosed: barRuleRun.rollClosed,
      rollPinned: barRuleRun.rollPinned, re2: barRuleRun.re2 }));

  // ---- THE FIELD NAMES ITS VALUE, AND THE ENVELOPE FOLDS (2026-09-12, user:
  // "Note/Position/Length numerical values are meaningless, should be a
  // meaningful value (for example Note should be the note and octave, e.g. A3
  // instead of 57); envelope should be expand/collapse and should be collapsed
  // by default"). Two claims, both pinned here because both regress quietly:
  // a field that goes back to showing the index still LOOKS like a control,
  // and a fold that opens by default just looks like the old editor.
  //   THE NUMBER RIDES IN `data-sv` — the shared ± delegation's opt-in — so
  // the check asserts the whole loop: the face names the value, the attribute
  // carries the number, ONE press moves the number by one AND the face
  // follows, and the stored note moved with it. A face repainted without its
  // number is the subtle failure (it reads right and steps from a stale
  // value), which is why `svAfter` is asserted beside `faceAfter`.
  //   AND A SHUT FOLD MUST SAY WHAT IT HOLDS (the drum-solo rule): its head
  // counts the envelope fields this note OWNS, so hiding five rows can never
  // hide state.
  const neFaceRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const sv = JSON.stringify(L().part);
    L().part.kind = 'recorded'; L().part.bars = 4; L().part.grid = 16;
    // 12 cells of 64 → bar 4 · beat 1, 3 beats long, pitch A3
    L().part.notes = [{ t: 0.75, midi: 57, dur: 0.1875 }];
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const g = (window.__toContent(), null);
    if (g) { g.click(); await wait(300); }
    const cv = c.querySelector('.v2-vizcv'); cv.scrollIntoView({ block: 'center' }); await wait(150);
    // a previous check can leave an editor open, and a second tap CLOSES it
    const dn0 = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (dn0) { dn0.click(); await wait(200); }
    const r = cv.getBoundingClientRect(), hb = (cv._hits || [])[0];
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + hb.x + hb.w / 2, clientY: r.top + hb.y + 3 }));
    await wait(400);
    const o = document.querySelector('.v2-layer .v2-neinline');
    if (!o || o.hidden) return { err: 'editor did not open' };
    const fld = (sf) => o.querySelector('.ambient-step-inp[data-sf="' + sf + '"]');
    const face = (sf) => { const e = fld(sf); return e ? e.value : null; };
    const svOf = (sf) => { const e = fld(sf); return e ? e.getAttribute('data-sv') : null; };
    const out = { faces: ['midi', 'pos', 'len'].map(face), svs: ['midi', 'pos', 'len'].map(svOf),
                  ro: ['midi', 'pos', 'len'].every((sf) => !!fld(sf) && fld(sf).readOnly) };
    // NOTHING may show the raw index: the readout column that used to
    // translate it is gone, so a visible bare number means the field regressed
    out.bareNums = [...o.querySelectorAll('.ambient-ctrl-step *')]
      .filter((e) => e.getBoundingClientRect().height > 0)
      .map((e) => (e.value !== undefined && e.value !== '' ? e.value : (e.children.length ? '' : e.textContent || '')).trim())
      .filter((t) => /^\d+$/.test(t));
    // ONE press: number +1, face follows, the note moved
    const up = fld('midi').closest('.ambient-ctrl').querySelector('.ambient-step-up');
    up.click(); await wait(300);
    out.faceAfter = face('midi'); out.svAfter = svOf('midi');
    out.storedAfter = L().part.notes[0].midi;
    // THE FOLD: shut at first sight, and its head says what it is holding
    const fold = () => o.querySelector('.v2-nefold');
    const env = () => o.querySelector('.v2-neenv');
    out.foldShut = !!fold() && !fold().classList.contains('open') && !!env() && env().hidden;
    out.envH0 = env() ? Math.round(env().getBoundingClientRect().height) : -1;
    out.head0 = fold() ? fold().textContent.trim() : '';
    // the ACTIONS are what a shut fold buys — measure how far they moved
    const actTop = () => Math.round(o.querySelector('.v2-nebtns').getBoundingClientRect().top);
    const a0 = actTop();
    fold().click(); await wait(250);
    out.opened = fold().classList.contains('open') && !env().hidden;
    out.envH1 = Math.round(env().getBoundingClientRect().height);
    out.actMoved = actTop() - a0;
    // a value set on THIS note must show in the head, shut or open
    const atk = o.querySelector('[data-sf="atk"]');
    atk.value = '1234'; atk.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    out.headOwn = fold().textContent.trim();
    out.ownAmber = fold().classList.contains('v2-nefold-own');
    // close + restore the fixture (including the fold, which is session state)
    fold().click(); await wait(150);
    const dn = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (dn) dn.click(); await wait(200);
    try { L().part = JSON.parse(sv); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(200);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return out;
  } catch (e) { return { err: String(e) }; } });
  ok('the Note/Position/Length fields NAME their value, and ± steps the number behind it',
    !neFaceRun.err &&
    neFaceRun.faces[0] === 'A3' && neFaceRun.faces[1] === 'bar 4 \u00b7 beat 1' &&
    neFaceRun.faces[2] === '3 beats' &&
    JSON.stringify(neFaceRun.svs) === JSON.stringify(['57', '48', '12']) &&
    neFaceRun.ro && neFaceRun.bareNums.length === 0 &&
    neFaceRun.faceAfter === 'A\u266f3' && neFaceRun.svAfter === '58' && neFaceRun.storedAfter === 58,
    JSON.stringify(neFaceRun));
  ok('the envelope is a FOLD, shut by default, and its head says what it holds',
    !neFaceRun.err && neFaceRun.foldShut && neFaceRun.envH0 === 0 &&
    /all from the layer/.test(neFaceRun.head0) &&
    neFaceRun.opened && neFaceRun.envH1 > 150 && neFaceRun.actMoved > 150 &&
    /1 set on this note/.test(neFaceRun.headOwn) && neFaceRun.ownAmber,
    JSON.stringify(neFaceRun));

  // ---- A LOCKED CHORD KEEPS ITS VOICES THROUGH CHORDLOCK (2026-09-08, user:
  // "where there's clearly a chord it sometimes only plays one note"). The
  // remap indexes written-key degrees into the sounding chord mod N, and a
  // stacked voicing's degrees COLLIDE mod N — measured: 60,64,67,71,72 over
  // F7 remapped to 65,60,65,72,77, two voices on one pitch. Colliding voices
  // now climb an octave instead: same pitch classes, five voices stay five.
  const chordVoicesRun = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    const L = (cfg.layers || [])[0];
    const sv = { part: JSON.stringify(L.part), prog: JSON.stringify(cfg.prog || null),
                 harmony: L.harmony || null };
    cfg.prog = { on: true, chords: [{ root: 5, intervals: [0, 4, 7, 10] }] };
    L.part.kind = 'recorded'; L.part.bars = 1;
    L.harmony = 'chordlock'; L.part.key = { root: 0, scale: 'major' };
    L.part.notes = [60, 64, 67, 71, 72].map((m) => ({ t: 0, midi: m, dur: 0.1 }));
    E.getCfg();
    const ns = window._v2.notesFor(L, { E, cfg: E.getCfg(), key: 'v2:' + L.id,
                                        cycleStart: 0, cycleSec: 2 }) || [];
    const freqs = ns.map((n) => Math.round(n.freq));
    const o = { n: ns.length, freqs, distinct: new Set(freqs).size };
    try {
      const pr = JSON.parse(sv.prog);
      if (pr) cfg.prog = pr; else delete cfg.prog;
      L.part = JSON.parse(sv.part);
      if (sv.harmony) L.harmony = sv.harmony; else delete L.harmony;
      E.getCfg();
    } catch (e) {}
    return o;
  });
  ok('a locked 5-voice chord under chordlock plays 5 DISTINCT pitches — the remap never collapses voices',
    chordVoicesRun.n === 5 && chordVoicesRun.distinct === 5,
    JSON.stringify(chordVoicesRun));

  // ── ONE MODE SELECT, AND ⬚ MULTI ────────────────────────────────────────
  // (2026-09-09, user: "consolidate view/draw/edit into a dropdown, add a
  // multi mode that allows selecting more than one event and resize uniformly
  // or move vertically/horizontally uniformly".) It was TWO buttons for what is
  // one axis — 👁 View/✎ Edit (which RECORD is drawn) beside ✎ Draw (what a TAP
  // does) — and three of the four combinations they offered meant the same
  // thing, since drawing implies you are working on the record you are editing.
  // UNIFORM is the whole claim: every gathered note takes the SAME delta, the
  // ungathered ones do not move, and the delta is clamped ONCE for the set (per
  // note would let the leading one stop while the rest carried on). Both doors
  // — the steppers and the drag — go through `multiApply`/the group path, so
  // the check drives BOTH.
  const multiRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    const sv = JSON.stringify(L().part);
    L().on = true; L().present = true;
    L().part.kind = 'recorded'; L().part.bars = 2; L().part.transpose = 0;
    delete L().harmony;
    L().part.notes = [{ t: 0.25, midi: 60, dur: 0.0625 },
                      { t: 0.5, midi: 64, dur: 0.0625 },
                      { t: 0.75, midi: 67, dur: 0.0625 }];
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    if (h) h._sig = ''; window._v2.render(E); await wait(300);
    card().classList.remove('collapsed');
    const o = {};
    const sel = () => card().querySelector('.v2-modepick');
    o.isSelect = !!sel() && sel().tagName === 'SELECT';
    o.opts = sel() ? [...sel().options].map((x) => x.value).join(',') : '';
    // the two buttons are GONE — "we deleted it" is the claim that regresses
    // quietly, so it is pinned by ABSENCE
    o.oldGone = !card().querySelector('.v2-vmode') && !card().querySelector('.v2-draw');
    o.gridKept = !!card().querySelector('.v2-gridpick');
    const setM = async (m) => { const s2 = sel(); s2.value = m;
      s2.dispatchEvent(new Event('input', { bubbles: true })); await wait(260); };
    await setM('draw'); o.drawTakes = window._v2.modeOf(L()) === 'draw';
    await setM('multi'); o.multiTakes = window._v2.modeOf(L()) === 'multi';
    o.barHiddenWhenEmpty = card().querySelector('.v2-multibar').hidden;
    // GATHER through the real hit boxes
    const cv = () => card().querySelector('.v2-vizcv');
    const clickNote = async (i) => {
      const b = (cv()._hits || [])[i]; if (!b) return;
      const r = cv().getBoundingClientRect();
      cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: r.left + b.x + b.w / 2, clientY: r.top + b.y + b.h / 2 }));
      await wait(210);
    };
    await clickNote(0); await clickNote(2);
    o.gathered = window._v2.multiSel(L()).slice().sort((a, b) => a - b).join(',');
    o.barShows = !card().querySelector('.v2-multibar').hidden;
    o.barSays = ((card().querySelector('.v2-multin') || {}).textContent || '').trim();
    const notes = () => (E.getCfg().layers[0].part.notes || [])
      .map((n) => (Math.round(n.t * 1000) / 1000) + '/' + n.midi + '/' + (Math.round(n.dur * 1000) / 1000));
    o.before = notes();
    const act = async (a) => { const b = card().querySelector('.v2-mact[data-ma="' + a + '"]');
      if (b) b.click(); await wait(240); };
    await act('m+1'); o.afterUp = notes();
    await act('t+1'); o.afterRight = notes();
    await act('d+1'); o.afterLong = notes();
    // …UNIFORM, and only the gathered ones
    const d = (a, b, k) => a.map((x, i) => (+b[i].split('/')[k]) - (+x.split('/')[k]));
    o.dMidi = d(o.before, o.afterUp, 1).join(',');
    o.dT = d(o.afterUp, o.afterRight, 0).map((x) => Math.round(x * 1000) / 1000).join(',');
    o.dDur = d(o.afterRight, o.afterLong, 2).map((x) => Math.round(x * 1000) / 1000).join(',');
    o.uniform = o.dMidi === '1,0,1' && o.dT === '0.031,0,0.031' && o.dDur === '0.031,0,0.031';
    o.selSurvives = window._v2.multiSel(L()).length === 2;   // re-found by identity
    // THE DRAG: grab one gathered note, both move, the third does not
    const dragBefore = notes();
    const b0 = (cv()._hits || [])[0];
    const r0 = cv().getBoundingClientRect();
    const x0 = r0.left + b0.x + b0.w / 2, y0 = r0.top + b0.y + b0.h / 2;
    const rowH = (cv()._pitchGeo || {}).rowH || 6;
    const pev = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true,
      cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' }));
    pev(cv(), 'pointerdown', x0, y0); await wait(60);
    for (let i = 1; i <= 3; i++) { pev(document, 'pointermove', x0, y0 - rowH * i * 1.05); await wait(50); }
    pev(document, 'pointerup', x0, y0 - rowH * 3 * 1.05); await wait(320);
    const dragAfter = notes();
    const dm = d(dragBefore, dragAfter, 1);
    o.dragUniform = dm[0] === dm[2] && dm[0] > 0 && dm[1] === 0;
    o.dragDelta = dm.join(',');
    // ✕ clears, and LEAVING multi drops the gathering
    await act('clear');
    o.cleared = window._v2.multiSel(L()).length === 0 && card().querySelector('.v2-multibar').hidden;
    await clickNote(0);
    await setM('edit');
    o.dropsOnLeave = window._v2.multiSel(L()).length === 0;
    await setM('view');
    try { L().part = JSON.parse(sv); E.getCfg();
          if (h) h._sig = ''; window._v2.render(E); await wait(220);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; } });
  // RESTATED 2026-09-10: ✂ Split is a fifth mode, so the list grew.
  // RESTATED AGAIN 2026-09-12, back to FOUR, and the reason is the contract
  // rather than the count: a mode changes what a TAP MEANS, and Split's tap
  // meant "open this note" — which is what Edit already does. So it was a mode
  // for a gesture that already existed, costing a switch there and a switch
  // back; it is a BUTTON in the note editor now (pinned by the split checks
  // below, which press it). Same contract otherwise — ONE control for the
  // axis, every state named on its face, and the two buttons it replaced gone.
  ok('the drawing has ONE mode select — view · edit · draw · multi — and the two buttons are gone',
    multiRun && !multiRun.err && multiRun.isSelect &&
    multiRun.opts === 'view,edit,draw,multi' && multiRun.oldGone && multiRun.gridKept &&
    multiRun.drawTakes && multiRun.multiTakes,
    JSON.stringify(multiRun));
  ok('⬚ Multi gathers notes and moves or resizes ALL of them uniformly — by stepper AND by drag',
    multiRun && !multiRun.err && multiRun.barHiddenWhenEmpty && multiRun.gathered === '0,2' &&
    multiRun.barShows && /2 notes gathered/.test(multiRun.barSays) &&
    multiRun.uniform && multiRun.selSurvives && multiRun.dragUniform &&
    multiRun.cleared && multiRun.dropsOnLeave,
    JSON.stringify(multiRun));

  // ✎ DRAW — its own mode, because a tap on empty space already selects a BAR
  // and one gesture cannot mean both.
  const drawRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const o = {};
    // RESTATED 2026-09-09: Draw is one option of the drawing's MODE select,
    // not a two-state toggle. The contract that check pinned — "the face names
    // the FEATURE, so the word Draw is visible when you are looking for the
    // mode" — is satisfied by construction here: every option's name is on
    // screen at all times, which is strictly stronger than a toggle whose face
    // named only the state it was in.
    const sel = () => document.querySelector('.v2-layer .v2-modepick');
    o.exists = !!sel();
    o.names = sel() ? [...sel().options].map((x) => x.textContent.trim()).join(' | ') : '';
    o.offLit = sel() ? sel().value === 'draw' : true;      // not in draw mode yet
    if (sel()) { sel().value = 'draw'; sel().dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(400);
    o.on = !!sel() && sel().value === 'draw';
    return o;
  });
  const addPt = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    cv.scrollIntoView({ block: 'center' });
    const r = cv.getBoundingClientRect(), pg = cv._pitchGeo, geo = cv._plotGeo;
    return { x: r.left + geo.x0 + geo.w * 0.75,
             y: r.top + pg.top + (pg.hiM - 67) * pg.rowH + pg.rowH / 2,
             before: (_masterEng.getCfg().layers || [])[0].part.notes.length };
  });
  await page.mouse.click(addPt.x, addPt.y);
  await zz(500);
  const added = await page.evaluate(() => {
    const p2 = (_masterEng.getCfg().layers || [])[0].part;
    const o = document.querySelector('.v2-layer .v2-neinline');
    // BY THE DRAWN ROW, not the stored midi — the pencil lands the note on
    // the CLICKED row exactly (shift-corrected / pinned), so under this gate
    // state's +2 transpose the stored value legitimately differs. RESTATED
    // 2026-09-08 with the reason: the old stored-space lookup pinned the
    // land-where-the-shift-says behaviour that was the bug.
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const hb = (cv._hits || []).find((x) => Math.round(x.midi) === 67);
    const n = hb ? p2.notes[hb.i] : null;
    return { count: p2.notes.length, note: n ? [n.t, Math.round(hb.midi), n.dur] : null,
             editorOpen: !!o && !o.hidden };
  });
  ok('\u270e Draw is a visible mode, and a tap on empty space adds a note ON THE CLICKED ROW',
    // RESTATED 2026-09-09 with the reason: the OFF face read "▦ Bars", so the
    // word "Draw" was invisible exactly when someone was looking for the mode
    // (asked as "where is the draw mode?"). The face names the FEATURE in both
    // states now and the purple fill (.on) is the state signal — the panel's
    // own active-mode convention.
    drawRun.exists && /Draw/.test(drawRun.names) && !drawRun.offLit &&
    /View/.test(drawRun.names) && /Multi/.test(drawRun.names) &&
    drawRun.on && added.count === addPt.before + 1 && added.note &&
    added.note[0] === 0.75 && added.note[1] === 67 && added.note[2] === 0.03125 &&
    added.editorOpen,
    JSON.stringify({ drawRun, addPt: addPt.before, added }));

  // …and with Draw OFF the same tap selects a BAR, exactly as before.
  const drawOffRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const md0 = document.querySelector('.v2-layer .v2-modepick');
    md0.value = 'view'; md0.dispatchEvent(new Event('input', { bubbles: true })); await wait(420);
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    cv.scrollIntoView({ block: 'center' });
    return { off: document.querySelector('.v2-layer .v2-modepick').value !== 'draw',
             before: (_masterEng.getCfg().layers || [])[0].part.notes.length };
  });
  await page.mouse.click(addPt.x, addPt.y);
  await zz(450);
  ok('\u2026and with Draw off the same tap selects a bar instead of adding',
    drawOffRun.off && (await page.evaluate(() =>
      (_masterEng.getCfg().layers || [])[0].part.notes.length)) === drawOffRun.before,
    JSON.stringify(drawOffRun));

  // THE GRID IS A NOTE VALUE, PER BAR — so it reads the same on a 1-bar part
  // and a 5-bar one, and the editor's own ranges follow it.
  const gridRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const sel = () => document.querySelector('.v2-layer .v2-gridpick');
    const o = { opts: [...sel().options].map((x) => x.textContent).join(',') };
    const pick = async (v) => { const s2 = sel(); s2.value = String(v);
      s2.dispatchEvent(new Event('input', { bubbles: true })); await wait(380); };
    // OPEN A NOTE FIRST — the previous check left the editor shut (its tap
    // selected a bar), and "the editor follows the grid" cannot be measured
    // against an editor that is not there.
    const cvG = document.querySelector('.v2-layer .v2-vizcv');
    cvG.scrollIntoView({ block: 'center' });
    const rG = cvG.getBoundingClientRect(), hbG = (cvG._hits || [])[0];
    if (hbG) {
      cvG.dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: rG.left + hbG.x + hbG.w / 2, clientY: rG.top + hbG.y + 3 }));
      await wait(400);
    }
    o.editorOpen = !!document.querySelector('.v2-layer .v2-neinline:not([hidden])');
    await pick(64);
    o.stored = L().part.grid; o.cells64 = window._v2.gridCells(L());
    // …the editor's Length slider is ranged in CELLS, so it has to follow
    const el = document.querySelector('.v2-layer .v2-neinline [data-sf="len"]');
    o.lenMax = el ? +el.max : -1;
    await pick(16);
    o.pruned = !('grid' in L().part);      // the default stores nothing
    o.cells16 = window._v2.gridCells(L());
    return o;
  });
  ok('the editing grid is a note value per bar, down to 1/64, and the editor follows',
    /1\/64/.test(gridRun.opts) && /1\/4/.test(gridRun.opts) && /1\/16 T/.test(gridRun.opts) &&
    gridRun.stored === 64 && gridRun.cells64 === 128 && gridRun.cells16 === 32 &&
    gridRun.pruned && gridRun.editorOpen && gridRun.lenMax === 256,
    JSON.stringify(gridRun));

  // ---- THE RULER NAMES THE CHORDS, AND A CADENCE IS NOT A BAR ------------
  // The ruler counted bars and said nothing about the harmony underneath them,
  // which is worst exactly where it matters: with a CADENCE a chord is not a
  // bar, so 2 · ½ · ½ · 1 is four changes across four bars and only the first
  // one starts where a bar count implies. Pinned on the SEGMENTS the draw
  // resolves — position AND width, in bars — because a band that merely
  // appears would pass with every chord drawn the same width.
  //
  // THE NAMES ARE THE SOUNDING ONES. `prog.chords[i]` is the SCORE: the key
  // transpose, order-perm, alts and take-reroll all resolve at read time, so
  // the written root is not what the ear hears (the fixture is written a whole
  // tone below what it sounds, and the check asserts the sounding spelling).
  const rulerRun = await page.evaluate(async () => {
    const L = () => window.__Lv2(_masterEng);
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const keep = { partFor: L().partFor, bars: L().part.bars,
      parts: L().parts ? JSON.parse(JSON.stringify(L().parts)) : null,
      partAll: L().partAll ? JSON.parse(JSON.stringify(L().partAll)) : null };
    cfg.prog.on = true;
    cfg.prog.chords = [
      { root: 10, intervals: [0, 4, 7], bars: 2 }, { root: 0, intervals: [0, 3, 7], bars: 0.5 },
      { root: 2, intervals: [0, 3, 7], bars: 0.5 }, { root: 1, intervals: [0, 4, 7], bars: 1 },
      { root: 5, intervals: [0, 4, 7] }, { root: 7, intervals: [0, 3, 7] }];
    cfg.prog.parts = [{ len: 4 }, { len: 2 }];
    E.getCfg();
    L().partFor = 0; L().part.bars = 4;
    window._v2.render(E); await zz(350);
    const cv = () => document.querySelector('.v2-layer .v2-vizcv');
    // THE BAND TAKES A ROW OF ITS OWN, so the plot starts lower — `top` is the
    // ONE definition of where it begins and every consumer reads it.
    o.top = cv() ? cv()._pitchGeo.top : null;
    // THE PICTURE'S OWN CLAIM (`cv._chordGeo`), never a re-walk of the clock
    // beside it. The first version of this check DID re-derive the anchor, and
    // it passed its own poison — a probe that recomputes what the thing under
    // test publishes proves only that the recomputation is self-consistent.
    // Segments are read back in BARS of the drawn cycle, which is the claim:
    // position AND width, so a band drawn with every chord the same width
    // fails here.
    const seg = async (pi) => {
      L().partFor = pi;
      window._v2.render(E); await zz(300);
      const c = cv(), gg = c && c._chordGeo;
      if (!gg) return '(none)';
      const bars = (c._barsGeo && c._barsGeo.barsF) || 4;
      return gg.marks.map((m) => m.nm + '@' +
        (Math.round(m.f0 * bars * 100) / 100) + '..' +
        (Math.round(m.f1 * bars * 100) / 100)).join(' ');
    };
    o.p0 = await seg(0);
    o.at0 = cv() && cv()._chordGeo ? Math.round(cv()._chordGeo.at * 1000) / 1000 : null;
    // A DIFFERENT PART STARTS SOMEWHERE ELSE. Stopped there is no clock, so
    // walking from the progression's top would draw part 1's chords under
    // part 2's notes — the anchor asks the one resolver which part it is in.
    o.p1 = await seg(1);
    // AND IT STARTS SOMEWHERE ELSE — the anchor asked which part it is in.
    o.at1 = cv() && cv()._chordGeo ? Math.round(cv()._chordGeo.at * 1000) / 1000 : null;
    L().partFor = 0;
    // PIXELS: the band is really painted, and it is CLEARED with the harmony.
    window._v2.render(E); await zz(300);
    const lit = () => {
      const c = cv(); if (!c) return -1;
      const g = c.getContext('2d');
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const px = g.getImageData(0, 0, c.width, Math.max(2, Math.round(6 * dpr))).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && (px[i] + px[i + 1] + px[i + 2]) > 30) n++;
      return n;
    };
    o.bandLit = lit();
    cfg.prog.on = false; E.getCfg();
    window._v2.render(E); await zz(300);
    o.topNoProg = cv() ? cv()._pitchGeo.top : null;
    // put EVERYTHING back — the one-page-one-state rule
    cfg.prog = P0; E.getCfg();
    L().partFor = keep.partFor; L().part.bars = keep.bars;
    if (keep.parts) L().parts = keep.parts; else delete L().parts;
    if (keep.partAll) L().partAll = keep.partAll; else delete L().partAll;
    if (!Number.isFinite(keep.partFor)) delete L().partFor;
    E.getCfg(); window._v2.render(E); await zz(250);
    return o;
  });
  ok('the ruler names the chords WHERE THEY ARE — a cadence is not a bar',
    rulerRun.top === 28 && rulerRun.topNoProg === 15 && rulerRun.bandLit > 200 &&
    rulerRun.p0 === 'C@0..2 Dm@2..2.5 Em@2.5..3 D\u266f@3..4' &&
    rulerRun.p1 !== rulerRun.p0 && /@0\.\.1 /.test(rulerRun.p1) &&
    rulerRun.at1 > rulerRun.at0 + 1e-3,
    JSON.stringify(rulerRun));

  // THE PILL SAYS WHICH PART, NOT WHICH CHORDS. A derived part name IS the
  // chord numerals, and the ruler directly below now draws those chords where
  // they actually are — so the pill spent a whole row saying the same thing
  // worse (measured: "◫ Per part · 1 · ♭VII — i — ii — ♭III — IV").
  // READ THE RENDERED PILL, and reach it THROUGH ITS OWN DOOR. The first
  // version called `_ambPartLabelShort` directly and passed its own poison —
  // pointing the control back at the long label changed nothing it could see.
  // The second set `L.partFor` by hand and read a STALE face: `V2.render` is
  // `_sig`-cached on layer identity (id:name:kind:on), so a field outside that
  // signature repaints nothing — which is exactly why the handler itself does
  // `h._sig = ''` before rendering. Press the button.
  const pillRun = await page.evaluate(async () => {
    const L = () => window.__Lv2(_masterEng);
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const oc = window.confirm;
    cfg.prog.on = true;
    cfg.prog.parts = [{ len: 1 }, { len: 1 }];
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }];
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click();
      await zz(350);
    }
    const pill = () => card() && card().querySelector('.v2-pop-pp');
    o.before = pill() ? pill().textContent.trim() : null;
    if (pill()) pill().click();                       // ▭ Everywhere → ◫ Per part
    await zz(400);
    o.derived = pill() ? pill().textContent.trim() : null;
    o.derivedW = pill() ? Math.round(pill().getBoundingClientRect().width) : 0;
    o.engaged = Number.isFinite(L().partFor);
    // an AUTHORED name is kept beside the ordinal — it identifies something
    // RESOLVE THE INDEX FIRST. `getCfg()` rebuilds `prog.parts` as a fresh
    // array, and in `cfg.prog.parts[L().partFor].name = …` the reference is
    // taken BEFORE the index expression runs — so `L()`'s own getCfg replaces
    // the array and the write lands on an orphan (the documented trap, in
    // argument-evaluation order).
    const pidx = L().partFor | 0;
    E.getCfg().prog.parts[pidx].name = 'Verse'; E.getCfg();
    const h2 = card() && card().querySelector('.v2-layer-host');
    window._v2.render(E); await zz(150);
    // (the card's own host caches on identity — the same reason as above)
    const host = document.getElementById('bloom-v2-layers');
    if (host) host._sig = '';
    window._v2.render(E); await zz(350);
    o.authored = pill() ? pill().textContent.trim() : null;
    o.tipHasFull = pill() ? (pill().getAttribute('title') || '')
      .indexOf(_ambPartLabel(E.getCfg(), L().partFor | 0)) >= 0 : false;
    // back out through the same door — the way back asks, so answer it
    window.confirm = () => true;
    if (pill()) pill().click();
    await zz(400);
    window.confirm = oc;
    o.after = pill() ? pill().textContent.trim() : null;
    cfg.prog = P0; E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('\u25eb Per part names the PART, short \u2014 a derived name drops to its ordinal',
    pillRun.engaged && pillRun.derived === '\u25eb Per part \u00b7 1' &&
    pillRun.authored === '\u25eb Per part \u00b7 1 \u00b7 Verse' && pillRun.tipHasFull &&
    pillRun.derivedW > 0 && pillRun.derivedW < 160 && /Everywhere/.test(pillRun.after || ''),
    JSON.stringify(pillRun));

  // ---- A CADENCE CHANGE MOVES THE CONTENT, AND SAYS SO -------------------
  // Content filed against a part IS that part's length: the reconciler refits
  // `part.bars` on every normalize, so lengthening a chord already STRETCHED
  // every record on that part — silently, and always the same way. Driven
  // through the real surface (the ± steppers, then Done), because the ask is
  // hung on the close and a probe that calls the modal builder proves nothing
  // about when it fires.
  const cascRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const L0 = () => (E.getCfg().layers || [])[0];
    const keep = JSON.parse(JSON.stringify({ part: L0().part, partFor: L0().partFor,
      parts: L0().parts || null, partAll: L0().partAll || null }));
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 1 }, { root: 5, intervals: [0, 4, 7], bars: 1 },
      { root: 7, intervals: [0, 4, 7], bars: 1 }, { root: 9, intervals: [0, 3, 7], bars: 1 },
      { root: 2, intervals: [0, 3, 7], bars: 1 }, { root: 4, intervals: [0, 3, 7], bars: 1 }];
    cfg.prog.parts = [{ name: 'Verse', len: 4 }, { name: 'Chorus', len: 2 }];
    E.getCfg();
    const L = L0();
    L.partFor = 0; L.part.kind = 'recorded'; L.part.bars = 4;
    L.part.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.25, midi: 62, dur: 0.1 },
      { t: 0.5, midi: 64, dur: 0.1 }, { t: 0.75, midi: 65, dur: 0.1 }];
    delete L.part.barsMode;
    E.getCfg();
    o.t0 = L0().part.notes.map((n) => n.t);
    o.bars0 = L0().part.bars;
    const cad = () => document.querySelector('.ambient-cad-modal');
    const casc = () => document.querySelector('.v2-casc-modal');
    const run = async (mode) => {
      _ambCadenceModal(E, 0); await zz(300);
      if (!cad()) return 'no cadence modal';
      // ± twice on the first chord: 1 → 1½ → 2, so the part grows by one bar
      for (let i = 0; i < 2; i++) {
        const b2 = cad().querySelector('[data-cad^="up:0"]'); if (!b2) return 'no stepper';
        b2.click(); await zz(140);
      }
      const dn = cad().querySelector('.cad-close'); if (!dn) return 'no Done';
      dn.click(); await zz(400);
      if (!casc()) return 'no ask';
      const opt = [...casc().querySelectorAll('.v2-cascopt')].find((x) => x.getAttribute('data-v') === mode);
      if (!opt) return 'no ' + mode;
      opt.click(); await zz(80);
      casc().querySelector('.v2-cascgo').click(); await zz(400);
      return null;
    };
    // FILL — the notes keep their own tempo and one more is written
    o.err = await run('fill');
    o.askText = o._t || '';
    o.barsFill = L0().part.bars;
    o.tFill = L0().part.notes.map((n) => Math.round(n.t * 1000) / 1000);
    o.modeFill = L0().part.barsMode || '';
    o.gone = !casc();
    // A ▭ EVERYWHERE LAYER IS NOT TOUCHED — its content is not for one part,
    // so cascading to it would override the statement the mode makes. Asserted
    // on this same layer with the mode off (the gate's fixture has one card):
    // the scan must file it as LOOSE and the cascade must leave its bars alone.
    const bA = L0().part.bars;
    delete L0().partFor; E.getCfg();
    const sc = window._v2.cascadeScan(E, 0);
    o.looseSeen = sc.loose.length === 1 && sc.bound.length === 0;
    window._v2.cascadeBars(E, 0, 1, 'fill');
    o.everyBars = L0().part.bars;
    o.everyKept = Math.abs(L0().part.bars - bA) < 1e-9;
    L0().partFor = 0; E.getCfg();
    // STRETCH — the notes stay exactly where they are, over the new length
    L0().part.bars = 4; delete L0().part.barsMode;
    L0().part.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.5, midi: 64, dur: 0.1 }];
    // put the cadence back so the second run has the same room to grow
    E.getCfg().prog.chords[0].bars = 1; E.getCfg();
    o.err2 = await run('stretch');
    o.barsStretch = L0().part.bars;
    o.tStretch = L0().part.notes.map((n) => Math.round(n.t * 1000) / 1000);
    // NO CHANGE, NO QUESTION. A dialog on every close is noise, and it is the
    // clause with teeth: the ask must key on the LENGTH, not on the editor
    // having been opened.
    _ambCadenceModal(E, 0); await zz(250);
    const dn2 = cad() && cad().querySelector('.cad-close'); if (dn2) dn2.click();
    await zz(400);
    o.askedOnNoChange = !!casc();
    if (casc()) casc().querySelector('.v2-cascgo').click();
    await zz(200);
    // restore EVERYTHING this probe wrote
    cfg.prog = P0; E.getCfg();
    const Lr = L0();
    Lr.part = JSON.parse(JSON.stringify(keep.part));
    if (Number.isFinite(keep.partFor)) Lr.partFor = keep.partFor; else delete Lr.partFor;
    if (keep.parts) Lr.parts = keep.parts; else delete Lr.parts;
    if (keep.partAll) Lr.partAll = keep.partAll; else delete Lr.partAll;
    E.getCfg();
    const host = document.getElementById('bloom-v2-layers');
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('a cadence change asks how the content follows — and Fill keeps its tempo',
    !cascRun.err && !cascRun.err2 && cascRun.gone &&
    cascRun.bars0 === 4 && cascRun.barsFill === 5 &&
    // four notes a bar apart become FIVE — the tempo held, one more written
    cascRun.tFill.length === 5 && cascRun.tFill.join(',') === '0,0.2,0.4,0.6,0.8' &&
    cascRun.modeFill === 'fill' &&
    // STRETCH is the default and leaves the times exactly as they are
    cascRun.barsStretch === 5 && cascRun.tStretch.join(',') === '0,0.5' &&
    // a ▭ Everywhere layer keeps its own length — that content is not for a part
    cascRun.looseSeen && cascRun.everyKept &&
    !cascRun.askedOnNoChange,
    JSON.stringify(cascRun));

  // ── PRESERVE — EACH NOTE RE-FITTED TO ITS OWN CHANGE ───────────────────
  // The third answer to "the cadence moved". Stretch scales the whole part by
  // ONE ratio, so shortening one chord shrinks every note in the part — including
  // the four whose chords never moved. Preserve maps each note through the change
  // BOUNDARIES: it keeps its place inside its own change and its length is
  // truncated or extended to that change's new span. Driven through the REAL
  // cadence modal, because the old per-change lengths are captured there (17) and
  // handed to the dialog — the one piece that can silently stop arriving.
  const presRun = await page.evaluate(async () => {
    const zz = window.__zz || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const L0 = () => (E.getCfg().layers || [])[0];
    const keep = JSON.parse(JSON.stringify({ part: L0().part, partFor: L0().partFor,
      parts: L0().parts || null, partAll: L0().partAll || null }));
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 2 },
      { root: 5, intervals: [0, 4, 7], bars: 1 }, { root: 7, intervals: [0, 4, 7], bars: 1 },
      { root: 9, intervals: [0, 3, 7], bars: 1 }];
    delete cfg.prog.parts;
    E.getCfg();
    const L = L0();
    L.partFor = 0; L.part.kind = 'recorded'; L.part.harmony = 'fixed';
    delete L.part.barsMode;
    L.part.bars = 5;
    // ONE NOTE PER CHANGE, each exactly filling its change — so "did it follow
    // its own chord" is readable straight off the numbers.
    L.part.notes = [{ t: 0, midi: 60, dur: 2 / 5 }, { t: 2 / 5, midi: 62, dur: 1 / 5 },
      { t: 3 / 5, midi: 64, dur: 1 / 5 }, { t: 4 / 5, midi: 65, dur: 1 / 5 }];
    E.getCfg();
    const inBars = () => { const b = L0().part.bars, nn = L0().part.notes || [];
      return { bars: Math.round(b * 100) / 100,
               at: nn.map((n) => Math.round(n.t * b * 100) / 100),
               dur: nn.map((n) => Math.round(n.dur * b * 100) / 100) }; };
    o.before = inBars();
    const cad = () => document.querySelector('.ambient-cad-modal');
    const casc = () => document.querySelector('.v2-casc-modal');
    // SHRINK the first change 2 → 1 bar (three ± presses: 2 → 1¾ … or one step
    // per press down the ladder), through the modal's own stepper.
    _ambCadenceModal(E, 0); await zz(300);
    if (!cad()) o.err = 'no cadence modal';
    else {
      for (let i = 0; i < 2 && !o.err; i++) {
        const b2 = cad().querySelector('[data-cad^="dn:0"]');
        if (!b2) { o.err = 'no stepper'; break; }
        b2.click(); await zz(140);
      }
      const dn = cad() && cad().querySelector('.cad-close');
      if (dn) { dn.click(); await zz(420); }
    }
    if (!o.err && !casc()) o.err = 'no ask';
    if (!o.err) {
      o.opts = [...casc().querySelectorAll('.v2-cascopt')].map((x) => x.getAttribute('data-v'));
      const opt = [...casc().querySelectorAll('.v2-cascopt')].find((x) => x.getAttribute('data-v') === 'preserve');
      if (!opt) o.err = 'no preserve option';
      else {
        opt.click(); await zz(80);
        casc().querySelector('.v2-cascgo').click(); await zz(420);
      }
    }
    o.after = inBars();
    o.mode = L0().part.barsMode || '';
    o.gone = !casc();
    // …and with NO old cadence to map through, Preserve is not offered at all —
    // a button that cannot act is the dead-control trap.
    window._v2.cascadeAsk(E, 0, 5, 4, () => {});
    await zz(160);
    o.noLensOpts = casc() ? [...casc().querySelectorAll('.v2-cascopt')].map((x) => x.getAttribute('data-v')) : null;
    if (casc()) { const ov = casc().closest('.sm-overlay'); if (ov) ov.remove(); }
    // restore EVERYTHING this probe wrote
    cfg.prog = P0; E.getCfg();
    const Lr = L0();
    Lr.part = JSON.parse(JSON.stringify(keep.part));
    if (Number.isFinite(keep.partFor)) Lr.partFor = keep.partFor; else delete Lr.partFor;
    if (keep.parts) Lr.parts = keep.parts; else delete Lr.parts;
    if (keep.partAll) Lr.partAll = keep.partAll; else delete Lr.partAll;
    E.getCfg();
    const host = document.getElementById('bloom-v2-layers');
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('Preserve re-fits each note to its OWN change — truncated or extended',
    !presRun.err && presRun.gone && presRun.mode === 'preserve' &&
    (presRun.opts || []).join(',') === 'stretch,fill,preserve' &&
    presRun.before.bars === 5 && presRun.after.bars === 4 &&
    // the SHRUNK change's note truncates to its new 1 bar…
    presRun.after.dur[0] === 1 &&
    // …and the three whose chords never moved keep their own bar and just slide
    presRun.after.dur.slice(1).join(',') === '1,1,1' &&
    presRun.after.at.join(',') === '0,1,2,3' &&
    // without the old cadence the option is absent rather than inert
    (presRun.noLensOpts || []).join(',') === 'stretch,fill',
    JSON.stringify(presRun));

  // ── FILL SURVIVES A RE-ROLL ─────────────────────────────────────────────
  // Fill was written into the NOTES and nowhere else — `applyBarsMode` grew the
  // rules only on a GENERATED part — so 🎲 Replace with a new take read the
  // retained live spec, which still described the OLD length, and handed back
  // the pre-cadence density stretched thinner. On ▬ Sustained (one onset per
  // cycle) that is a single held chord over every change: reported as "I chose
  // Fill, pressed Replace with a new take, and the new take is just 1 chord
  // when there are 5 chords in the part".
  const fillRollRun = await page.evaluate(async () => {
    const zz = window.__zz || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const L0 = () => (E.getCfg().layers || [])[0];
    const keep = JSON.parse(JSON.stringify({ part: L0().part, partFor: L0().partFor,
      parts: L0().parts || null, partAll: L0().partAll || null }));
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 2, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
      { root: 6, intervals: [0, 3, 7] }, { root: 7, intervals: [0, 4, 7] },
      { root: 9, intervals: [0, 4, 7] }];
    delete cfg.prog.parts;
    E.getCfg();
    L0().partFor = 0; delete L0().part.barsMode; E.getCfg();
    const ons = () => new Set((L0().part.notes || []).map((n) => Math.round(n.t * 1e4))).size;
    const one = (mat) => {
      cfg.prog.chords.forEach((c) => { delete c.bars; }); E.getCfg();
      if (mat === 'sustain') window._v2.makeSustain(E, L0());
      else { const r = L0().part.rhythm; r.kind = 'euclid'; r.steps = 8; r.pulses = 3; }
      delete L0().part.barsMode; E.getCfg();
      window._v2.capture(E, L0(), {}); E.getCfg();
      const prev = L0().part.bars;
      const lo = _ambCadence(E.getCfg(), 0).slice();
      cfg.prog.chords[0].bars = 2; E.getCfg();
      const ln = _ambCadence(E.getCfg(), 0).slice();
      window._v2.cascadeBars(E, 0, prev, 'fill', { old: lo, now: ln }); E.getCfg();
      const filled = ons();
      window._v2.capture(E, L0(), { reroll: true }); E.getCfg();
      return { filled, rolled: ons(), bars: L0().part.bars };
    };
    o.sustain = one('sustain');
    o.euclid = one('euclid');
    cfg.prog = P0; E.getCfg();
    const Lr = L0();
    Lr.part = JSON.parse(JSON.stringify(keep.part));
    if (Number.isFinite(keep.partFor)) Lr.partFor = keep.partFor; else delete Lr.partFor;
    if (keep.parts) Lr.parts = keep.parts; else delete Lr.parts;
    if (keep.partAll) Lr.partAll = keep.partAll; else delete Lr.partAll;
    E.getCfg();
    const host = document.getElementById('bloom-v2-layers');
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('Fill survives 🎲 Replace with a new take — the rules carry the density, not just the notes',
    // the whole report: a sustained part filled to TWO onsets must not re-roll
    // back to one held chord across the part
    fillRollRun.sustain.filled === 2 && fillRollRun.sustain.rolled === 2 &&
    fillRollRun.euclid.filled === 4 && fillRollRun.euclid.rolled === 4,
    JSON.stringify(fillRollRun));

  // AND THE PICTURE FOLLOWS, ON THE PRESS. The cadence commit deliberately
  // does NOT call `_ambSyncControls` (193ms of a 197ms press — it rebuilds
  // every card), and the drawing rode on it, so the ruler's chord band and the
  // refit record stayed stale until something else happened to repaint. This
  // is the standing lesson about dropping a broad sync: enumerate what rode on
  // it. Read from the canvas's OWN published geometry, mid-edit, with no
  // render of the probe's own.
  const cvizRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const L0 = () => (E.getCfg().layers || [])[0];
    const keep = JSON.parse(JSON.stringify({ part: L0().part, partFor: L0().partFor,
      parts: L0().parts || null, partAll: L0().partAll || null }));
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 1 }, { root: 5, intervals: [0, 4, 7], bars: 1 },
      { root: 7, intervals: [0, 4, 7], bars: 1 }, { root: 9, intervals: [0, 3, 7], bars: 1 }];
    cfg.prog.parts = [{ name: 'Verse', len: 4 }];
    E.getCfg();
    L0().partFor = 0; L0().part.bars = 4;
    const card = () => document.querySelector('.v2-layer');
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click();
      await zz(350);
    }
    const host = document.getElementById('bloom-v2-layers');
    if (host) host._sig = '';
    window._v2.render(E); await zz(350);
    const geo = () => { const c = card() && card().querySelector('.v2-vizcv');
      return (c && c._chordGeo) ? c._chordGeo.marks.map((m) => Math.round((m.f1 - m.f0) * 1000) / 1000) : null; };
    o.before = geo();
    _ambCadenceModal(E, 0); await zz(300);
    const b2 = document.querySelector('.ambient-cad-modal [data-cad^="up:0"]');
    o.hasStepper = !!b2;
    if (b2) { b2.click(); await zz(150); b2.click(); await zz(300); }
    // NO RENDER OF OUR OWN — the press is the only thing that may have
    // repainted, which is the whole claim.
    o.after = geo();
    const cl = document.querySelector('.ambient-cad-modal .cad-close'); if (cl) cl.click();
    await zz(400);
    const ca = document.querySelector('.v2-casc-modal'); if (ca) ca.querySelector('.v2-cascgo').click();
    await zz(300);
    cfg.prog = P0; E.getCfg();
    const Lr = L0();
    Lr.part = JSON.parse(JSON.stringify(keep.part));
    if (Number.isFinite(keep.partFor)) Lr.partFor = keep.partFor; else delete Lr.partFor;
    if (keep.parts) Lr.parts = keep.parts; else delete Lr.parts;
    if (keep.partAll) Lr.partAll = keep.partAll; else delete Lr.partAll;
    E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('a cadence press repaints the drawing — the chord band moves with it',
    cvizRun.hasStepper && !!cvizRun.before && !!cvizRun.after &&
    // four equal chords over four bars…
    cvizRun.before.length === 4 && cvizRun.before.every((v) => Math.abs(v - 0.25) < 0.02) &&
    // …and the first one is now twice the width of its neighbours
    cvizRun.after.length === 4 && Math.abs(cvizRun.after[0] - 0.4) < 0.02 &&
    Math.abs(cvizRun.after[1] - 0.2) < 0.02,
    JSON.stringify(cvizRun));

  // ---- THE ROLL HAS ROW LINES, AND SELECTING A NOTE DOES NOT MOVE IT -----
  // Reported together, and they are one thing: the black rows were the only
  // horizontal reference, so between two of them a note's row was a guess —
  // and the guess was being made against a selection marker inflated 4px above
  // and below the note, which at a 5-6px row is most of a row either way
  // ("this note jumps when it's selected; it looks a half-step below the one
  // to its left"). MEASURED: the note's drawn y never actually moved, so the
  // check pins that outright, and then pins the two things that made it read
  // as though it had.
  const rollRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const keep = JSON.parse(JSON.stringify({ part: L().part, harmony: L().harmony || null }));
    const mode0 = window._v2.modeOf(L());
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
      { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }];
    cfg.prog.parts = [{ name: 'V', len: 4 }];
    E.getCfg();
    // A REMAPPING PART, because that is the shape the report came from: the
    // stored midi and the drawn row are different numbers there, so anything
    // that quietly swapped one for the other on selection would show here.
    L().part.kind = 'recorded'; L().part.bars = 4; L().harmony = 'chordlock';
    L().part.notes = [{ t: 0.05, midi: 60, dur: 0.05 }, { t: 0.30, midi: 41, dur: 0.05 },
      { t: 0.55, midi: 64, dur: 0.05 }, { t: 0.80, midi: 47, dur: 0.05 }];
    window._v2.vizMode(L(), 'edit');
    E.getCfg();
    const host = document.getElementById('bloom-v2-layers'); if (host) host._sig = '';
    window._v2.render(E); await zz(400);
    const cv = () => document.querySelector('.v2-layer .v2-vizcv');
    const yOf = (i) => { const b2 = (cv()._hits || []).find((x) => x.i === i); return b2 ? Math.round(b2.y) : null; };
    o.yBefore = yOf(1);
    o.drawnDiffers = (() => { const b2 = (cv()._hits || []).find((x) => x.i === 1);
      return !!b2 && Math.abs(b2.midi - 41) > 0.5; })();   // the remap really is in play
    // A LINE PER SEMITONE, counted down a column of EMPTY plot: transitions in
    // a vertical strip, against the number of rows drawn.
    // EVERY boundary, not a total: a plain edge COUNT does not discriminate —
    // the black-row tint and the out-of-scale knock-back already put an edge
    // at most boundaries, so a count passes with the lines deleted (it did).
    // Measured with them: 26 of 26 boundaries carry an edge; without: 21 —
    // the five missing ones are exactly the boundaries between two white rows
    // in the same scale state, which is where a note's row was a guess.
    const lines = () => {
      const c = cv(), g = c.getContext('2d'), dpr = Math.min(3, window.devicePixelRatio || 1);
      const pgz = c._pitchGeo;
      const cx = Math.round((c.clientWidth - 6) * dpr);
      const rows = pgz.hiM - pgz.loM + 1;
      let hit = 0;
      for (let k = 1; k < rows; k++) {
        const y = Math.round((pgz.top + k * pgz.rowH) * dpr);
        const a = g.getImageData(cx, Math.max(0, y - 2), 1, 5).data;
        let mn = 1e9, mx = -1;
        for (let i = 0; i < a.length; i += 4) {
          const v = a[i] + a[i + 1] + a[i + 2];
          if (v < mn) mn = v; if (v > mx) mx = v;
        }
        if (mx - mn > 4) hit++;
      }
      return { edges: hit, rows: rows };
    };
    const ln = lines(); o.lineEdges = ln.edges; o.rows = ln.rows;
    // THE MARKER'S REACH. The old halo stroked a rect inset 3px/4px, so its
    // top and bottom edges painted in the column just LEFT of the note; the
    // new one is exactly the note's own rect, so that column is empty.
    const outside = () => {
      const c = cv(), g = c.getContext('2d'), dpr = Math.min(3, window.devicePixelRatio || 1);
      const b2 = (c._hits || []).find((x) => x.i === 1); if (!b2) return -1;
      const cx = Math.round((b2.x - 2) * dpr);
      const y0 = Math.max(0, Math.round((b2.y - 6) * dpr));
      const col = g.getImageData(cx, y0, 1, Math.round((b2.h + 12) * dpr)).data;
      let n = 0;
      for (let i = 0; i < col.length; i += 4)
        if (col[i] > 200 && col[i + 1] > 200 && col[i + 2] > 200) n++;
      return n;
    };
    // open the editor on that note, through the drawing
    const b0 = (cv()._hits || []).find((x) => x.i === 1);
    const r0 = cv().getBoundingClientRect();
    cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r0.left + b0.x + b0.w / 2, clientY: r0.top + b0.y + b0.h / 2 }));
    await zz(400);
    o.selected = cv()._sel === 1;
    o.ySel = yOf(1);
    o.haloOutside = outside();
    // …and the ROW is banded across the plot, which is what answers "which row
    // is it on" now that the marker no longer overstates it
    o.rowBand = (() => {
      const c = cv(), g = c.getContext('2d'), dpr = Math.min(3, window.devicePixelRatio || 1);
      const b2 = (c._hits || []).find((x) => x.i === 1); if (!b2) return false;
      const px = g.getImageData(Math.round((c.clientWidth - 6) * dpr),
        Math.round((b2.y + b2.h / 2) * dpr), 1, 1).data;
      const above = g.getImageData(Math.round((c.clientWidth - 6) * dpr),
        Math.round((b2.y - c._pitchGeo.rowH * 1.5) * dpr), 1, 1).data;
      return (px[0] + px[1] + px[2]) > (above[0] + above[1] + above[2]) + 12;
    })();
    // close it again
    cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r0.left + b0.x + b0.w / 2, clientY: r0.top + b0.y + b0.h / 2 }));
    await zz(400);
    o.yAfter = yOf(1);
    // restore
    window._v2.vizMode(L(), mode0);
    L().part = JSON.parse(JSON.stringify(keep.part));
    if (keep.harmony) L().harmony = keep.harmony; else delete L().harmony;
    cfg.prog = P0; E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('the roll has a line per semitone — EVERY row boundary, not just the black ones',
    rollRun.rows > 8 && rollRun.lineEdges === rollRun.rows - 1,
    JSON.stringify({ edges: rollRun.lineEdges, boundaries: rollRun.rows - 1 }));
  ok('selecting a note does NOT move it — the marker sits on its own row',
    rollRun.drawnDiffers && rollRun.selected &&
    rollRun.yBefore != null && rollRun.ySel === rollRun.yBefore &&
    rollRun.yAfter === rollRun.yBefore &&
    rollRun.haloOutside === 0 && rollRun.rowBand,
    JSON.stringify(rollRun));

  // ---- THE SAME NOTE, THE SAME ROW — STOPPED AND PLAYING -----------------
  // A remapped pitch is a function of the chord AT THE NOTE'S OWN ONSET, and
  // the onset is `cs + n.at`. With `cs` at zero a per-part record was resolved
  // against the FIRST chord of the whole progression instead of against its
  // own part's — so every note sat on a different row from the one it takes
  // when that part comes round ("the note is in a different place on playback
  // and when stopped"). The drawing and playback now share one anchor, and so
  // does the ruler's chord band above them: a picture whose chord names and
  // whose notes disagree about which chords are underneath is contradicting
  // itself.
  //
  // THE FIXTURE IS THE SECOND PART, deliberately: with the layer on part 1 the
  // wrong anchor lands on part 0's chords, which is the reported shape. On the
  // first part the bug is invisible.
  const anchRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const keep = JSON.parse(JSON.stringify({ part: L().part, harmony: L().harmony || null,
      partFor: L().partFor, on: L().on, present: L().present }));
    const mode0 = window._v2.modeOf(L());
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
      { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] },
      { root: 2, intervals: [0, 3, 7] }, { root: 4, intervals: [0, 3, 7] }];
    cfg.prog.parts = [{ name: 'Verse', len: 4 }, { name: 'Chorus', len: 2 }];
    E.getCfg();
    const Lx = L();
    Lx.on = true; Lx.present = true;
    Lx.part.kind = 'recorded'; Lx.part.bars = 2; Lx.harmony = 'chordlock'; Lx.partFor = 1;
    Lx.part.notes = [{ t: 0.1, midi: 60, dur: 0.08 }, { t: 0.35, midi: 64, dur: 0.08 },
      { t: 0.6, midi: 67, dur: 0.08 }, { t: 0.85, midi: 71, dur: 0.08 }];
    window._v2.vizMode(Lx, 'edit');
    E.getCfg();
    const host = document.getElementById('bloom-v2-layers'); if (host) host._sig = '';
    window._v2.render(E); await zz(400);
    const cv = () => document.querySelector('.v2-layer .v2-vizcv');
    const shot = () => { const c = cv(); if (!c) return null;
      return { rows: (c._hits || []).map((x) => Math.round(x.midi)).join(','),
        chords: c._chordGeo ? c._chordGeo.marks.map((m) => m.nm).join(',') : null }; };
    o.stopped = shot();
    _ambStartGenerator(E); await zz(300);
    for (let i = 0; i < 60; i++) {
      await zz(200);
      const c = cv(); if (c && c._drawnPi === 1) { o.playing = shot(); break; }
    }
    _ambStopGenerator(E); await zz(400);
    window._v2.render(E); await zz(300);
    o.after = shot();
    // A TEST THAT PLAYS MUST NULL THE CLOCKS — a stale `_playStartAt` re-anchors
    // every later chord resolution in this page (the documented trap).
    E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
    window._v2.vizMode(L(), mode0);
    L().part = JSON.parse(JSON.stringify(keep.part));
    if (keep.harmony) L().harmony = keep.harmony; else delete L().harmony;
    if (Number.isFinite(keep.partFor)) L().partFor = keep.partFor; else delete L().partFor;
    L().on = keep.on; L().present = keep.present;
    cfg.prog = P0; E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('a note sits on the SAME row stopped and playing — one anchor, and the chords agree',
    !!anchRun.playing && !!anchRun.stopped &&
    // the remap is really in play — plain midis would make this pass regardless
    anchRun.stopped.rows !== '60,64,67,71' &&
    anchRun.stopped.rows === anchRun.playing.rows &&
    anchRun.after && anchRun.after.rows === anchRun.stopped.rows &&
    // …and the ruler names the chords the notes were resolved against
    anchRun.stopped.chords === anchRun.playing.chords &&
    anchRun.after.chords === anchRun.stopped.chords,
    JSON.stringify(anchRun));

  // ---- THE DRAWING IS A WINDOW ON THE PART, AND IT NAVIGATES -------------
  // It used to be the WHOLE part squeezed into one width and the notes' own
  // pitch range squeezed into one height: nothing outside either could be
  // reached, and on a long part a bar was a few pixels. At most four bars are
  // on screen at a phone's width, the rest is reached with ◀ ▶, and the pitch
  // window pans and resizes.
  //
  // THE CLAUSE WITH TEETH IS THE INVERSE MAPPING: a press lands at a pixel,
  // and with only part of the cycle showing that pixel is not the fraction of
  // the cycle it used to be — an un-mapped conversion draws the note back at
  // the start of the part, which is the failure a "the buttons move things"
  // check cannot see.
  const navRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const keep = JSON.parse(JSON.stringify({ part: L().part }));
    const mode0 = window._v2.modeOf(L());
    cfg.prog.on = true;
    cfg.prog.chords = [];
    for (let i = 0; i < 12; i++) cfg.prog.chords.push({ root: (i * 5) % 12, intervals: [0, 4, 7] });
    cfg.prog.parts = [{ name: 'A', len: 4 }, { name: 'B', len: 4 }, { name: 'C', len: 4 }];
    E.getCfg();
    L().part.kind = 'recorded'; L().part.bars = 12;
    L().part.notes = [];
    for (let i = 0; i < 12; i++) L().part.notes.push({ t: i / 12 + 0.01, midi: 48 + i * 2, dur: 0.05 });
    window._v2.vizMode(L(), 'edit');
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click(); await zz(350);
    }
    const host = document.getElementById('bloom-v2-layers'); if (host) host._sig = '';
    window._v2.render(E); await zz(400);
    const cv = () => card().querySelector('.v2-vizcv');
    const g = () => { const c = cv(); return { vb: c._plotGeo.vbars,
      b0: Math.round((c._plotGeo.bar0 || 0) * 100) / 100,
      lo: c._pitchGeo.loM, hi: c._pitchGeo.hiM, h: c.clientHeight, hits: (c._hits || []).length }; };
    o.btns = [...card().querySelectorAll('.v2-nav')].map((x) => x.getAttribute('data-nav')).join(',');
    o.start = g();
    o.lab = (card().querySelector('.v2-navlab') || {}).textContent || '';
    const press = (a) => { const b2 = card().querySelector('.v2-nav[data-nav="' + a + '"]'); if (b2) b2.click(); };
    press('right'); await zz(200); o.right = g();
    press('up'); await zz(200); o.up = g();
    press('grow'); await zz(200); o.grow = g();
    press('fit'); await zz(250); o.fit = g();
    press('right'); await zz(200);        // pan again for the mapping test below
    // THE INVERSE MAPPING. With the window panned, a press at 3/4 across the
    // plot must add a note in the bar that is DRAWN there — not at 3/4 of the
    // whole part.
    window._v2.vizMode(L(), 'draw');
    window._v2.render(E); await zz(300);
    const c2 = cv(), pl = c2._plotGeo, pg2 = c2._pitchGeo;
    // THE NOTE THAT WAS ADDED, identified — not "a note near where we aimed".
    // Searching every note for the nearest one lets a PRE-EXISTING note stand
    // in for the new one, and the poison (an un-mapped press, which lands the
    // note bars away) passed on exactly that.
    const t0s = new Set(L().part.notes.map((n) => Math.round(n.t * 1e6)));
    const before = L().part.notes.length;
    const rc = c2.getBoundingClientRect();
    const fx = 0.75;
    const px = pl.x0 + pl.w * fx, py = pg2.top + pg2.rowH * 2.5;
    c2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1,
      clientX: rc.left + px, clientY: rc.top + py }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    await zz(300);
    o.added = L().part.notes.length - before;
    // …in BARS, which is the readable form of the claim
    const want = (pl.f0 + fx * pl.vsc) * 12;
    const got = (() => {
      const nu = L().part.notes.filter((n) => !t0s.has(Math.round(n.t * 1e6)));
      return nu.length === 1 ? Math.round(nu[0].t * 12 * 100) / 100 : null;
    })();
    o.penBar = got; o.penWant = Math.round(want * 100) / 100;
    window._v2.vizMode(L(), mode0);
    L().part = JSON.parse(JSON.stringify(keep.part));
    cfg.prog = P0; E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('the drawing is a WINDOW on the part — four bars to a phone, and it pans',
    navRun.btns === 'up,dn,grow,shrink,left,right,fit' &&
    navRun.start.vb === 4 && navRun.start.b0 === 0 &&
    // a long part is windowed, so only some of its notes are drawn at once
    navRun.start.hits > 0 && navRun.start.hits < 12 &&
    /bar 1/.test(navRun.lab) &&
    navRun.right.b0 > 1 && navRun.right.b0 < 2 &&
    navRun.up.lo === navRun.start.lo + 3 && navRun.up.hi === navRun.start.hi + 3 &&
    // ＋ shows MORE pitches and the canvas grows with them — under a fixed cap
    // it would only have made the rows thinner, the opposite of the ask
    navRun.grow.hi - navRun.grow.lo > navRun.up.hi - navRun.up.lo &&
    navRun.grow.h > navRun.up.h &&
    navRun.fit.b0 === 0 && navRun.fit.lo === navRun.start.lo &&
    navRun.fit.h === navRun.start.h,
    JSON.stringify(navRun));
  ok('…and a press lands where it is DRAWN — the viewport maps both ways',
    navRun.added === 1 && navRun.penBar != null &&
    Math.abs(navRun.penBar - navRun.penWant) < 0.3,
    JSON.stringify({ added: navRun.added, bar: navRun.penBar, want: navRun.penWant }));

  // ---- PLAY STARTS FROM THE PART YOU ARE EDITING -------------------------
  // The ⇶ Part strip names which part is current, and play ignored it — so
  // auditioning the part you were working on meant waiting out everything
  // before it. A FAST-FORWARD OF THE ONE CLOCK (both anchors move back by the
  // part's own offset), never a second entry point: the chord clock, the bar
  // grid, the sections and every layer's phase arrive there together.
  const ffRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const cp0 = E._curPart;
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
      { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] },
      { root: 2, intervals: [0, 3, 7] }, { root: 4, intervals: [0, 3, 7] }];
    cfg.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2 }, { name: 'C', len: 2 }];
    E.getCfg();
    const run = async (sel) => {
      if (sel == null) delete E._curPart; else E._curPart = sel;
      _ambStartGenerator(E); await zz(500);
      const w = _ambPartChordAt(E, cfg, Tone.now() + 0.05);
      const at = w ? { pi: w.pi, ci: w.ci } : null;
      // ONE CLOCK, STILL. The shift moves BOTH anchors, so the chord clock and
      // the bar grid stay pinned together — moving only `_progAnchor` would
      // re-open the two-clock gap that made every chord land late by the lead.
      // Asserted structurally rather than by racing a chord's length: at
      // 120bpm a chord is 2s, so "did it advance yet" is a coin toss.
      const oneClock = Math.abs((E._progAnchor || 0) - (E._barGridAnchor || 0)) < 1e-9;
      _ambStopGenerator(E); await zz(300);
      E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
      return { at, oneClock };
    };
    o.p0 = await run(0);
    o.p1 = await run(1);
    o.p2 = await run(2);
    o.none = await run(null);
    if (cp0 == null) delete E._curPart; else E._curPart = cp0;
    cfg.prog = P0; E.getCfg();
    return o;
  });
  ok('play starts from the part you are editing — and plays ON from there',
    ffRun.p0.at && ffRun.p0.at.pi === 0 && ffRun.p0.at.ci === 0 &&
    ffRun.p1.at && ffRun.p1.at.pi === 1 && ffRun.p1.at.ci === 0 &&
    ffRun.p2.at && ffRun.p2.at.pi === 2 && ffRun.p2.at.ci === 0 &&
    // no selection is the old behaviour, from the top
    ffRun.none.at && ffRun.none.at.pi === 0 &&
    // …and the two clocks are still one, which is what makes it a fast-forward
    // of the arrangement rather than a chord clock running on its own
    ffRun.p0.oneClock && ffRun.p1.oneClock && ffRun.p2.oneClock && ffRun.none.oneClock,
    JSON.stringify(ffRun));

  // ---- RAMPS REACH v2 ----------------------------------------------------
  // `cfg.layers` had joined ten of v1's sweeps and not this one: the target
  // picker enumerates the four primaries, seq, samp and `cfg.extras`, and the
  // resolver had no `v2:<id>` head — so a v2 layer could not be ramped and did
  // not even appear in the list. The eleventh instance of "a new layer store
  // must join EVERY sweep", and it escaped the audit that found the other ten
  // because that one grepped for functions walking ['bed','motif',…] while
  // this one walks a different shape.
  //
  // THE CHEAP PART, worth stating: `head` IS the engine key, and v2's own key
  // is `v2:<id>` — so `_ambApplyLayerFx`, `_ambApplyLayerPan`,
  // `_ambApplyLayerFilter` and `_E.mod[head]` all work untouched, and the
  // shared append (Stereo · Spatialize · every FX) reaches the new category for
  // free because it runs over `Object.keys` after the derive.
  const rampRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    // THE WHOLE LAYER, because this probe writes sixty-one arbitrary fields —
    // restoring "the ones I remember touching" is the one-page-one-state trap,
    // and it took out two downstream checks (Level and the synth kit) before
    // this snapshot replaced it.
    const svAll = JSON.parse(JSON.stringify(L()));
    const rp0 = cfg.ramps ? JSON.parse(JSON.stringify(cfg.ramps)) : null;
    const head = 'v2:' + (L().id | 0);
    // SOME FIELDS ONLY EXIST IN A MODE — `pitch.mix` in Mixed, `spread` and
    // `variety` under a chord voicing — and normalize prunes them otherwise.
    // They are real targets; testing them on a DEFAULT layer is what is wrong.
    L().part.pitch = Object.assign({}, L().part.pitch, { kind: 'mixed', chordMode: 'chords' });
    E.getCfg();
    const groups = _ambRampTargetGroups(E.getCfg());
    const grp = groups.find((g) => g.items.some((it) => it.value.indexOf(head + '.') === 0));
    o.inPicker = !!grp;
    o.n = grp ? grp.items.length : 0;
    // EVERY listed target must RESOLVE and WRITE. A typo or a field that has
    // been renamed out from under the table is the drift risk this guards:
    // v2 builds its card from its own descriptors, so nothing derives the list
    // and nothing else would notice.
    const bad = [];
    (grp ? grp.items : []).forEach((it) => {
      const t = _ambRampResolve(E.getCfg(), it.value);
      if (!t) { bad.push(it.value + ' UNRESOLVED'); return; }
      const key = it.value.slice(head.length + 1);
      // NOT the midpoint: normalize prunes a value equal to its default, so a
      // mid value that happens to BE the default reads as "not written" on a
      // perfectly good target.
      const v = t.min + Math.max(1, Math.round((t.max - t.min) * 0.37));
      try { if (t.set) t.set(v); else { t.obj[t.key] = v; } }
      catch (e) { bad.push(it.value + ' THREW'); return; }
      const path = key.split('.');
      let o2 = L();
      for (let i = 0; i < path.length - 1 && o2; i++) o2 = o2[path[i]];
      if (!Number.isFinite(o2 && o2[path[path.length - 1]])) bad.push(it.value + ' NOT WRITTEN');
    });
    o.bad = bad;
    // the shared treatments came along
    const has = (k) => (grp ? grp.items : []).some((it) => it.value === head + '.' + k);
    o.shared = ['space', 'revSend', 'cutoff', 'delay.mix', 'spat.width', 'glitch.mix'].every(has);
    // …and v2's OWN generative knobs, which is what the category adds
    o.own = ['part.rhythm.pulses', 'part.pitch.span', 'part.shape.lenRatio'].every(has);
    // `part.bars` is deliberately ABSENT — the per-part reconciler rewrites it
    // on every getCfg, so a ramp there would be silently outvoted
    o.noBars = !has('part.bars');
    // END TO END: a real ramp moves a v2 field over time, through the same
    // `_ambApplyRamps` every other layer uses.
    L().part.rhythm = { kind: 'euclid', steps: 8, pulses: 3, rotate: 0 };
    E.getCfg();
    E.getCfg().ramps = [{ id: 991, on: true, wave: 'tri', periodMs: 4000, a: 1, b: 16,
      targets: [head + '.part.rhythm.pulses'] }];
    E.getCfg();
    const seen = new Set();
    for (let i = 0; i < 9; i++) { _ambApplyRamps(E.getCfg(), i * 0.5); seen.add(L().part.rhythm.pulses); }
    o.moves = seen.size;
    E.getCfg().ramps = [{ id: 992, on: true, wave: 'tri', periodMs: 4000, a: 0, b: 100,
      targets: [head + '.level'] }];
    E.getCfg();
    const lv = new Set();
    for (let i = 0; i < 9; i++) { _ambApplyRamps(E.getCfg(), i * 0.5); lv.add(L().level); }
    o.levelMoves = lv.size;
    if (rp0) E.getCfg().ramps = rp0; else delete E.getCfg().ramps;
    const Lr = L();
    Object.keys(Lr).forEach((k) => { delete Lr[k]; });
    Object.assign(Lr, svAll);
    E.getCfg();
    const host = document.getElementById('bloom-v2-layers'); if (host) host._sig = '';
    window._v2.render(E);
    return o;
  });
  ok('ramps reach a v2 layer — it is in the picker and every target writes',
    rampRun.inPicker && rampRun.n > 40 && rampRun.bad.length === 0 &&
    rampRun.shared && rampRun.own && rampRun.noBars,
    JSON.stringify(rampRun));
  ok('…and a ramp really moves one over time, through the shared driver',
    rampRun.moves > 2 && rampRun.levelMoves > 2,
    JSON.stringify({ moves: rampRun.moves, level: rampRun.levelMoves }));

  // ---- THE GRID DOES NOT FLINCH, AND A NOTE FILLS ITS ROW ----------------
  // Two reports, one screenshot. (1) "it resizes and re-draws and disorients
  // the user, the grid should never flinch" — in 👁 View the picture FOLLOWS
  // playback and swaps to another part's record, so the sticky window grew the
  // instant a part with a wider span came round: measured mid-play, the canvas
  // went 92px → 127px and every row slid under the eye. (2) "note events are
  // not filling the slot commensurate with the size they are" — the note
  // height was capped at 8px, most of a reading-size row and a third of a
  // zoomed one.
  const flinchRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    const svAll = JSON.parse(JSON.stringify(L()));
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const mode0 = window._v2.modeOf(L());
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
      { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }];
    cfg.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2 }];
    E.getCfg();
    // THE REPORTED SHAPE, made DETERMINISTIC: a per-part layer whose OTHER
    // part's record spans far more pitch than the one being edited. In 👁 View
    // the picture follows playback and swaps to it, and without the hold the
    // window grows to swallow it — which is the flinch. A generated fixture
    // grows too, but only when a cycle happens to roll high, so it passes its
    // own poison about half the time (it did).
    L().on = true; L().present = true;
    L().part.kind = 'recorded'; L().part.bars = 2;
    L().part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.5, midi: 64, dur: 0.2 }];
    L().partFor = 0;
    E.getCfg();
    L().parts = L().parts || {};
    L().parts['1'] = { kind: 'recorded', bars: 2,
      notes: [{ t: 0, midi: 36, dur: 0.2 }, { t: 0.5, midi: 96, dur: 0.2 }] };
    window._v2.vizMode(L(), 'view');
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click(); await zz(350);
    }
    const host = document.getElementById('bloom-v2-layers'); if (host) host._sig = '';
    window._v2.render(E); await zz(400);
    const cv = () => card().querySelector('.v2-vizcv');
    // THE WHOLE SHAPE, as one string — height, window, row size, viewport.
    // Anything that moves shows up as a second entry.
    const shape = () => { const c = cv(); if (!c || !c._pitchGeo) return 'none';
      return [c.clientHeight, c._pitchGeo.loM, c._pitchGeo.hiM,
        Math.round(c._pitchGeo.rowH * 10) / 10, c._plotGeo.vbars,
        Math.round((c._plotGeo.bar0 || 0) * 100) / 100].join('/'); };
    const fill = () => { const c = cv(), h = (c._hits || [])[0];
      return h ? Math.round(h.h / c._pitchGeo.rowH * 100) : null; };
    const rowH = () => Math.round(cv()._pitchGeo.rowH * 10) / 10;
    // STOPPED: repeated renders move nothing
    const s0 = new Set();
    for (let i = 0; i < 5; i++) { window._v2.render(E); await zz(120); s0.add(shape()); }
    o.stopped = s0.size;
    // PLAYING, across a part boundary — this is where it grew
    _ambStartGenerator(E); await zz(300);
    const order = [];
    for (let i = 0; i < 40; i++) {
      await zz(150);
      const v = shape();
      if (v !== order[order.length - 1]) order.push(v);
    }
    _ambStopGenerator(E); await zz(300);
    E._playStartAt = null; E._progAnchor = null; E._barGridAnchor = null;
    o.playShapes = order.length;
    o.first = order[0];
    window._v2.render(E); await zz(250);
    // A NOTE FILLS ITS ROW — at TWO row heights, which is what discriminates.
    // The old cap made the RATIO change with the row (81% at 5.3px, 87% at
    // 8px); proportional holds it, so a single-size check passes either way.
    o.rowA = rowH(); o.fillA = fill();
    const press = (a) => { const b2 = card().querySelector('.v2-nav[data-nav="' + a + '"]'); if (b2) b2.click(); };
    // …stopping as soon as the row is TALLER and a note is still in view:
    // shrinking all the way empties it, and a fill measured on no note is the
    // check asserting nothing.
    for (let i = 0; i < 8; i++) {
      press('shrink'); await zz(110);
      if (rowH() > o.rowA + 1 && fill() != null) break;
    }
    o.rowB = rowH(); o.fillB = fill();
    // …and − really zooms: it was floored at 0, so it could only undo a ＋
    o.zoomed = o.rowB > o.rowA + 1;
    // WHAT FALLS OUTSIDE IS CLIPPED, COUNTED AND NAMED — without the clip a
    // note above the window was drawn over the RULER, which only became
    // reachable once the window stopped growing to swallow it.
    press('up'); press('up'); press('up'); await zz(300);
    const c3 = cv(), pgz = c3._pitchGeo;
    o.hidden = c3._hidden | 0;
    o.lab = (card().querySelector('.v2-navlab') || {}).textContent || '';
    o.allInside = (c3._hits || []).every((x) => x.y >= pgz.top - 1 && x.y + x.h <= c3.clientHeight + 1);
    press('fit'); await zz(250);
    window._v2.vizMode(L(), mode0);
    const Lr = L();
    Object.keys(Lr).forEach((k) => { delete Lr[k]; });
    Object.assign(Lr, svAll);
    cfg.prog = P0; E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('the grid does not flinch — its shape is the SAME through a part boundary',
    flinchRun.stopped === 1 && flinchRun.playShapes === 1,
    JSON.stringify({ stopped: flinchRun.stopped, play: flinchRun.playShapes, shape: flinchRun.first }));
  ok('a note FILLS its row — the same fraction at every row height',
    flinchRun.fillA != null && flinchRun.fillB != null &&
    flinchRun.fillA >= 70 && flinchRun.fillA <= 90 &&
    Math.abs(flinchRun.fillA - flinchRun.fillB) <= 3 && flinchRun.zoomed,
    JSON.stringify({ rowA: flinchRun.rowA, fillA: flinchRun.fillA,
                     rowB: flinchRun.rowB, fillB: flinchRun.fillB, zoomed: flinchRun.zoomed }));
  ok('…and what falls outside the window is clipped, counted and named',
    flinchRun.hidden > 0 && /outside/.test(flinchRun.lab) && flinchRun.allInside,
    JSON.stringify({ hidden: flinchRun.hidden, lab: flinchRun.lab, inside: flinchRun.allInside }));

  // ---- A NOTE FILLS ITS SLOT, AND THE SLOT IS THE ONE IT IS ON -----------
  // "note event width isn't right." Two causes, both measured. (1) THE LENGTH
  // was `cyc / ons.length` — the AVERAGE gap, one value for every note — so on
  // an uneven pattern (euclid 7-of-16 has gaps of 2,2,3,2,2,3,2 steps) every
  // note came out 2.06 steps wide whatever slot it sat in. (2) THE GRID drawn
  // under them was fixed QUARTER notes, which is neither lattice: a generated
  // part sits on `rhythm.steps` per CYCLE, a written one on `bars × grid`. On
  // a 4.5-bar part at 16 steps those are 0.0625 and 0.0556 of the cycle, so
  // every onset landed between lines and every note measured 2.32 "cells".
  const widthRun = await page.evaluate(async () => {
    const E = _masterEng, o = {};
    const L = () => window.__Lv2(E);
    const svAll = JSON.parse(JSON.stringify(L()));
    const mode0 = window._v2.modeOf(L());
    const card = () => document.querySelector('.v2-layer');
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click(); await zz(350);
    }
    const host = document.getElementById('bloom-v2-layers');
    const draw = async () => { if (host) host._sig = ''; window._v2.render(E); await zz(350); };
    // THE LATTICE THE PICTURE DREW, asked of the picture. Passing it in meant
    // the check measured against a number of its own choosing — so drawing a
    // DIFFERENT grid under the notes passed it (the poison did).
    const read = () => {
      const c = card().querySelector('.v2-vizcv'), pl = c._plotGeo;
      const latN = (c._barsGeo && c._barsGeo.latN) | 0;
      // NOT the ones the VIEWPORT cuts. A note running past the right edge is
      // drawn as the part of itself that is visible, so its measured width is
      // a fact about the window, not about the note — and asserting on it
      // reads as a length bug that is not there.
      // NOT the ones the viewport CUTS — a note running past the right edge is
      // drawn as the part of itself that is visible, so its width is a fact
      // about the window rather than about the note. A note starting AT the
      // left edge is not cut; only the right edge crops here (bar0 is 0).
      const hits = (c._hits || []).slice().sort((a, b2) => a.x - b2.x)
        .filter((h) => h.x + h.w < pl.x0 + pl.w - 1.5);
      const cell = 1 / latN;
      return {
        onGrid: hits.map((h) => {
          const f = ((h.x - pl.x0) / pl.w) * pl.vsc + pl.f0;
          const off = (f / cell) % 1;
          return Math.min(off, 1 - off);          // distance to the nearest line
        }),
        wCells: hits.map((h) => Math.round(((h.w / pl.w) * pl.vsc) / cell * 100) / 100),
      };
    };
    // ── GENERATED, on the reported shape ───────────────────────────────────
    L().part.kind = 'live'; L().part.bars = 4.5; delete L().part.form;
    L().part.grid = 4;
    L().part.rhythm = { kind: 'euclid', steps: 16, pulses: 7, rotate: 0 };
    L().part.pitch = { kind: 'walk', span: 5 };
    L().part.shape = Object.assign({}, L().part.shape, { lenRatio: 100 });
    window._v2.vizMode(L(), 'edit');
    E.getCfg(); await draw();
    const g1 = read();
    o.latGen = (card().querySelector('.v2-vizcv')._barsGeo || {}).latN;
    o.genOnGrid = Math.max.apply(null, g1.onGrid.concat([0]));
    // AT LENGTH 100 a note fills its slot EXACTLY — whole numbers of cells,
    // and 2s and 3s because the pattern's gaps are uneven. One value for all
    // of them is the bug.
    // WHOLE cells, and not all the same — NOT a pinned sequence: which slots
    // a euclid 7-of-16 makes 2 and which 3 is the generator's business, and
    // pinning it would be pinning the fixture (it read 2,2,3,2,2,2).
    o.genW = g1.wCells.slice(0, 6).join(',');
    o.genWhole = g1.wCells.every((v) => Math.abs(v - Math.round(v)) < 0.06);
    o.genVaries = new Set(g1.wCells.map((v) => Math.round(v))).size > 1;
    // …and Length is a percentage OF THAT SLOT
    // …and Length is a percentage OF THAT SLOT: every width at 50 is half the
    // one at 100. Asserted as the RELATION, not as a sequence — which notes
    // survive the viewport filter is not the claim.
    L().part.shape.lenRatio = 50; E.getCfg(); await draw();
    const gHalf = read().wCells;
    o.genHalf = gHalf.slice(0, 3).join(',');
    o.halves = gHalf.length === g1.wCells.length &&
      gHalf.every((v, i2) => Math.abs(v - g1.wCells[i2] / 2) < 0.06);
    // ── WRITTEN: the lattice is the EDITING grid, and a 1-cell note is 1 cell
    L().part.kind = 'recorded'; L().part.bars = 1; L().part.grid = 8;
    L().part.notes = [{ t: 0, midi: 60, dur: 1 / 8 }, { t: 2 / 8, midi: 62, dur: 2 / 8 },
      // …ending BEFORE the cycle's edge, so nothing is viewport-cropped and
      // the check is about the note rather than about the window
      { t: 5 / 8, midi: 64, dur: 2 / 8 }];
    E.getCfg(); await draw();
    const g2 = read();
    o.latRec = (card().querySelector('.v2-vizcv')._barsGeo || {}).latN;
    o.latRecWant = window._v2.gridCells(L());
    o.recOnGrid = Math.max.apply(null, g2.onGrid.concat([0]));
    o.recW = g2.wCells.join(',');
    window._v2.vizMode(L(), mode0);
    const Lr = L();
    Object.keys(Lr).forEach((k) => { delete Lr[k]; });
    Object.assign(Lr, svAll);
    E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('a generated note sits ON the lattice and fills its OWN slot',
    // every onset within 2% of a line — they were landing at 0.25 and 0.5 of a cell
    // …on the lattice the GENERATOR uses, which is what the picture must draw
    widthRun.latGen === 16 && widthRun.genOnGrid < 0.02 &&
    // whole slots at Length 100, and NOT all the same: an uneven pattern has
    // 2-step and 3-step gaps, and one width for both was the defect
    widthRun.genWhole && widthRun.genVaries &&
    // …and Length is a percentage of that slot
    widthRun.halves,
    JSON.stringify(widthRun));
  ok('…and a written note is drawn on the EDITING grid, a cell per cell',
    widthRun.latRec === widthRun.latRecWant &&
    widthRun.recOnGrid < 0.02 && widthRun.recW === '1,2,2',
    JSON.stringify({ onGrid: widthRun.recOnGrid, w: widthRun.recW }));

  // ---- THE EDITOR STATES THE NOTE'S OWN LENGTH ---------------------------
  // Reported as "a note 1 bar long should fit the bar in the grid" — and the
  // DRAWING was right the whole time. A generated take's notes are a
  // percentage of their slot (Length 90%), so a 3-cell slot stores 2.7 cells;
  // the stepper can only carry a whole number (the shared delegation parses
  // with parseInt), so it rounded to 3 and the row read "3 · 3 beats" beside a
  // note honestly drawn at 2.7. The app contradicted itself and the readout is
  // what had to give. A ± press then SNAPS to the grid, so there is a one-press
  // way to make it exactly a bar — and a note already ON the grid is untouched.
  const lenRun = await page.evaluate(async () => {
    const E = _masterEng, o = {};
    const L = () => window.__Lv2(E);
    const sv = JSON.parse(JSON.stringify(L()));
    const card = () => document.querySelector('.v2-layer');
    const host = document.getElementById('bloom-v2-layers');
    const draw = async () => { if (host) host._sig = ''; window._v2.render(E); await zz(300); };
    const open = async (hit) => {
      const cv = card().querySelector('.v2-vizcv');
      const r = cv.getBoundingClientRect();
      const x = r.left + hit.x + hit.w / 2, y = r.top + hit.y + hit.h / 2;
      const fire = (t) => cv.dispatchEvent(new PointerEvent(t,
        { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'touch' }));
      fire('pointerdown'); fire('pointerup');
      cv.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
      await zz(220);
    };
    const row = (sf) => {
      const ne = card().querySelector('.v2-neinline');
      const el = ne && ne.querySelector('[data-sf="' + sf + '"]');
      if (!el) return null;
      const rw = el.closest('.ambient-ctrl');
      const rd = rw && (rw.querySelector('.ambient-sl-v') || rw.querySelector('.ambient-hint'));
      return { field: el.value, txt: rd ? rd.textContent : '', el: el };
    };
    const press = async (sf, dir) => {
      const r2 = row(sf); if (!r2) return false;
      const st = r2.el.closest('.ambient-stepper');
      const b = st && st.querySelector('.ambient-step-' + dir);
      if (!b) return false;
      b.click(); await zz(220); return true;
    };
    const P = L().part;
    // A PER-PART layer has its length RECONCILED on every normalize, so a
    // hand-set `bars` does not survive — and the gate's layer carries whatever
    // an earlier check left on it. Unbind it, then derive every expectation
    // from the length the app actually settled on rather than the one asked
    // for (the documented "assert the stored shape before measuring" rule).
    delete L().partFor; delete L().parts; delete L().lenSync;
    P.kind = 'recorded'; P.bars = 4.5; P.grid = 4;
    P.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.5, midi: 64, dur: 0.1 }];
    window._v2.normalizeAll(E.getCfg());
    const gn = window._v2.gridCells(L());
    const bars = L().part.bars;
    o.gridCells = gn; o.bars = bars;
    o.perBar = gn / bars;                       // cells in one bar
    // ONE OFF-GRID note (2.7 cells — Length 90 on a 3-cell slot) and one
    // exactly one BAR long, which is the note the report was about.
    L().part.notes = [{ t: 0, midi: 60, dur: 2.7 / gn },
                      { t: Math.round(gn / 2) / gn, midi: 64, dur: 1 / bars }];
    window._v2.normalizeAll(E.getCfg());
    await draw();
    const cv = card().querySelector('.v2-vizcv');
    const hits = (cv._hits || []).slice().sort((a, b) => a.x - b.x);
    o.hits = hits.length;
    const bg = cv._barsGeo, pl = cv._plotGeo;
    // A BAR ON SCREEN IS `PLOT / vbars`, NOT `PLOT / barsF`. Only part of a long
    // cycle is in the viewport (4 bars at phone width), so the two differ by the
    // zoom exactly — measuring against barsF reported a correct one-bar note as
    // 1.125 bars, which is barsF/VB. Ask the picture for the geometry it drew.
    o.vbars = bg.vbars; o.barsF = bg.barsF;
    o.barPx = pl.w / bg.vbars;
    // the ON-GRID note is exactly one bar wide in the picture — the user's claim
    o.oneBarDrawn = hits[1] ? Math.round((hits[1].w / o.barPx) * 1000) / 1000 : null;
    // --- the off-grid note ---
    if (hits[0]) await open(hits[0]);
    const a = row('len');
    o.offField = a ? a.field : null;
    o.offTxt = a ? a.txt : null;
    o.offTrue = Math.round(L().part.notes[0].dur * gn * 100) / 100;
    o.offPressed = await press('len', 'up');
    o.offAfterUp = Math.round(L().part.notes[0].dur * gn * 100) / 100;
    // --- the on-grid note is unchanged: ＋ is still +1 cell ---
    await draw();
    const cv2 = card().querySelector('.v2-vizcv');
    const h2 = (cv2._hits || []).slice().sort((a2, b2) => a2.x - b2.x);
    const on = h2.find((h) => (h.i | 0) === 1) || h2[h2.length - 1];
    if (on) await open(on);
    const b3 = row('len');
    o.onField = b3 ? b3.field : null;
    o.onTxt = b3 ? b3.txt : null;
    o.onPressed = await press('len', 'up');
    o.onAfterUp = Math.round(L().part.notes[1].dur * gn * 100) / 100;
    o.onWant = Math.round(o.perBar) + 1;        // one bar, plus the one cell ＋ adds
    // put the layer back — a probe that rewrites the record must restore it
    Object.keys(L()).forEach((k) => { delete L()[k]; });
    Object.assign(L(), sv);
    window._v2.normalizeAll(E.getCfg());
    await draw();
    return o;
  });
  // RESTATED 2026-09-12 with the reason, and STRICTLY STRONGER. The honest
  // length used to live in a readout column BESIDE a field showing the
  // stepper's rounded copy (3) — two answers on one row, and the rounded one
  // is the half your eye lands on. The face moved INTO the field, so the
  // claim "the editor states the note's OWN length" is now about the field
  // itself: it must name 2.7 AND no bare rounded copy may be visible anywhere
  // on the row. The ± contract (a press is round(cur) ± 1, never a step past
  // to 4) is unchanged and still pinned below it.
  ok('the note editor states the note’s OWN length, not the stepper’s rounded copy',
    lenRun.offTrue === 2.7 && /2\.7/.test(String(lenRun.offField)) &&
    !/^3$/.test(String(lenRun.offField).trim()) &&
    // …and a ＋ press SNAPS it onto the grid rather than stepping past to 4
    lenRun.offPressed && lenRun.offAfterUp === 3,
    JSON.stringify({ trueCells: lenRun.offTrue, field: lenRun.offField,
                     readout: lenRun.offTxt, afterUp: lenRun.offAfterUp }));
  ok('…a note already ON the grid is untouched, and one bar of note fills one bar',
    // ＋ still adds exactly one cell — the snap must not touch an on-grid note
    lenRun.onPressed && lenRun.onAfterUp === lenRun.onWant &&
    // …and the claim the report was actually about: a one-bar note is one bar wide
    lenRun.oneBarDrawn === 1,
    JSON.stringify({ readout: lenRun.onTxt, afterUp: lenRun.onAfterUp, want: lenRun.onWant,
                     perBar: lenRun.perBar, bars: lenRun.bars,
                     vbars: lenRun.vbars, barsF: lenRun.barsF,
                     oneBarDrawn: lenRun.oneBarDrawn }));

  // ---- ✂ SPLIT — ONE NOTE BECOMES SEVERAL, IN ITS OWN SPAN ---------------
  // The total length is the invariant: whatever the pattern, the pieces cover
  // exactly `[t, t+dur)` and nothing after the note moves — that is what makes
  // it a division rather than an edit. Asserted on the ARITHMETIC (the weights
  // must sum to one, in all three patterns) AND on the notes the dialog writes,
  // because a divider that is right about proportions and wrong about where it
  // splices them is still wrong.
  const splitRun = await page.evaluate(async () => {
    const E = _masterEng, o = {};
    const L = () => window.__Lv2(E);
    const keep = JSON.parse(JSON.stringify({ part: L().part }));
    const mode0 = window._v2.modeOf(L());
    L().part.kind = 'recorded'; L().part.bars = 2;
    L().part.notes = [{ t: 0, midi: 60, dur: 0.5, vel: 80 }, { t: 0.5, midi: 64, dur: 0.25 }];
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click();
      await zz(350);
    }
    const host = document.getElementById('bloom-v2-layers');
    if (host) host._sig = '';
    window._v2.render(E); await zz(350);
    // THE ARITHMETIC, asked of the divider itself. A weight list that does not
    // sum to one is the "same total length" promise broken before any note is
    // written, and it is the one claim all three patterns share.
    const w = (k, n, c, sp, rl) => window._v2.splitWeights(k, n, c, sp, rl);
    const sum = (a) => Math.round(a.reduce((x, y) => x + y, 0) * 1e6) / 1e6;
    o.sums = [sum(w('equal', 7)), sum(w('custom', 5, [5, 1, 2, 1, 1])),
      sum(w('random', 6, null, 100, 3))];
    // AND WITH THE FLOOR BINDING, which is the only case the SECOND normalise
    // pass exists for — a floor applied to shares that already sum to one
    // breaks the sum, so without it 1000:1 overflows the note by 1.5%. The
    // ordinary fixtures never reach it (no share of 16 or fewer falls under
    // 1/64), so a check built on them passes with that pass deleted — it did.
    const wf = w('custom', 2, [1000, 1]);
    o.floorSum = sum(wf);
    o.floorMin = Math.round(Math.min.apply(null, wf) * 1e5) / 1e5;
    o.equal = w('equal', 4).map((v) => Math.round(v * 1e4) / 1e4).join(',');
    // CUSTOM is relative sizes scaled to fit — 3:1:1 is 60/20/20 of the note
    o.custom = w('custom', 3, [3, 1, 1]).map((v) => Math.round(v * 1e4) / 1e4).join(',');
    // …and RANDOM's own left end IS equal division, which is what the slider says
    o.rand0 = w('random', 4, null, 0, 1).map((v) => Math.round(v * 1e4) / 1e4).join(',');
    const rA = w('random', 4, null, 100, 1);
    o.randRepeats = JSON.stringify(rA) === JSON.stringify(w('random', 4, null, 100, 1));
    o.randRolls = JSON.stringify(rA) !== JSON.stringify(w('random', 4, null, 100, 2));
    // …and it is genuinely dramatic at the top, or the slider's right end says
    // nothing (measured 1.7× before the exponent was raised — not "dramatic")
    const rr = [];
    for (let i = 1; i <= 25; i++) { const x = w('random', 4, null, 100, i); rr.push(Math.max.apply(null, x) / Math.min.apply(null, x)); }
    rr.sort((a, b) => a - b);
    o.randRatio = Math.round(rr[12] * 100) / 100;
    // ── THE DOOR IS THE NOTE EDITOR'S OWN BUTTON (2026-09-12) ──────────
    // RESTATED: Split was a fifth MODE, and this block used to switch the
    // picker to it, assert a drag and the pencil both stood down, and then
    // click the note. All three of those clauses were about a mode that no
    // longer exists — a tap on a note ALREADY opens the note, so the divider is
    // a button in the editor. What is pinned now is the DOOR: the mode select
    // must NOT offer split, and ✂ Split… must be in the editor and open the
    // dialog. (The stand-down clauses are dropped rather than moved: in Edit a
    // drag legitimately MOVES the note, which `test:vizdrag` owns.)
    const sel = card().querySelector('.v2-modepick');
    o.hasOpt = !!(sel && [...sel.options].some((x) => x.value === 'split'));
    o.noSplitMode = !o.hasOpt;
    window._v2.vizMode(L(), 'edit');
    if (host) host._sig = '';
    window._v2.render(E); await zz(320);
    card().classList.remove('collapsed');
    o.mode = window._v2.modeOf(L());
    const cv = () => card().querySelector('.v2-vizcv');
    const hit0 = () => (cv()._hits || [])[0];
    const rc = () => cv().getBoundingClientRect();
    // a tap on the note opens the EDITOR…
    const h1 = hit0(), r1 = rc();
    cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r1.left + h1.x + h1.w / 2, clientY: r1.top + h1.y + h1.h / 2 }));
    await zz(330);
    const ed = () => document.querySelector('.v2-neinline');
    o.edOpen = !!(ed() && !ed().hidden);
    const sb = ed() && ed().querySelector('[data-na="split"]');
    o.hasBtn = !!sb;
    o.btnFace = sb ? sb.textContent.trim() : null;
    // …and ✂ Split… opens the divider, with the editor closed behind it
    if (sb) { sb.click(); await zz(360); }
    o.edClosed = !!(ed() && ed().hidden);
    const md = () => document.querySelector('.v2-split-modal');
    o.opened = !!md();
    o.patterns = md() ? [...md().querySelectorAll('.v2-splitkind')].map((x) => x.textContent.trim()).join(',') : null;
    // …and the PREVIEW is in the note's own beats, not the cycle's — it read
    // twice the note's length until the weight was scaled by the duration
    o.prev = md() ? [...md().querySelectorAll('.v2-split-seg b')]
      .reduce((a, x) => a + (+x.textContent || 0), 0) : 0;
    if (md()) {
      const up = md().querySelector('.v2-splitstep[data-d="1"]');
      up.click(); await zz(120);            // 3 → 4
      md().querySelector('.v2-splitgo').click(); await zz(400);
    }
    o.gone = !md();
    const N = L().part.notes;
    o.n = N.length;
    o.times = N.map((x) => Math.round(x.t * 1e4) / 1e4).join(',');
    o.durs = N.map((x) => Math.round(x.dur * 1e4) / 1e4).join(',');
    // the ORIGINAL SPAN, exactly — and the note after it never moved.
    // GUARDED: with the door poisoned the split never happens, and an
    // unguarded `N[3].t` takes the whole run down with a harness error instead
    // of failing by name — this file's own rule about probes under test.
    const at = (i) => N[i] || {};
    o.spanExact = N.length >= 5 && Math.abs(at(0).t) < 1e-9 &&
      Math.abs((at(3).t + at(3).dur) - 0.5) < 1e-9;
    o.tailKept = N.length >= 5 && Math.abs(at(4).t - 0.5) < 1e-9 && at(4).midi === 64;
    // A SPLIT IS A DIVISION OF ONE NOTE, so what the note WAS comes along
    o.velKept = N.length >= 5 && N.slice(0, 4).every((x) => x.vel === 80) && at(4).vel == null;
    o.pitchKept = N.length >= 5 && N.slice(0, 4).every((x) => x.midi === 60);
    // put it all back
    window._v2.vizMode(L(), mode0);
    L().part = JSON.parse(JSON.stringify(keep.part));
    E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  // ── …AND IN PITCH ───────────────────────────────────────────────────────
  // A division in time alone makes a repeated note; the second axis is what
  // turns it into a figure. STEPS walks the SOUNDING SCALE, not semitones —
  // that is the difference between an arpeggio and a chromatic run, and it is
  // the claim with teeth here: +2 in C major must be C E G, not C D E.
  const splitPRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    const svAll = JSON.parse(JSON.stringify(L()));
    const svKey = [cfg.keyOn, cfg.keyRoot, cfg.keyScale, cfg.keyFollow];
    const P = (k, n, m, x) => window._v2.splitPitches(k, n, m, x);
    const C = [0, 2, 4, 5, 7, 9, 11].reduce((a, x) => (a[x] = 1, a), {});
    o.same = P('same', 4, 60).join(',');
    o.up = P('steps', 4, 60, { step: 1, pcs: C }).join(',');
    o.thirds = P('steps', 4, 60, { step: 2, pcs: C }).join(',');
    o.down = P('steps', 3, 60, { step: -1, pcs: C }).join(',');
    // NO KEY = semitones, said outright rather than inventing a scale
    o.chrom = P('steps', 4, 60, { step: 1, pcs: null }).join(',');
    o.custom = P('custom', 3, 60, { custom: [0, 7, 12] }).join(',');
    const rA = P('random', 5, 60, { scatter: 100, roll: 1, pcs: C });
    o.randInKey = rA.every((m) => C[((m % 12) + 12) % 12] === 1);
    o.randRepeats = P('random', 5, 60, { scatter: 100, roll: 1, pcs: C }).join(',') === rA.join(',');
    o.randRolls = P('random', 5, 60, { scatter: 100, roll: 2, pcs: C }).join(',') !== rA.join(',');
    o.rand0 = P('random', 4, 60, { scatter: 0, roll: 1, pcs: C }).join(',');
    // END TO END through the dialog, in a real key
    cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'major'; cfg.keyFollow = false;
    L().part.kind = 'recorded'; L().part.bars = 2;
    L().part.notes = [{ t: 0, midi: 60, dur: 0.5, vel: 80 }, { t: 0.5, midi: 64, dur: 0.25 }];
    // THE DOOR IS THE NOTE EDITOR'S BUTTON (2026-09-12) — tap the note to open
    // it, then ✂ Split…. This used to switch the picker to a `split` mode,
    // which is gone.
    window._v2.vizMode(L(), 'edit');
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click(); await zz(350);
    }
    const host = document.getElementById('bloom-v2-layers'); if (host) host._sig = '';
    window._v2.render(E); await zz(400);
    const cv = card().querySelector('.v2-vizcv');
    const h0 = (cv._hits || [])[0], rc = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: rc.left + h0.x + h0.w / 2, clientY: rc.top + h0.y + h0.h / 2 }));
    await zz(400);
    const sbtn = document.querySelector('.v2-neinline [data-na="split"]');
    if (sbtn) { sbtn.click(); await zz(400); }
    const m = document.querySelector('.v2-split-modal');
    o.open = !!m;
    o.btns = m ? [...m.querySelectorAll('.v2-splitpk')].map((x) => x.textContent.trim()).join(',') : null;
    // THE LADDER IT WALKS IS NAMED — a control that means two things without
    // saying which is the trap this card keeps closing
    o.ladder = m ? (m.querySelector('.v2-split-scalab') || {}).textContent : null;
    if (m) {
      m.querySelector('.v2-splitpk[data-v="steps"]').click(); await zz(150);
      m.querySelector('.v2-splitpstep[data-d="1"]').click(); await zz(150);
      o.by = m.querySelector('.v2-split-pn').textContent;
      // the preview NAMES the pieces once pitch varies
      o.prev = [...m.querySelectorAll('.v2-split-seg b')].map((x) => x.textContent).join(',');
      o.overflow = Math.max(0, m.scrollWidth - m.clientWidth);
      o.clipped = [...m.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && e.scrollWidth - e.clientWidth > 1).length;
      m.querySelector('.v2-splitgo').click(); await zz(400);
    }
    const N = L().part.notes;
    o.after = N.map((n) => Math.round(n.t * 1e4) / 1e4 + '/' + n.midi).join(' ');
    // the span is still exact and the note after it never moved (guarded, so a
    // poisoned door fails by NAME rather than throwing out of the run)
    const at2 = (i) => N[i] || {};
    o.spanExact = N.length >= 4 && Math.abs(at2(0).t) < 1e-9 &&
      Math.abs((at2(2).t + at2(2).dur) - 0.5) < 1e-9;
    o.tailKept = N.length >= 4 && Math.abs(at2(3).t - 0.5) < 1e-9 && at2(3).midi === 64;
    const Lr = L();
    Object.keys(Lr).forEach((k) => { delete Lr[k]; });
    Object.assign(Lr, svAll);
    cfg.keyOn = svKey[0]; cfg.keyRoot = svKey[1]; cfg.keyScale = svKey[2]; cfg.keyFollow = svKey[3];
    E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('✂ Split changes PITCH too — steps walk the sounding scale, not semitones',
    splitPRun.same === '60,60,60,60' &&
    splitPRun.up === '60,62,64,65' &&          // C D E F — scale steps
    splitPRun.thirds === '60,64,67,71' &&      // C E G B — an arpeggio out of one note
    splitPRun.down === '60,59,57' &&
    splitPRun.chrom === '60,61,62,63' &&       // no key: semitones, honestly
    splitPRun.custom === '60,67,72' &&
    splitPRun.randInKey && splitPRun.randRepeats && splitPRun.randRolls &&
    splitPRun.rand0 === '60,60,60,60',
    JSON.stringify(splitPRun));
  ok('…and the dialog drives it — the preview names the pieces, the span holds',
    splitPRun.open && splitPRun.btns === 'Same,Steps,Custom,Random' &&
    splitPRun.ladder === 'scale steps' && splitPRun.by === '+2' &&
    splitPRun.prev === 'C4,E4,G4' &&
    splitPRun.after === '0/60 0.1667/64 0.3333/67 0.5/64' &&
    splitPRun.spanExact && splitPRun.tailKept &&
    splitPRun.overflow === 0 && splitPRun.clipped === 0,
    JSON.stringify(splitPRun));

  // ── RANDOM SCATTERS OUT OF *SOMETHING* — Chromatic · Scale · Chord ──────
  // Scatter said how FAR and never out of WHAT: Random walked the sounding
  // scale and there was no way to ask for every semitone, or for the tones of
  // the chord under the note. One ladder walk serves all three (`stepScale`
  // indexes whatever pitch classes it is handed) so the pool only chooses the
  // SET — and Chord is the one that needs changes to exist, so it is rendered
  // and REFUSES WITH A REASON rather than hidden or silently inert.
  const splitPoolRun = await page.evaluate(async () => {
    const zz = window.__zz || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    const svAll = JSON.parse(JSON.stringify(L()));
    const svKey = [cfg.keyOn, cfg.keyRoot, cfg.keyScale, cfg.keyFollow];
    const P0 = JSON.parse(JSON.stringify(cfg.prog));
    const C = [0, 2, 4, 5, 7, 9, 11].reduce((a, x) => (a[x] = 1, a), {});
    const CH = { 0: 1, 4: 1, 7: 1 };
    const P = (k, n, m, x) => window._v2.splitPitches(k, n, m, x);
    const pcOf = (a) => [...new Set(a.map((m) => ((m % 12) + 12) % 12))].sort((x, y) => x - y);
    const base = { scatter: 100, roll: 3, pcs: C, chordPcs: CH };
    const chrom = P('random', 8, 69, Object.assign({}, base, { pool: 'chromatic' }));
    const scale = P('random', 8, 69, Object.assign({}, base, { pool: 'scale' }));
    const chord = P('random', 8, 69, Object.assign({}, base, { pool: 'chord' }));
    o.chromPcs = pcOf(chrom); o.scalePcs = pcOf(scale); o.chordPcs = pcOf(chord);
    // SCALE stays in key, CHORD stays inside the chord, CHROMATIC does neither
    o.scaleInKey = scale.every((m) => C[((m % 12) + 12) % 12] === 1);
    o.chordInChord = chord.every((m) => CH[((m % 12) + 12) % 12] === 1);
    o.chromOutOfKey = chrom.some((m) => !C[((m % 12) + 12) % 12]);
    // …and they are three DIFFERENT answers, not one wearing three names
    o.differ = new Set([chrom.join(','), scale.join(','), chord.join(',')]).size === 3;
    // THE DEFAULT IS UNCHANGED — no pool given is exactly what it always did
    o.legacySame = P('random', 8, 69, { scatter: 100, roll: 3, pcs: C }).join(',') === scale.join(',');
    // a 7-note scale keeps the old flat-7 span, so the scale case cannot drift
    o.spanKept = P('random', 6, 60, { scatter: 100, roll: 5, pcs: C }).join(',') ===
                 P('random', 6, 60, { scatter: 100, roll: 5, pcs: C, pool: 'scale' }).join(',');
    // ── THE DIALOG, through the real door, with and without changes
    cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'major'; cfg.keyFollow = false;
    const card = () => document.querySelector('.v2-layer');
    const host = document.getElementById('bloom-v2-layers');
    const openSplit = async () => {
      L().part.kind = 'recorded'; L().part.bars = 2; L().part.harmony = 'fixed';
      L().part.notes = [{ t: 0, midi: 69, dur: 0.5 }];
      window._v2.vizMode(L(), 'edit');
      E.getCfg();
      if (card() && card().classList.contains('collapsed')) {
        const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click(); await zz(300);
      }
      if (host) host._sig = '';
      window._v2.render(E); await zz(380);
      const cv = card().querySelector('.v2-vizcv');
      const h0 = (cv._hits || [])[0]; if (!h0) return null;
      const rc = cv.getBoundingClientRect();
      cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: rc.left + h0.x + h0.w / 2, clientY: rc.top + h0.y + h0.h / 2 }));
      await zz(330);
      const sb2 = document.querySelector('.v2-neinline [data-na="split"]');
      if (sb2) { sb2.click(); await zz(360); }
      return document.querySelector('.v2-split-modal');
    };
    const readPools = () => [...document.querySelectorAll('.v2-splitpool')]
      .map((b) => b.getAttribute('data-v') + (b.classList.contains('on') ? ':on' : '') +
                  (b.classList.contains('is-na') ? ':na' : '')).join(',');
    // (a) WITH changes — Chord is usable and lands on chord tones
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; E.getCfg();
    let m = await openSplit();
    o.opened = !!m;
    if (m) {
      o.rowHiddenBefore = (m.querySelector('.v2-split-prand') || {}).getBoundingClientRect
        ? m.querySelector('.v2-split-prand').getBoundingClientRect().height === 0 : null;
      m.querySelector('.v2-splitpk[data-v="random"]').click(); await zz(180);
      o.rowShown = document.querySelector('.v2-split-prand').getBoundingClientRect().height > 0;
      o.poolsWith = readPools();
      document.querySelector('.v2-splitpool[data-v="chord"]').click(); await zz(180);
      o.poolsAfter = readPools();
      o.lab = (document.querySelector('.v2-split-poollab') || {}).textContent || '';
      o.clipped = [...document.querySelectorAll('.v2-split-modal *')]
        .filter((e) => e.children.length === 0 && e.scrollWidth - e.clientWidth > 1).length;
      document.querySelector('.v2-splitgo').click(); await zz(360);
      o.madePcs = pcOf((L().part.notes || []).map((n) => n.midi));
    }
    // (b) NO changes — Chord is marked n/a and a press refuses with a reason
    cfg.prog.on = false; cfg.prog.chords = []; E.getCfg();
    m = await openSplit();
    if (m) {
      m.querySelector('.v2-splitpk[data-v="random"]').click(); await zz(180);
      o.poolsNo = readPools();
      document.querySelector('.v2-splitpool[data-v="chord"]').click(); await zz(220);
      o.poolsNoAfter = readPools();
      o.toast = (document.querySelector('.bloops-toast') || {}).textContent || '';
      const cn = document.querySelector('.v2-splitcancel'); if (cn) cn.click(); await zz(200);
    }
    o.gone = !document.querySelector('.v2-split-modal');
    // restore
    cfg.prog = P0;
    cfg.keyOn = svKey[0]; cfg.keyRoot = svKey[1]; cfg.keyScale = svKey[2]; cfg.keyFollow = svKey[3];
    const Lr = L();
    Object.keys(Lr).forEach((k) => { delete Lr[k]; });
    Object.assign(Lr, svAll);
    E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('✂ Split Random scatters out of Chromatic · Scale · Chord',
    splitPoolRun.scaleInKey && splitPoolRun.chordInChord && splitPoolRun.chromOutOfKey &&
    splitPoolRun.differ &&
    // the chord pool uses ONLY the chord's tones — the claim, not "it moved"
    splitPoolRun.chordPcs.join(',') === '0,4,7' &&
    // and the pool-less call is byte-identical to Scale, so nothing drifted
    splitPoolRun.legacySame && splitPoolRun.spanKept,
    JSON.stringify(splitPoolRun));
  ok('…and Chord needs changes — offered, marked, and it REFUSES with the reason',
    splitPoolRun.opened && splitPoolRun.gone &&
    // the row appears only under Random
    splitPoolRun.rowHiddenBefore === true && splitPoolRun.rowShown &&
    // with changes: three options, Scale lit, Chord usable, and it takes
    splitPoolRun.poolsWith === 'chromatic,scale:on,chord' &&
    splitPoolRun.poolsAfter === 'chromatic,scale,chord:on' &&
    splitPoolRun.madePcs.every((pc) => [0, 4, 7].indexOf(pc) >= 0) &&
    // without changes: marked n/a, the press does NOT select it, and says why
    splitPoolRun.poolsNo === 'chromatic,scale:on,chord:na' &&
    splitPoolRun.poolsNoAfter === 'chromatic,scale:on,chord:na' &&
    // the refusal must name the CONDITION and the way out, not merely appear
    /changes/i.test(splitPoolRun.toast) && /progression/i.test(splitPoolRun.toast) &&
    splitPoolRun.clipped === 0,
    JSON.stringify(splitPoolRun));

  // ── THE DICE, AND THE PREVIEW AS A CONTROL ──────────────────────────────
  // 🎲 lived INSIDE the Sizes panel, so with Sizes on Equal and Pitch on Random
  // there was no way to roll the notes at all — one counter drives both axes and
  // its only button was behind one of them. And a rolled piece could not be
  // overruled: the preview named the pieces and answered to nothing.
  const splitPickRun = await page.evaluate(async () => {
    const zz = window.__zz || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const E = _masterEng, cfg = E.getCfg(), o = {};
    const L = () => window.__Lv2(E);
    const svAll = JSON.parse(JSON.stringify(L()));
    const svKey = [cfg.keyOn, cfg.keyRoot, cfg.keyScale, cfg.keyFollow];
    cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'major'; cfg.keyFollow = false;
    const card = () => document.querySelector('.v2-layer');
    const host = document.getElementById('bloom-v2-layers');
    L().part.kind = 'recorded'; L().part.bars = 2; L().part.harmony = 'fixed';
    L().part.notes = [{ t: 0, midi: 69, dur: 0.5 }];
    window._v2.vizMode(L(), 'edit');
    E.getCfg();
    if (card() && card().classList.contains('collapsed')) {
      const cb = card().querySelector('.ambient-collapse'); if (cb) cb.click(); await zz(300);
    }
    if (host) host._sig = '';
    window._v2.render(E); await zz(380);
    const cv = card().querySelector('.v2-vizcv');
    const h0 = (cv._hits || [])[0];
    if (!h0) return { err: 'no hit' };
    const rc = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: rc.left + h0.x + h0.w / 2, clientY: rc.top + h0.y + h0.h / 2 }));
    await zz(330);
    const sb3 = document.querySelector('.v2-neinline [data-na="split"]');
    if (sb3) { sb3.click(); await zz(360); }
    const m = document.querySelector('.v2-split-modal');
    o.opened = !!m;
    if (m) {
      const faces = () => [...document.querySelectorAll('.v2-split-seg b')].map((x) => x.textContent);
      const rollVis = () => { const r = document.querySelector('.v2-split-rerow');
        return r ? r.getBoundingClientRect().height > 0 : false; };
      const marks = () => [...document.querySelectorAll('.v2-split-seg')].map((x) =>
        (x.classList.contains('is-pin') ? 'P' : '-') + (x.classList.contains('on') ? 'S' : '-')).join(',');
      // NOTHING ROLLED = no dice; the moment PITCH is rolled it is there
      o.rollHiddenPlain = !rollVis();
      m.querySelector('.v2-splitpk[data-v="random"]').click(); await zz(180);
      o.rollShownOnPitch = rollVis();
      o.rollLab = (document.querySelector('.v2-split-rolllab') || {}).textContent;
      const f0 = faces();
      document.querySelector('.v2-splitroll').click(); await zz(180);
      const f1 = faces();
      o.rollMovedPitches = f0.join(',') !== f1.join(',');
      // A PIECE IS A CONTROL — tap it, and note + OCTAVE are separate steppers
      o.pickHidden = document.querySelector('.v2-split-pick').hidden;
      [...document.querySelectorAll('.v2-split-seg')][1].click(); await zz(180);
      o.pickShown = !document.querySelector('.v2-split-pick').hidden;
      o.lab = (document.querySelector('.v2-split-picklab') || {}).textContent;
      o.unpinHiddenBefore = document.querySelector('.v2-splitunpin').style.display === 'none';
      const nameNow = () => (document.querySelector('.v2-split-nname') || {}).textContent;
      const octNow = () => (document.querySelector('.v2-split-oct') || {}).textContent;
      const n0 = nameNow(), o0 = octNow();
      document.querySelector('.v2-splitnstep[data-d="1"]').click(); await zz(150);
      o.noteMoved = nameNow() !== n0;
      // …the note face CARRIES the octave, which is what makes six pieces on
      // the same letter in different octaves readable at all
      o.nameHasOctave = /^[A-G][#b]?-?\d$/.test(nameNow());
      const nAfterStep = nameNow();
      document.querySelector('.v2-splitostep[data-d="1"]').click(); await zz(150);
      o.octUp = (octNow() | 0) === ((o0 | 0) + (nAfterStep === n0 ? 1 : 1)) ||
                (octNow() | 0) > (o0 | 0);
      // an octave jump keeps the LETTER and changes only the number
      o.sameLetter = nameNow().replace(/-?\d+$/, '') === nAfterStep.replace(/-?\d+$/, '');
      o.marks = marks();
      o.unpinShownAfter = document.querySelector('.v2-splitunpin').style.display !== 'none';
      // THE HAND SURVIVES A RE-ROLL, and only the hand
      const pinFace = faces()[1];
      document.querySelector('.v2-splitroll').click(); await zz(180);
      o.pinKept = faces()[1] === pinFace;
      // ↺ is the way back
      document.querySelector('.v2-splitunpin').click(); await zz(160);
      o.cleared = [...document.querySelectorAll('.v2-split-seg')]
        .every((x) => !x.classList.contains('is-pin'));
      // and what is COMMITTED is what the face said
      [...document.querySelectorAll('.v2-split-seg')][0].click(); await zz(150);
      document.querySelector('.v2-splitostep[data-d="-1"]').click(); await zz(150);
      const want = faces()[0];
      o.clipped = [...document.querySelectorAll('.v2-split-modal *')]
        .filter((e2) => e2.children.length === 0 && e2.scrollWidth - e2.clientWidth > 1).length;
      document.querySelector('.v2-splitgo').click(); await zz(360);
      const pn = (mm) => { try { return _AMB_CHROM[(((mm % 12) + 12) % 12)] + (Math.floor(mm / 12) - 1); }
        catch (e) { return String(mm); } };
      o.storedFirst = pn((((L().part.notes || [])[0]) || {}).midi | 0);
      o.commitMatches = o.storedFirst === want;
    }
    o.gone = !document.querySelector('.v2-split-modal');
    cfg.keyOn = svKey[0]; cfg.keyRoot = svKey[1]; cfg.keyScale = svKey[2]; cfg.keyFollow = svKey[3];
    const Lr = L();
    Object.keys(Lr).forEach((k) => { delete Lr[k]; });
    Object.assign(Lr, svAll);
    E.getCfg();
    if (host) host._sig = '';
    window._v2.render(E); await zz(250);
    return o;
  });
  ok('✂ Split: one 🎲 for whatever is rolled — it appears for PITCH too',
    splitPickRun.opened && splitPickRun.rollHiddenPlain &&
    splitPickRun.rollShownOnPitch && splitPickRun.rollLab === 'new notes' &&
    splitPickRun.rollMovedPitches,
    JSON.stringify(splitPickRun));
  ok('…and a piece of the preview is a control — note, OCTAVE, and the hand wins',
    splitPickRun.pickHidden === true && splitPickRun.pickShown &&
    splitPickRun.lab === 'Piece 2' &&
    // the face names the octave, the two steppers do different things
    splitPickRun.nameHasOctave && splitPickRun.noteMoved &&
    splitPickRun.octUp && splitPickRun.sameLetter &&
    // the pinned piece is MARKED, and ↺ appears only once there is a pin
    splitPickRun.marks === '--,PS,--' &&
    splitPickRun.unpinHiddenBefore && splitPickRun.unpinShownAfter &&
    // a re-roll leaves it alone, ↺ gives it back, and the commit is the face
    splitPickRun.pinKept && splitPickRun.cleared &&
    splitPickRun.commitMatches && splitPickRun.gone && splitPickRun.clipped === 0,
    JSON.stringify(splitPickRun));

  ok('✂ Split divides a note into several — the same total length',
    splitRun.noSplitMode && splitRun.mode === 'edit' && splitRun.opened && splitRun.gone &&
    splitRun.patterns === 'Equal,Custom,Random' &&
    splitRun.sums.every((v) => Math.abs(v - 1) < 1e-6) &&
    Math.abs(splitRun.floorSum - 1) < 1e-6 && splitRun.floorMin > 0.014 &&
    splitRun.equal === '0.25,0.25,0.25,0.25' && splitRun.custom === '0.6,0.2,0.2' &&
    splitRun.rand0 === '0.25,0.25,0.25,0.25' &&
    splitRun.randRepeats && splitRun.randRolls && splitRun.randRatio > 2.5 &&
    // 4 pieces of a 0.5 note in a 2-bar cycle = 1 beat each, and the preview
    // says so in the NOTE's beats (4 total), not the cycle's
    splitRun.n === 5 && splitRun.times === '0,0.125,0.25,0.375,0.5' &&
    splitRun.durs === '0.125,0.125,0.125,0.125,0.25' &&
    Math.abs(splitRun.prev - 4) < 0.05 &&
    splitRun.spanExact && splitRun.tailKept && splitRun.velKept && splitRun.pitchKept,
    JSON.stringify(splitRun));
  // RESTATED 2026-09-12: this pinned "a CLICK is the only gesture" — a claim
  // about a MODE that is gone. The door is the note editor's own button now,
  // which is strictly stronger: it proves the mode select does NOT offer split,
  // that the tap opens the EDITOR, that ✂ Split… is there and named, and that
  // pressing it opens the divider with the editor closed behind it.
  ok('…and its door is the note editor\u2019s \u2702 Split\u2026 button, not a mode',
    splitRun.noSplitMode && splitRun.edOpen && splitRun.hasBtn &&
    /Split/.test(splitRun.btnFace || '') && splitRun.edClosed && splitRun.opened,
    JSON.stringify({ noSplitMode: splitRun.noSplitMode, edOpen: splitRun.edOpen,
      hasBtn: splitRun.hasBtn, btnFace: splitRun.btnFace, edClosed: splitRun.edClosed,
      opened: splitRun.opened }));

  // ---- A GENERATED PART IS EDITABLE BY HAND, TOO -------------------------
  // Both gestures used to require a WRITTEN part, which is not the one you are
  // usually looking at: dragging a note on a generated part did NOTHING (there
  // are no stored notes to move) and only the RELEASE locked and rebuilt the
  // card, so the picture moved once you let go — reported as the note "jumping
  // around like crazy". Both now lock on the grab, the same act a tap already
  // performed, and say so.
  const liveEditRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, h = document.getElementById('bloom-v2-layers');
    const L = () => window.__Lv2(E);
    const sv = JSON.stringify(L().part);
    const live = async () => {
      const p2 = L().part;
      p2.kind = 'live'; delete p2.notes; p2.bars = 2;
      p2.rhythm = { kind: 'euclid', steps: 16, pulses: 5 };
      p2.pitch = { kind: 'walk', span: 8 };
      E.getCfg();
      document.querySelector('.v2-layer').classList.remove('collapsed');
      h._sig = ''; window._v2.render(E); await wait(400);
      const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
      const g = (window.__toContent(), null);
      if (g) { g.click(); await wait(300); }
      c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
      await wait(180);
    };
    const o = {};
    await live();
    // THE DRAW DOOR IS THERE ON A GENERATED PART — it used to render only on a
    // written one, so on the card you are usually looking at there was no way
    // to draw a note at all.
    o.drawOnLive = !!document.querySelector('.v2-layer .v2-modepick');
    o.kindBefore = L().part.kind;
    if (!o.drawOnLive) { try { L().part = JSON.parse(sv); E.getCfg(); } catch (e) {} return o; }
    (function () { const m2 = document.querySelector('.v2-layer .v2-modepick');
      m2.value = 'draw'; m2.dispatchEvent(new Event('input', { bubbles: true })); })();
    await wait(420);
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    cv.scrollIntoView({ block: 'center' }); await wait(150);
    const r = cv.getBoundingClientRect(), pg = cv._pitchGeo, geo = cv._plotGeo;
    // PICK A ROW NO HIT BOX CLAIMS at the target x — a hardcoded row 64 was
    // CHANCE-DEPENDENT on the roll (the documented fixed-tap-point trap): a
    // take with a note near (0.8, 64) swallowed the click into its padded hit
    // box, so the pencil "did nothing" — editor open, nothing drawn — on some
    // session seeds and not others.
    const tx = geo.x0 + geo.w * 0.8;
    let row = -1;
    for (let m2 = pg.hiM - 1; m2 > pg.loM; m2--) {
      const y2 = pg.top + (pg.hiM - m2) * pg.rowH + pg.rowH / 2;
      const clear = !(cv._hits || []).some((x2) =>
        tx >= x2.x - 6 && tx <= x2.x + x2.w + 6 &&
        y2 >= x2.y - 9 && y2 <= x2.y + x2.h + 9);
      if (clear) { row = m2; break; }
    }
    o.row = row;
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + tx,
      clientY: r.top + pg.top + (pg.hiM - row) * pg.rowH + pg.rowH / 2 }));
    await wait(520);
    const p3 = L().part;
    o.kindAfter = p3.kind;
    o.notes = (p3.notes || []).map((n) => [Math.round(n.t * 100) / 100, n.midi, n.hx ? 1 : 0]);
    // FIND THE ADDED NOTE BY ITS DRAWN ROW, never its stored midi — the gate
    // deliberately carries a leftover transpose (its accumulated state is a
    // feature), and penAdd CORRECTS the stored value so the drawn note lands
    // on the clicked row: stored === row pins exactly the
    // land-where-the-shift-says behaviour that was Round 6's bug.
    const cells2 = window._v2.gridCells(L());
    const tc = Math.floor(0.8 * cells2) / cells2;
    const nAdd = (p3.notes || []).findIndex((x) => Math.abs(x.t - tc) < 1e-6);
    const cv2 = document.querySelector('.v2-layer .v2-vizcv');
    const hbAdd = nAdd >= 0 && (cv2._hits || []).find((x2) => x2.i === nAdd);
    o.drawnRow = hbAdd ? Math.round(hbAdd.midi) : null;
    o.drew = row > 0 && o.drawnRow === row;
    o.editorOpen = !!document.querySelector('.v2-layer .v2-neinline:not([hidden])');
    // …and the live SPEC survives, so ⚙ Generate instead still hands it back
    o.specKept = (p3.rhythm && p3.rhythm.kind) === 'euclid';
    try { const m3 = document.querySelector('.v2-layer .v2-modepick');
      m3.value = 'view'; m3.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    await wait(300);
    try { L().part = JSON.parse(sv); E.getCfg();
          h._sig = ''; window._v2.render(E); await wait(320);
          document.querySelector('.v2-layer').classList.remove('collapsed'); } catch (e) {}
    return o;
  });
  // THE ROLL IS NOT REDRAWN UNDER A GESTURE: GUARDED IN CODE, NOT GATED.
  // `vizFrame` skips a layer with a drag in progress, because that frame
  // repaints the roll once per cycle and a LIVE part rolls fresh notes each
  // time — the blocks would move under the finger. It is DEFENSIVE and
  // currently unobservable: every drag now LOCKS the part at the grab, so by
  // the time a gesture exists the notes are fixed and the repaint is a no-op.
  // A check for it was written and removed after its poison passed (holding a
  // note for three seconds of playback, sampling the axis: identical frames
  // with the guard deleted). Keep the guard — it costs nothing and the hazard
  // returns the moment a drag is allowed without locking — but do not re-add a
  // check without first proving it FAILS with the guard removed.

  // A DRAG ON A GENERATED PART LOCKS AND THEN MOVES THE NOTE. Before this it
  // did nothing at all — there are no stored notes to move — and only the
  // RELEASE locked and rebuilt the card, so the picture moved once you let go.
  const liveDragRun = await (async () => {
    const st = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
      const E = _masterEng, h = document.getElementById('bloom-v2-layers');
      const L = (E.getCfg().layers || [])[0];
      const sv = JSON.stringify(L.part);
      L.part.kind = 'live'; delete L.part.notes; L.part.bars = 2;
      L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 5 };
      L.part.pitch = { kind: 'walk', span: 8 };
      L.on = true; L.present = true; E.getCfg();
      document.querySelector('.v2-layer').classList.remove('collapsed');
      h._sig = ''; window._v2.render(E); await wait(400);
      const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
      const g = (window.__toContent(), null);
      if (g) { g.click(); await wait(300); }
      c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' }); await wait(200);
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const r = cv.getBoundingClientRect();
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[0];
      return hb ? { x: r.left + hb.x + hb.w / 2, y: r.top + hb.y + 3, sv,
                    kind: L.part.kind, midi: Math.round(hb.midi) } : { sv };
    });
    const o = { got: !!st.x, kindBefore: st.kind };
    if (st.x) {
      // TOWARD THE HEADROOM: the frozen window is EXACT now (no ±6
      // widening — the widening shifted every other note, which was the
      // reported defect), so a rolled note near the window's edge has a row
      // of room on that side and plenty on the other. Read the window, pick
      // the open side, expect one semitone per row in that direction.
      const held0 = await page.evaluate(() => {
        const cv = document.querySelector('.v2-layer .v2-vizcv');
        return { win: cv._pitchGeo };
      });
      const upRoom = held0.win.hiM - st.midi, dnRoom = st.midi - held0.win.loM;
      const sign = upRoom >= 6 ? 1 : -1;              // +1 = drag UP = midi rises
      await page.mouse.move(st.x, st.y);
      await page.mouse.down();
      // 8px arm: raw = i + 8/rowH lands mid-detent (k = ceil(raw − 0.85))
      // for every reading row height in play (5.15/5.33/6.31), with ≥0.3
      // rows of margin against CDP's integer coord rounding
      await page.mouse.move(st.x, st.y - sign * 8);   // past the threshold: arm (and lock)
      const held = await page.evaluate(() => {
        const cv = document.querySelector('.v2-layer .v2-vizcv');
        const L = (_masterEng.getCfg().layers || [])[0];
        return { kind: L.part.kind, n: (L.part.notes || []).length,
                 rowH: cv._pitchGeo.rowH };
      });
      o.kindAtGrab = held.kind; o.notes = held.n; o.sign = sign;
      const ms = [];
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(st.x, st.y - sign * (8 + i * held.rowH));
        await zz(50);
        ms.push(await page.evaluate(() => {
          const ns = (_masterEng.getCfg().layers || [])[0].part.notes;
          return ns && ns.length ? ns.slice().sort((a, b) => a.t - b.t)[0].midi : null;
        }));
      }
      await page.mouse.up();
      await zz(420);
      o.steps = ms;
      o.deltas = ms.slice(1).map((v, i) => (v == null || ms[i] == null) ? null : (v - ms[i]) * sign);
      o.specKept = await page.evaluate(() =>
        ((_masterEng.getCfg().layers || [])[0].part.rhythm || {}).kind === 'euclid');
    }
    await page.evaluate(async (sv) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
      const E = _masterEng, h = document.getElementById('bloom-v2-layers');
      try { (E.getCfg().layers || [])[0].part = JSON.parse(sv); E.getCfg(); } catch (e) {}
      h._sig = ''; window._v2.render(E); await wait(320);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    }, st.sv);
    return o;
  })();
  ok('a drag on a GENERATED part locks the take and then moves the note',
    liveDragRun.got && liveDragRun.kindBefore === 'live' &&
    liveDragRun.kindAtGrab === 'recorded' && liveDragRun.notes > 0 &&
    liveDragRun.deltas.length === 4 && liveDragRun.deltas.every((d) => d === 1) &&
    liveDragRun.specKept,
    JSON.stringify(liveDragRun));

  ok('a GENERATED part can be drawn into — the door is there, and it locks first',
    liveEditRun.drawOnLive && liveEditRun.kindBefore === 'live' &&
    liveEditRun.kindAfter === 'recorded' && liveEditRun.drew &&
    liveEditRun.editorOpen && liveEditRun.specKept,
    JSON.stringify(liveEditRun));

  // ---- A REBUILD DOES NOT THROW THE PAGE TO THE TOP: NOT GATED, AND WHY ---
  // `V2.render` now records the scroll before it replaces the host's innerHTML
  // and puts it back at the end. Verified by DIRECT MEASUREMENT at 390px —
  // scrolled to the bottom, then a forced rebuild: without the restore 761 → 0
  // (1 card), 1794 → 0 (2), 2828 → 0 (3); with it, held in all three.
  //
  // A CHECK FOR IT WAS WRITTEN AND REMOVED, because it passed its own poison
  // and this file's rule is that such a check is worse than none. Four
  // versions were tried — a programmatic sig change, a forced `_sig = ''`, the
  // real `.ambient-toggle` click, and scrolling to the exact bottom rather
  // than near it — and every one held its position with the restore deleted.
  // It is NOT that the environment cannot clamp: emptying the host by hand
  // here reads `scrollY 0, max 0` and re-filling it does not come back, so the
  // clamp is available. What the gate does not reproduce is whatever forces a
  // LAYOUT mid-rebuild (the sheet reopen moving group bodies is the suspect);
  // by the time these checks run the card's sheet state is settled and the
  // rebuild never exposes the short page. Do not re-add a check of this shape
  // without first proving it FAILS with the restore removed.

  // ---- A LINE IS NEVER CHOKED, WRITTEN OR GENERATED ----------------------
  // The chord choke releases a note by the next change so a pad does not ring
  // three chords later. A MELODY must be exempt — its note length comes from
  // its rhythm, not the chord grid — and that exemption used to be LIVE-only,
  // on the reasoning that a written part's `pitch.kind` names the rules rather
  // than the notes. Reported the moment editing notes by hand became worth
  // doing (drag, resize, add and the piano-key re-pitch all lock the take
  // first): "the 2nd and 3rd notes are getting extremely truncated again on
  // play press". A written part's NOTES answer it exactly, so they do.
  //
  // ASKED OF THE CHOKE ITSELF. A `playNote` wrapper records the duration
  // ARGUMENT and the choke mutates playNote's own local afterwards, so audio
  // that is being cut measures as untouched (the documented trap).
  const chokeRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng;
    const c0 = E.getCfg();
    const sv = { prog: JSON.stringify(c0.prog || null), bpm: c0.bpm, bpc: c0.barsPerChord,
                 part: JSON.stringify((c0.layers || [])[0].part),
                 cfg: E._cfg, pa: E._progAnchor, ps: E._playStartAt, bg: E._barGridAnchor };
    c0.bpm = 120; c0.barsPerChord = 1;
    c0.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] },
                                   { root: 5, intervals: [0, 4, 7] },
                                   { root: 7, intervals: [0, 4, 7] }] };
    const L0 = (c0.layers || [])[0]; L0.on = true; L0.present = true;
    // THE CHOKE'S PRECONDITION, stated: Ring out off. ▬ Sustain turns it on
    // (2026-09-16), so a layer an earlier check made a Sustain rings — which is
    // the feature, not the thing measured here.
    sv.ring = L0.ring; delete L0.ring;
    E.getCfg();
    // the clock a play press would set — the choke resolves the boundary off it
    E._cfg = E.getCfg(); E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    await wait(60);
    const set = (mut) => { const c = E.getCfg(); mut((c.layers || [])[0]);
                           E.getCfg(); E._cfg = E.getCfg(); };
    // three onsets across one 2 s chord, every note an even 1400 ms: a cut
    // shows as the third one landing near the boundary at ~588
    const row = () => {
      const L2 = (E.getCfg().layers || [])[0];
      return [0, 0.35, 0.7].map((f) => {
        try { return Math.round(window._ambNoteChoke('v2:' + (L2.id | 0), f * 2, 1400, {})); }
        catch (e) { return -1; }
      });
    };
    const o = {};
    set((L) => { L.part.kind = 'live'; L.part.bars = 3;
      L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4 };
      L.part.pitch = { kind: 'walk', span: 8 }; });
    o.liveLine = row();
    set((L) => { L.part.pitch = { kind: 'chord', voices: 3 }; });
    o.liveChord = row();
    // THE REGRESSION: the same line, locked. Its notes are unchanged; only
    // `kind` moved, and that used to be enough to start cutting it.
    set((L) => { L.part.kind = 'recorded'; L.part.pitch = { kind: 'walk', span: 8 };
      L.part.notes = [{ t: 0, midi: 60, dur: 0.23 }, { t: 0.35, midi: 62, dur: 0.23 },
                      { t: 0.7, midi: 64, dur: 0.23 }]; });
    o.writtenLine = row();
    // …and the NOTES outrank the rules in both directions: a one-at-a-time
    // part whose spec still says `chord` is a line, and a stacked one whose
    // spec says `walk` is harmony.
    set((L) => { L.part.pitch = { kind: 'chord', voices: 3 }; });
    o.writtenLineChordRules = row();
    set((L) => { L.part.pitch = { kind: 'walk', span: 8 };
      L.part.notes = [{ t: 0, midi: 60, dur: 0.23 }, { t: 0, midi: 64, dur: 0.23 },
                      { t: 0.7, midi: 62, dur: 0.23 }, { t: 0.7, midi: 65, dur: 0.23 }]; });
    o.writtenStack = row();
    // a STRUM is harmony, not a very fast line — onsets inside a 64th note
    set((L) => { L.part.notes = [{ t: 0, midi: 60, dur: 0.23 }, { t: 0.004, midi: 64, dur: 0.23 },
                                 { t: 0.7, midi: 67, dur: 0.23 }]; });
    o.writtenStrum = row();
    set((L) => { L.part.notes = [{ t: 0.7, midi: 60, dur: 0.23 }]; });
    o.writtenOne = row();
    // …put everything back, or every later check runs under a progression
    try {
      const c = E.getCfg();
      c.prog = sv.prog === 'null' ? undefined : JSON.parse(sv.prog);
      c.bpm = sv.bpm; c.barsPerChord = sv.bpc;
      (c.layers || [])[0].part = JSON.parse(sv.part);
      E.getCfg();
      E._cfg = sv.cfg; E._progAnchor = sv.pa; E._playStartAt = sv.ps; E._barGridAnchor = sv.bg;
    } catch (e) {}
    return o;
  });
  const even = (a) => Array.isArray(a) && a.length === 3 && a.every((x) => x === 1400);
  const cut = (a) => Array.isArray(a) && a[0] === 1400 && a[1] === 1400 && a[2] > 0 && a[2] < 900;
  ok('a LINE is never choked — written or generated — and harmony still is',
    even(chokeRun.liveLine) && cut(chokeRun.liveChord) &&
    even(chokeRun.writtenLine) && even(chokeRun.writtenLineChordRules) &&
    even(chokeRun.writtenOne) &&
    cut(chokeRun.writtenStack) && cut(chokeRun.writtenStrum),
    JSON.stringify(chokeRun));

  // …AND IT ASKS THE RECORD THAT IS SOUNDING, NOT THE ONE ON THE CARD
  // (2026-09-10). Line-vs-harmony is decided from a record's OWN notes, and
  // for a per-part layer it read `L.part` — the record being EDITED — so
  // whichever part you had selected decided whether every OTHER part's notes
  // were cut: a part holding a single-note LINE was choked at every change
  // because the edited part held a chord. Reported inside "a bunch of events
  // are truncated". Pinned in BOTH directions, or it would pass with the
  // records the other way round.
  const chokePartRun = await page.evaluate(async () => { try {
    const E = _masterEng, L = () => window.__Lv2(E);
    const c0 = E.getCfg();
    const sv = { prog: JSON.stringify(c0.prog || null), bpm: c0.bpm, bpc: c0.barsPerChord,
      part: JSON.stringify(L().part), pf: L().partFor,
      parts: L().parts ? JSON.stringify(L().parts) : null,
      all: L().partAll ? JSON.stringify(L().partAll) : null,
      cfg: E._cfg, pa: E._progAnchor, ps: E._playStartAt, bg: E._barGridAnchor };
    c0.bpm = 120; c0.barsPerChord = 1;
    c0.prog = { on: true, parts: [{ name: 'A', len: 4 }, { name: 'B', len: 4 }],
      chords: [0, 5, 7, 9, 0, 3, 5, 7].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    L().on = true; L().present = true;
    sv.ring = L().ring; delete L().ring;       // the choke's precondition (see chokeRun)
    L().part.kind = 'recorded'; L().part.bars = 4; L().part.notes = [{ t: 0, midi: 60, dur: 0.9 }];
    L().partFor = 0; L().parts = {}; delete L().partAll;
    E.getCfg();
    E._cfg = E.getCfg(); E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const CHORD = [{ t: 0, midi: 60, dur: 0.9 }, { t: 0, midi: 64, dur: 0.9 }, { t: 0, midi: 67, dur: 0.9 }];
    const LINE = [{ t: 0, midi: 72, dur: 0.9 }];
    const st = { startAt: 0 }, o = {};
    const run = (edited, other) => {
      L().part.notes = JSON.parse(JSON.stringify(edited));
      L().parts['1'].notes = JSON.parse(JSON.stringify(other));
      E.getCfg();
      const Lr = L(), r = {};
      [['p0', 0.001], ['p1', 8.001]].forEach(([nm, t0]) => {
        const w = window._v2.cycleWindowAt(Lr, E, E.getCfg(), t0, st);
        const ns = window._v2.notesFor(Lr, { E, cfg: E.getCfg(), key: 'v2:' + (Lr.id | 0),
          cycleStart: w.cs, cycleSec: w.cyc, pi: (w.pi | 0) });
        r[nm] = ns.map((n) => Math.round(window._ambNoteChoke('v2:' + (Lr.id | 0), n.at, n.durMs, {})));
      });
      return r;
    };
    o.chordEdited = run(CHORD, LINE);   // part 0 harmony, part 1 a line
    o.lineEdited = run(LINE, CHORD);    // …and the other way round
    try {
      const c9 = E.getCfg();
      if (sv.prog === 'null') delete c9.prog; else c9.prog = JSON.parse(sv.prog);
      c9.bpm = sv.bpm; c9.barsPerChord = sv.bpc;
      L().part = JSON.parse(sv.part);
      if (Number.isFinite(sv.pf)) L().partFor = sv.pf; else delete L().partFor;
      if (sv.parts) L().parts = JSON.parse(sv.parts); else delete L().parts;
      if (sv.all) L().partAll = JSON.parse(sv.all); else delete L().partAll;
      E.getCfg();
      E._cfg = sv.cfg; E._progAnchor = sv.pa; E._playStartAt = sv.ps; E._barGridAnchor = sv.bg;
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  {
    // a chord asks for 7200ms over a 2000ms change, so harmony lands just under
    // one change and a line keeps its whole length
    const held = (a) => Array.isArray(a) && a.length && a.every((x) => x === 7200);
    const held1 = (a) => Array.isArray(a) && a.length === 1 && a[0] === 7200;
    const cutAll = (a) => Array.isArray(a) && a.length === 3 && a.every((x) => x > 0 && x < 2100);
    const r = chokePartRun || {};
    ok('the choke judges the record that is SOUNDING, not the one being edited',
      !r.err && r.chordEdited && r.lineEdited &&
      cutAll(r.chordEdited.p0) && held1(r.chordEdited.p1) &&
      held1(r.lineEdited.p0) && cutAll(r.lineEdited.p1),
      JSON.stringify(chokePartRun));
  }

  // ---- DOOR 4: THE COMPOSE GRID, DOCKED IN THE CARD -----------------------
  // The other half of what was asked for: not just READING a phrase from the
  // bank, but drawing one here. v1's session is freeze/lock-specific at its two
  // ends only; v2 supplies its own ends and borrows the lane, the dock and the
  // step editor between them.
  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.rhythm.kind = 'euclid';
    window._v2.render(_masterEng);
  });
  await zz(300);
  const dockState = () => page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const exp = document.getElementById('lane-expander');
    const r = exp ? exp.getBoundingClientRect() : null;
    return {
      session: (typeof _bloomGridEdit !== 'undefined' && _bloomGridEdit) ? _bloomGridEdit.key : null,
      dockHidden: (c.querySelector('.v2-dock') || {}).hidden,
      // DETACHED is the tell for the documented trap: an innerHTML rewrite of
      // the host deletes the docked editor, and `_placeLaneExpander` then finds
      // nothing to re-dock, so the surface is gone for good.
      expanderIn: exp ? (exp.parentElement ? (exp.parentElement.className || exp.parentElement.id) : 'DETACHED') : 'GONE',
      expanderH: r ? Math.round(r.height) : 0,
      strip: c.querySelectorAll('.ambient-seedgrid-striphost .lane-row').length,
      chips: c.querySelectorAll('.ambient-seedgrid-striphost .lane-chips > *').length,
      seeded: (typeof _bloomGridEdit !== 'undefined' && _bloomGridEdit)
        ? _bloomGridEdit.lane.steps.filter((s) => s.freq || s.chord).length : 0,
      scratch: (typeof lanes !== 'undefined') ? lanes.filter((l) => l._bloomScratch).length : -1,
    };
  });
  // BACK TO THE MATERIAL TAB FIRST — the section above navigated to Bank, and
  // a tab shows only its own rows, so ✎ Composed is off screen until we come
  // back (it measured `zero-size`, which is the tell).
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.v2-layer .v2-pop-tab')]
      .find((x) => x.getAttribute('data-tab') === 'Method');
    if (t) t.click();
  });
  await zz(250);
  e = await tap('.v2-layer .v2-gridbtn');
  await zz(300);
  await page.evaluate(() => {   // ▦ Compose goes straight in (2026-09-14)
    const b = [...document.querySelectorAll('.addpop-btn')].find((x) => /grid/i.test(x.textContent));
    if (b) b.click();
  });
  await zz(600);
  let d = await dockState();
  ok('✎ Compose is reachable and opens a session', !e && d.session === 'v2:1', e || JSON.stringify(d));
  ok('the editor is DOCKED in the card, with a real box',
    /seedgrid-dockhost/.test(d.expanderIn) && d.expanderH > 100, JSON.stringify(d));
  // Seeded from what the part plays — v1 learned that an empty canvas makes the
  // layer fall silent on the click and shows nothing to edit.
  ok('the canvas is seeded from the part (not blank)', d.seeded > 0 && d.chips > 0, JSON.stringify(d));

  await page.evaluate(() => {
    const ge = _bloomGridEdit; if (!ge) return;   // guarded: a failed open must not kill the run
    ge.lane.steps[0].freq = 440; ge.lane.steps[0].label = 'A4'; delete ge.lane.steps[0].chord;
  });
  e = await tap('.v2-layer .v2-gdone');
  d = await dockState();
  const done = await page.evaluate(() => {
    const p = (_masterEng.getCfg().layers || [])[0].part;
    return { kind: p.kind, notes: (p.notes || []).length, hasA4: (p.notes || []).some((n) => n.midi === 69) };
  });
  ok('✓ Done writes what was drawn into the part',
    !e && done.kind === 'recorded' && done.notes > 0 && done.hasA4, e || JSON.stringify(done));
  ok('the session tears down cleanly (editor back, no scratch lane)',
    d.session === null && d.dockHidden === true && d.scratch === 0 && !/seedgrid/.test(d.expanderIn),
    JSON.stringify(d));

  // ✕ Cancel must leave the part exactly as it was — a discard that half-commits
  // is worse than no discard.
  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    L.part.kind = 'live'; window.__partBefore = JSON.stringify(L.part.notes);
    window._v2.render(_masterEng);
  });
  await zz(250);
  await tap('.v2-layer .v2-gridbtn');
  await zz(300);
  await page.evaluate(() => {   // ▦ Compose again (2026-09-14)
    const b = [...document.querySelectorAll('.addpop-btn')].find((x) => /grid/i.test(x.textContent));
    if (b) b.click();
  });
  await zz(600);
  await page.evaluate(() => {
    const ge = _bloomGridEdit;
    if (ge) ge.lane.steps.forEach((s) => { s.freq = 110; s.label = 'A2'; delete s.chord; });
  });
  await tap('.v2-layer .v2-gcancel');
  const cancelled = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    return { kind: L.part.kind, same: JSON.stringify(L.part.notes) === window.__partBefore,
             session: (typeof _bloomGridEdit !== 'undefined' && _bloomGridEdit) ? 'OPEN' : null,
             scratch: lanes.filter((l) => l._bloomScratch).length };
  });
  ok('✕ Cancel discards and leaves the part untouched',
    cancelled.kind === 'live' && cancelled.same && !cancelled.session && cancelled.scratch === 0,
    JSON.stringify(cancelled));

  // ---- THE SIGNAL CHAIN, AND THE SWEEPS -----------------------------------
  // A v2 layer used to bypass `vcf → vca → levelGain → gate → pan → [FX] → bus`
  // entirely (`_ambSyncMods` enumerated v1 layers only, `_ambLayerDest` returned
  // undefined) — which is what made FX, reverb send, bus routing, spatialize,
  // the trance gate, the unit gate AND a continuous Level fader all missing at
  // once. Treatments are shared fields at the top of the layer, exactly as v1's
  // are, so one resolver reaches all of it.
  const rig = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg(), L = (cfg.layers || [])[0], key = 'v2:' + L.id;
    L.name = 'Pulse';
    _ambSyncControls(E); _ambSyncMods(E);
    const e = E.mod && E.mod[key];
    const gain = () => (e && e.levelGain) ? Math.round(e.levelGain.gain.value * 1000) / 1000 : null;
    const fader = document.querySelector('.ambient-mix-slider[data-mixkey="' + key + '"]');
    const card = document.querySelector('.v2-layer [data-f="level"]');
    const out = {
      treatments: ['level', 'space', 'panMode', 'revSend'].filter((k) => k in L).join(','),
      chain: !!e,
      nodes: e ? ['levelGain', 'gate', 'pan', 'revSend', 'ugGate'].filter((k) => e[k]).join(',') : '',
      dest: typeof _ambLayerDest(key),
      mixerName: (_ambMixerLayers(cfg).find((x) => x.key === key) || {}).name,
      fader: !!fader, schedRow: !!document.querySelector('[data-schkey="' + key + '"]'),
    };
    if (fader && card) {
      fader.value = 42; fader.dispatchEvent(new Event('input', { bubbles: true }));
      out.mixerToCard = E.getCfg().layers[0].level + '/' + card.value + '/' + gain();
      card.value = 88; card.dispatchEvent(new Event('input', { bubbles: true }));
      out.cardToMixer = E.getCfg().layers[0].level + '/' + fader.value + '/' + gain();
    }
    return out;
  });
  ok('v2 carries the shared treatment fields', rig.treatments === 'level,space,panMode,revSend', rig.treatments);
  ok('a per-layer CHAIN is built, and the destination resolves',
    rig.chain && rig.dest === 'object' && /levelGain/.test(rig.nodes) && /pan/.test(rig.nodes), JSON.stringify(rig));
  ok('v2 appears in the mixer AND the scheduler, under its own name',
    rig.fader && rig.schedRow && rig.mixerName === 'Pulse', JSON.stringify(rig));
  // Level has TWO controls over ONE field; drifting apart is the documented bug.
  ok('Level: mixer → card → live gain', rig.mixerToCard === '42/42/0.78', rig.mixerToCard);
  ok('Level: card → mixer → live gain', rig.cardToMixer === '88/88/2.92', rig.cardToMixer);

  // ---- WHAT ACTUALLY REACHES playNote -------------------------------------
  // THE CHECK THAT WAS MISSING FOR FOUR SLICES. Every earlier verification
  // counted playNote CALLS or inspected the note list, and a v2 layer at its
  // DEFAULT tone was silent the whole time: `instrument.tone: ''` means
  // "whatever the grid uses" and v1 resolves that through `_ambLayerType`
  // before playNote ever sees it, while v2 passed the empty string straight
  // through. Measured at the master tap: tone '' = peak 0.0000, 'sine' = 0.8428.
  // A note count cannot see that. The params can.
  const emitted = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    const L = (cfg.layers || [])[0];
    L.part.kind = 'live'; L.part.rhythm = { kind: 'euclid', steps: 8, pulses: 4, rotate: 0 };
    L.part.bars = 1; L.instrument.tone = '';            // the DEFAULT — the silent case
    E.getCfg();
    const seen = [];
    const orig = window.playNote;
    window.playNote = function (f, p, d, at) {
      // A stub that REPLACES playNote never stamps `_ambEmitKey` (the tee that
      // does is inside the real one), so call the sink or every note reads as
      // unowned — the documented trap, hit twice in this work already.
      try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
      seen.push({ key: window._ambEmitKey, type: p && p.type, vol: p && p.volume, f: Math.round(f) });
    };
    E._barGridAnchor = 0; E._v2Phase = {};
    try { window._v2Tick(E, 0, 2, 0, 0, cfg); } catch (e) {}
    window.playNote = orig;
    const mine = seen.filter((x) => x.key === 'v2:' + L.id);
    return { n: mine.length, types: [...new Set(mine.map((x) => x.type))],
             vols: [...new Set(mine.map((x) => x.vol))] };
  });
  ok('the DEFAULT tone resolves to a real voice (not "")',
    emitted.n > 0 && emitted.types.length === 1 && !!emitted.types[0],
    JSON.stringify(emitted));
  // v1's emitters stage low and let the Level fader lift; staged high, a v2
  // layer arrived ~2.2x louder than a v1 one at the same Level (measured on a
  // single note, same tone and length: vol 32 → 0.2297, vol 70 → 0.5026).
  ok('notes are staged like v1, so Level means the same thing',
    emitted.vols.length === 1 && emitted.vols[0] === 32, JSON.stringify(emitted));

  // ---- MIX & FX -----------------------------------------------------------
  // The surface the chain unlocked. These are v1's OWN fields, written FLAT on
  // the layer (`_ambNormalizeFx` does `host.cutoff` / `host.delay`, and
  // `_ambApplyLayerFx` reads `lc.delay` straight off it) — there is no `L.fx`
  // container, which is what my first cut of this group got wrong.
  const fxState = await page.evaluate(() => {
    const E = _masterEng;
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    card.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    // The old single "Mix & FX" group was an 18-row dump (routing + filter +
    // time FX + gating + movement) and is SPLIT: Mix owns level/filter/routing/
    // stereo, FX owns the effect stages. Asserting the split is the contract
    // now — one group holding all of it is the regression.
    const grpOf = (n) => [...card.querySelectorAll('.ambient-grp')]
      .find((g) => g.getAttribute('data-v2grp') === n);
    const rowsOf = (g) => g ? [...g.querySelectorAll('.ambient-ctrl')]
      .map((r) => (r.querySelector('label') || {}).textContent).join('/') : '';
    const gMix = grpOf('Mix'), gFx = grpOf('FX');
    const out = {
      group: !!gMix && !!gFx,
      rows: rowsOf(gMix) + ' || ' + rowsOf(gFx),
      mix: rowsOf(gMix), fx: rowsOf(gFx),
    };
    const set = (f, v) => {
      const el = card.querySelector('[data-f="' + f + '"]');
      if (!el) return false;
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    out.wroteDelay = set('delay.mix', 70);
    out.wroteRev = set('revSend', 80);
    out.wroteCut = set('cutoff', 40);
    E.getCfg(); E.getCfg();                       // survive two normalizes
    const L = E.getCfg().layers[0];
    out.after = [L.delay && L.delay.mix, L.revSend, L.cutoff].join('/');
    // the engine's own reader must see them where it looks
    out.engineReads = !!(L.delay && typeof L.delay.mix === 'number') && Number.isFinite(L.revSend);
    return out;
  });
  // Space is a TAB of Mix now, and Filter/Resonance moved to Instrument where
  // they belong (they are how the VOICE sounds, not how it is mixed). What this
  // check defends is unchanged: Mix and FX stay separate questions, and neither
  // leaks into the other.
  ok('Mix and FX stay separate questions, and Space rides with Mix',
    fxState.group &&
    /Level/.test(fxState.mix) && /Reverb/.test(fxState.mix) && /Bus/.test(fxState.mix) &&
    /Delay/.test(fxState.fx) && /Drive/.test(fxState.fx) && /Chop/.test(fxState.fx) &&
    !/Delay/.test(fxState.mix) && !/Level/.test(fxState.fx),
    JSON.stringify(fxState));
  ok('FX write v1\'s FLAT fields and survive normalize',
    fxState.wroteDelay && fxState.wroteRev && fxState.after === '70/80/40' && fxState.engineReads,
    JSON.stringify(fxState));

  // ---- SOLO, ACROSS BOTH MODELS -------------------------------------------
  // Solo that covers only half the layers is worse than none: it silences some
  // of the mix and leaves the rest. v1's `_ambComputeAnySolo` now counts v2
  // layers, and `_v2Tick` reads that same answer.
  ok('Solo is offered on the v2 layer', await menuItem('Solo'));
  const soloed = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg(), L = cfg.layers[0];
    return { flag: !!L.solo, anySolo: _ambComputeAnySolo(cfg),
             marked: document.querySelector('.v2-layer').classList.contains('v2-soloed') };
  });
  ok('solo sets the shared flag and the whole mix sees it',
    soloed.flag && soloed.anySolo === true, JSON.stringify(soloed));
  // The drum-solo lesson: state that silences the mix must be visible.
  ok('a soloed layer LOOKS soloed on the card', soloed.marked, JSON.stringify(soloed));
  await menuItem('Solo');                       // back off, so later checks are clean
  ok('solo toggles back off', !(await page.evaluate(() => !!_masterEng.getCfg().layers[0].solo)));

  // ---- THE KIT INSTRUMENT: THE MULTI-LANE SEQUENCER -----------------------
  // v1's drum lanes are 8 lanes of ONE KIT, and v2 had a single row only because
  // it had a single instrument. A kit is eight parallel rhythms with a fixed
  // pitch each — the rhythm stage gains a lane dimension, and the PITCH stage is
  // answered by the lane itself, which is why the pitch pieces disappear.
  const kit = await page.evaluate(async () => {
    const E = _masterEng, key = 'v2:' + E.getCfg().layers[0].id;
    let c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed'); c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const L0 = E.getCfg().layers[0];
    L0.part.kind = 'live'; E.getCfg();
    const v = c.querySelector('[data-f="instrument.voice"]');
    v.value = 'kit'; v.dispatchEvent(new Event('input', { bubbles: true }));
    await zz(300);
    c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed'); c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const out = {
      rows: [...c.querySelectorAll('.ambient-ctrl')].filter((r) => getComputedStyle(r).display !== 'none')
        .map((r) => (r.querySelector('label') || {}).textContent).join('/'),
      laneNames: [...c.querySelectorAll('.v2-lanes .ambient-euclid-drumlbl')].map((x) => x.textContent).join(','),
      lanes: c.querySelectorAll('.v2-lanes .ambient-euclid-row').length,
    };
    const shown = (sel2) => {
      const el = c.querySelector(sel2); if (!el) return false;
      const row = el.closest('.ambient-ctrl');
      return !!row && getComputedStyle(row).display !== 'none';
    };
    out.toneShown = shown('[data-f="instrument.tone"]');
    out.regShown = shown('[data-f="instrument.register"]');
    out.pitchShown = shown('[data-f="part.pitch.kind"]');
    out.rhythmShown = shown('[data-f="part.rhythm.kind"]');
    out.kitShown = shown('[data-f="instrument.kit"]');
    const hit = (l, i) => {
      const x = document.querySelector('.v2-layer .v2-lanecell[data-lane="' + l + '"][data-ci="' + i + '"]');
      if (x) x.click();
    };
    [0, 4].forEach((i) => hit(0, i)); [2, 6].forEach((i) => hit(1, i));
    out.stored = E.getCfg().layers[0].part.rhythm.lanes.map((r) => r.join('')).slice(0, 2).join(' ');
    // BOTH REALIZATIONS take different players — a synth kit is a recipe played
    // by `_ambPlaySynthDrum` (lane index), a sample kit an ordinary note on
    // `sample:<id>`. Fixing one arm and leaving the other is the documented way
    // a drum burst goes silent.
    const grab = () => {
      const notes = [], drums = [];
      const orig = window.playNote, od = window._ambPlaySynthDrum;
      window._ambPlaySynthDrum = function (E2, d2, inst, role, at) { drums.push(role); };
      window.playNote = function (f, p, d, at) {
        try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
        if (window._ambEmitKey === key) notes.push((p && p.type) || '');
      };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 4, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = orig; window._ambPlaySynthDrum = od;
      return { notes, drums };
    };
    let g = grab();
    out.synthDrums = g.drums.length; out.synthNotes = g.notes.length;
    out.synthLanes = [...new Set(g.drums)].sort().join(',');
    const ks = document.querySelector('.v2-layer [data-f="instrument.kit"]');
    ks.value = 'tr808'; ks.dispatchEvent(new Event('input', { bubbles: true }));
    await zz(200);
    g = grab();
    out.sampleNotes = g.notes.length; out.sampleDrums = g.drums.length;
    out.sampleType = [...new Set(g.notes)].join(',');
    // A v1 SWEEP MUST NOT CLAIM THE LANES. `_ambRefreshEuclidGrids` rewrites the
    // innerHTML of every `.ambient-euclid-grid` in the host, and v2 reuses that
    // chrome — measured 8 lanes -> 4 on the next sync before it was guarded.
    _ambSyncControls(E); _ambRebuildMaster(); _ambSyncControls(E);
    out.lanesAfterSweeps = document.querySelectorAll('.v2-layer .v2-lanes .ambient-euclid-row').length;
    out.litAfterSweeps = document.querySelectorAll('.v2-layer .v2-lanecell.on').length;
    return out;
  });
  ok('a kit shows 8 named lanes, in v1\'s order',
    kit.lanes === 8 && kit.laneNames === 'Kick,Snare,Hat,Clap,Open hat,Tom,Crash,Perc', JSON.stringify(kit));
  // The pitch pieces are answered by the lane, so they must not be on screen.
  // Checked by ELEMENT, not by label text — "Tone" also labels the FX cutoff row,
  // so a text match reports the instrument's Tone as visible when it is not.
  ok('a kit hides the pitched controls it cannot use',
    kit.kitShown && !kit.toneShown && !kit.regShown && !kit.pitchShown && !kit.rhythmShown,
    JSON.stringify(kit));
  ok('lane cells draw and store per lane', kit.stored === '10001000 00100010', kit.stored);
  ok('a SYNTH kit plays through the synth-drum path (and not as notes)',
    kit.synthDrums > 0 && kit.synthNotes === 0 && kit.synthLanes === '0,1', JSON.stringify(kit));
  ok('a SAMPLE kit plays through sample:<id> (and not as synth drums)',
    kit.sampleNotes > 0 && kit.sampleDrums === 0 && kit.sampleType === 'sample:tr808', JSON.stringify(kit));
  ok('v1\'s euclid sweeps do not claim the v2 lanes',
    kit.lanesAfterSweeps === 8 && kit.litAfterSweeps === 4, JSON.stringify(kit));

  // ---- THE PITCH VOCABULARY -----------------------------------------------
  // `anchor` is the one that matters most: Drone and Pedal were retired as layer
  // TYPES on the promise that a pedal point stays expressible, and this is where
  // that promise is kept. Scored by v1's own `_ambAnchorPc`, so v2 picks the same
  // note v1 would.
  const pitches = await page.evaluate(() => {
    const E = _masterEng, V = window._v2, cfg = E.getCfg();
    cfg.layers = [];
    cfg.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] },
                                    { root: 5, intervals: [0, 4, 7] },
                                    { root: 7, intervals: [0, 4, 7] }] };
    cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'major'; cfg.keyFollow = false;
    const L = V.add(cfg, { name: 'P', instrument: { tone: 'sine', register: 4 },
      part: { kind: 'live', bars: 1, rhythm: { kind: 'pulse', n: 4 },
              pitch: { kind: 'chord', voices: 1 }, shape: { lenRatio: 50 } } });
    const mid = (f) => Math.round(69 + 12 * Math.log2(f / 440));
    const run = (k, extra) => {
      Object.assign(L.part.pitch, { kind: k }, extra || {}); E.getCfg();
      const rows = [];
      for (let c = 0; c < 3; c++) {
        rows.push(V.notesFor(L, { E, cfg, key: 'v2:' + L.id, cycleStart: c * 2, cycleSec: 2 })
          .map((x) => mid(x.freq)).join(' '));
      }
      return rows;
    };
    const out = { up: run('series', { dir: 'up', degree: 1 }),
                  down: run('series', { dir: 'down', degree: 1 }),
                  updown: run('series', { dir: 'updown', degree: 1 }) };
    L.part.pitch = { kind: 'anchor' }; E.getCfg();
    const pcs = new Set();
    for (let c = 0; c < 6; c++) {
      V.notesFor(L, { E, cfg, key: 'v2:' + L.id, cycleStart: c * 2, cycleSec: 2 })
        .forEach((n) => pcs.add(mid(n.freq) % 12));
    }
    out.anchorPcs = [...pcs];
    out.v1Pick = _ambAnchorPc(E, cfg, 0);
    // chance must draw from an ISOLATED stream — same take, same notes.
    L.part.pitch = { kind: 'chance' }; E.getCfg();
    const once = () => V.notesFor(L, { E, cfg, key: 'v2:' + L.id, cycleStart: 0, cycleSec: 2 })
      .map((n) => mid(n.freq)).join(' ');
    out.chanceRepeats = once() === once();
    cfg.prog = { on: false, chords: [] };            // leave the fixture clean
    cfg.layers = [];
    return out;
  });
  // A sweep is deterministic in the ONSET INDEX, which is what makes it a sweep
  // and not a scatter — and it re-resolves per chord, so it follows the changes.
  ok('series sweeps the chord and follows the changes',
    pitches.up[0] === '60 64 67 72' && pitches.up[1] === '65 69 72 77', JSON.stringify(pitches.up));
  ok('series honours its direction',
    pitches.down[0] === '60 55 52 48' && pitches.updown[0] === '60 64 67 64',
    JSON.stringify([pitches.down[0], pitches.updown[0]]));
  // THE PEDAL-POINT PROMISE: one note, held against every chord, and the SAME
  // note v1's scorer picks.
  ok('anchor is ONE pitch class across the whole progression',
    pitches.anchorPcs.length === 1 && pitches.anchorPcs[0] === pitches.v1Pick,
    JSON.stringify(pitches));
  ok('chance replays identically for a take (isolated stream)', pitches.chanceRepeats);

  // ---- THE VOICE LIST, AND THE BUS ----------------------------------------
  // `_ambToneOptions()` takes NO argument and returns an ARRAY; calling it with
  // one and expecting a string fell through to an eight-item fallback, so a v2
  // layer could only ever be a basic waveform — no samples, no design patches.
  // That was the whole "sample instrument": a picker, not an engine.
  const voices = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = []; const L = window._v2.add(cfg, { name: 'V' });
    L.part.kind = 'live'; delete L.part.notes; delete L.part.made;
    _ambSyncControls(E);
    const card = document.querySelector('.v2-layer');
    const opts = [...card.querySelectorAll('[data-f="instrument.tone"] option')].map((o) => o.value);
    const out = { n: opts.length, samples: opts.filter((o) => /^sample:/.test(o)).length,
                  hasPiano: opts.includes('sample:piano') };
    const sel = card.querySelector('[data-f="instrument.tone"]');
    if (out.hasPiano) { sel.value = 'sample:piano'; sel.dispatchEvent(new Event('input', { bubbles: true })); }
    out.stored = E.getCfg().layers[0].instrument.tone;
    // a sample plays through the ordinary note path — nothing special needed
    const seen = []; const orig = window.playNote;
    window.playNote = function (f, p, d, at) {
      try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
      if (window._ambEmitKey === 'v2:' + L.id) seen.push((p && p.type) || '');
    };
    const L2 = E.getCfg().layers[0];
    L2.part.bars = 1; L2.part.rhythm = { kind: 'pulse', n: 2 }; L2.part.pitch = { kind: 'fixed', degree: 1 };
    E.getCfg(); E._barGridAnchor = 0; E._v2Phase = {};
    try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
    window.playNote = orig;
    out.emitted = [...new Set(seen)].join(',');
    // BUS — the only way a Bloom layer reaches the shared FX returns. Changing
    // it must REBUILD the chain, since the output is resolved at build time.
    _ambSyncMods(E);
    const before = E.mod['v2:' + L.id];
    const bsel = document.querySelector('.v2-layer [data-f="bus"]');
    out.busOffered = !!bsel;
    if (bsel) { bsel.value = 'c'; bsel.dispatchEvent(new Event('input', { bubbles: true })); }
    out.busStored = E.getCfg().layers[0].bus;
    out.chainRebuilt = !!E.mod['v2:' + L.id] && E.mod['v2:' + L.id] !== before;
    return out;
  });
  ok('the Tone picker offers v1\'s FULL voice list, samples included',
    voices.n > 100 && voices.samples > 50 && voices.hasPiano, JSON.stringify(voices));
  ok('a sample plays as an ordinary v2 tone',
    voices.stored === 'sample:piano' && voices.emitted === 'sample:piano', JSON.stringify(voices));
  ok('Bus is offered and REBUILDS the chain when changed',
    voices.busOffered && voices.busStored === 'c' && voices.chainRebuilt, JSON.stringify(voices));

  // ---- THE TRANCE GATE ----------------------------------------------------
  // The ENGINE already drove this for v2 the moment the chain existed —
  // `_ambScheduleStochastic` walks `_E.mod` and `_ambScheduleTg` resolves through
  // `_ambLayerByKey` — so this slice was a surface over working machinery
  // (measured quiet frames at 0.00000 against 0.288 loud with the gate on).
  const tgate = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = []; window._v2.add(cfg, { name: 'G' });
    _ambSyncControls(E);
    const card = () => document.querySelector('.v2-layer');
    const open = () => { const c = card(); c.classList.remove('collapsed');
      c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open')); };
    const rows = () => [...card().querySelectorAll('.ambient-ctrl')]
      .filter((r) => getComputedStyle(r).display !== 'none')
      .map((r) => (r.querySelector('label') || {}).textContent).filter((x) => /Chop/.test(x)).join('/');
    open();
    const out = { off: rows() };
    card().querySelector('.v2-tgtoggle').click();
    await zz(250); open();
    out.on = rows();
    out.flag = E.getCfg().layers[0].tg.on;
    out.cells = card().querySelectorAll('.v2-tgcell').length;
    card().querySelector('.v2-tgcell[data-ci="1"]').click();
    out.pattern = E.getCfg().layers[0].tg.pattern.join('');
    const ss = card().querySelector('[data-f="tg.steps"]');
    ss.value = 8; ss.dispatchEvent(new Event('input', { bubbles: true }));
    await zz(250); open();
    const tg = E.getCfg().layers[0].tg;
    out.resized = tg.steps + ':' + tg.pattern.length + ':' + card().querySelectorAll('.v2-tgcell').length;
    card().querySelector('.v2-tgtoggle').click();
    await zz(250); open();
    out.offAgain = E.getCfg().layers[0].tg.on;
    return out;
  });
  ok('the chop is one row until switched on, then shows its controls',
    tgate.off === 'Chop' && /Chop steps/.test(tgate.on) && /Chop depth/.test(tgate.on), JSON.stringify(tgate));
  // A BUTTON, not a select: a select writes a STRING and `'0'` is truthy, so an
  // "Off" pick would have switched the gate ON.
  ok('the gate toggles a NUMERIC flag both ways',
    tgate.flag === 1 && tgate.offAgain === 0, JSON.stringify(tgate));
  ok('chop steps draw and edit', tgate.cells === 16 && tgate.pattern === '1110101010101010', JSON.stringify(tgate));
  // The pattern length IS the step count — the grid must never disagree with
  // the number above it (the same rule the rhythm grid follows).
  ok('resizing keeps pattern, store and DOM in step', tgate.resized === '8:8:8', tgate.resized);

  // ---- SPATIALIZE ---------------------------------------------------------
  // A per-note pan SEQUENCE (distinct from Width, a static spread). Applied
  // inside `_ambCapSink`, which v2 already installs per layer — so, like the
  // trance gate, the engine drove it the moment the chain existed and this was
  // a surface only.
  const spat = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    const L = window._v2.addDefault(E), key = 'v2:' + L.id;
    L.part.bars = 1; L.part.rhythm = { kind: 'pulse', n: 8 }; L.part.pitch = { kind: 'fixed', degree: 1 };
    _ambSyncControls(E); _ambSyncMods(E);
    const card = () => document.querySelector('.v2-layer');
    const open = () => { const c = card(); c.classList.remove('collapsed');
      c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open')); };
    open();
    const out = { absent: !('spat' in E.getCfg().layers[0]) };
    const pans = () => {
      const seen = []; const orig = window.playNote;
      window.playNote = function (f, p, d, at) {
        try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
        if (window._ambEmitKey === key) seen.push(p && p.pan);
      };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = orig; return seen;
    };
    out.off = pans();
    card().querySelector('.v2-spattoggle').click();
    await zz(250); open();
    out.on = pans();
    const ms = card().querySelector('[data-f="spat.mode"]');
    ms.value = 'sweep'; ms.dispatchEvent(new Event('input', { bubbles: true }));
    await zz(200);
    out.sweep = pans();
    out.rows = [...card().querySelectorAll('.ambient-ctrl')]
      .filter((r) => getComputedStyle(r).display !== 'none')
      .map((r) => (r.querySelector('label') || {}).textContent)
      .filter((x) => /Move|Positions|Phaser|Auto/.test(x)).join('/');
    return out;
  });
  // Absent-by-default matters: `_ambNormalizeSpat` DELETES the field unless it
  // is already an object, so an untouched layer carries nothing.
  ok('spatialize is absent until engaged, and leaves pan alone',
    spat.absent && spat.off.every((p) => p == null), JSON.stringify(spat.off));
  ok('engaging it moves the pan note by note',
    spat.on.filter((p) => p != null).length === spat.on.length && new Set(spat.on).size > 2,
    JSON.stringify(spat.on));
  // A mode is only real if it CHANGES the sequence — 'sweep' must not equal 'fan'.
  ok('the move mode changes the shape', JSON.stringify(spat.sweep) !== JSON.stringify(spat.on),
    JSON.stringify({ fan: spat.on, sweep: spat.sweep }));
  ok('phaser and auto-pan are on the card', /Phaser/.test(spat.rows) && /Auto-pan/.test(spat.rows), spat.rows);

  // ---- IMPORT: READING A v1 LAYER AS PIECES -------------------------------
  // The question that decides whether v2 could ever replace v1. Two jobs:
  // TREATMENTS copy 1:1 (they are already the same fields — the payoff of
  // treating them as not-constituents), PIECES are derived per type.
  const imp = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = []; (cfg.extras || []).length = 0;
    cfg.prog = { on: false, chords: [] };          // no prog: keep each type's OWN unit
    ['bed', 'motif', 'run', 'bass', 'beat', 'arp', 'texture'].forEach((t) => _ambAddExtra(E, t));
    const ex = E.getCfg().extras;
    ex.forEach((x, i) => { x.on = true; x.present = true; x.level = 40 + i * 5; x.revSend = 60;
      x.delay = { mix: 33, timeMs: 250, feedback: 40, ping: 0, spread: 0, dryKill: 0 }; });
    E.getCfg();
    const rows = {}, units = {};
    ex.forEach((x) => {
      const key = x.type + ':' + x.id;
      units[x.type] = x.unit ? ((x.unit.num | 0) / (x.unit.den | 0)) : null;
      const L2 = window._v2.fromV1(E, key);
      rows[x.type] = L2 ? { bars: L2.part.bars, voice: L2.instrument.voice,
        rhythm: L2.part.rhythm.kind, pitch: L2.part.pitch.kind,
        level: L2.level, rev: L2.revSend, dly: L2.delay && L2.delay.mix } : null;
    });
    // everything must PLAY, and the originals must be untouched
    const seen = {}; const orig = window.playNote;
    window.playNote = function (f, p, d, at) {
      try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
      const k = window._ambEmitKey; if (k && k.indexOf('v2:') === 0) seen[k] = (seen[k] || 0) + 1;
    };
    E._barGridAnchor = 0; E._v2Phase = {};
    try { window._v2Tick(E, 0, 8, 0, 0, E.getCfg()); } catch (e) {}
    window.playNote = orig;
    // NOT `restProb`/`ghosts`/`lenVary` any more — those became v2 treatments in
    // slices 13-14, so the import CARRIES them (asserted separately below).
    const junk = ['density', 'holdSteps', 'gravity', 'contour', 'fill', 'syncop', 'write'];
    // Leave a card on screen — this fixture replaced every layer, and the
    // layout check below reads `.v2-layer`.
    try { _ambSyncControls(E); window._v2.render(E); } catch (e) {}
    // COUNTS FIRST — the source fixture below adds a layer on each side, and
    // the conversion check asserts on both totals.
    const v1Left0 = E.getCfg().extras.length, v2Made0 = E.getCfg().layers.length;
    // the SOURCE must ride along: set one on a v1 layer, import it, compare
    let srcCarried = false;
    try {
      const v1 = _ambAddExtra(E, 'motif');
      v1.notes = { type: 'chord', root: 9, intervals: [0, 3, 7] };
      const v2L = window._v2.fromV1(E, _ambKeyOfLayer(E, v1));
      srcCarried = !!(v2L && v2L.notes && v2L.notes.type === 'chord' && v2L.notes.root === 9);
    } catch (e) { srcCarried = 'ERR ' + e.message; }
    return { rows, units, srcCarried, v1Left: v1Left0, v2Made: v2Made0,
             playing: E.getCfg().layers.filter((L) => seen['v2:' + L.id]).length,
             leaked: junk.filter((k) => k in E.getCfg().layers[0]),
             carried: (() => { const src = ex.find((x) => x.type === 'motif'); const dst = E.getCfg().layers[1];
               return src && dst ? ['humanize', 'velVar', 'restProb'].every((k) =>
                 !Number.isFinite(src[k]) || dst[k] === src[k]) : false; })() };
  });
  ok('every v1 type converts, and the original is left alone',
    imp.v2Made === 7 && imp.v1Left === 7 && Object.values(imp.rows).every(Boolean), JSON.stringify(imp.rows));
  // The pieces are the actual translation — this is the spine being tested.
  ok('pieces are derived per type (kit for a beat, euclid for a bass, series for an arp)',
    imp.rows.beat.voice === 'kit' && imp.rows.bass.rhythm === 'euclid' &&
    imp.rows.arp.pitch === 'series' && imp.rows.bed.pitch === 'chord' &&
    imp.rows.texture.rhythm === 'chance' && imp.rows.motif.pitch === 'walk', JSON.stringify(imp.rows));
  // `L1.unit` IS the cycle, as a bar ratio. Reading it through a helper with the
  // wrong signature collapsed every import to the 0.125 floor.
  ok('the cycle comes from v1\'s own unit ratio',
    Object.keys(imp.units).every((t) => !imp.units[t] || Math.abs(imp.rows[t].bars - imp.units[t]) < 0.03),
    JSON.stringify({ units: imp.units, bars: Object.fromEntries(Object.entries(imp.rows).map(([k, v]) => [k, v.bars])) }));
  ok('treatments copy 1:1', imp.rows.bed.level === 40 && imp.rows.bed.rev === 60 && imp.rows.bed.dly === 33,
    JSON.stringify(imp.rows.bed));
  // A blind spread would drag v1's generation fields across, where they mean
  // nothing and normalize would keep them for ever.
  ok('no v1 generation field is dragged across', imp.leaked.length === 0, imp.leaked.join(','));
  // …but the PERFORMANCE family is carried, which is most of what separated an
  // imported layer from a clone.
  ok('the performance/variance family IS carried across', imp.carried, String(imp.carried));
  ok('and so is the note SOURCE — an imported layer keeps its own harmony',
    imp.srcCarried, JSON.stringify(imp.srcCarried));
  ok('every imported layer actually plays', imp.playing === 7, imp.playing + ' of 7');

  // ---- PERFORMANCE: HUMANIZE, VEL VAR, GLIDE, VOICE TRIM ------------------
  // All six come from ONE call to v1's shared params builder `_ambApplyAdsr`, so
  // the semantics are v1's rather than a second implementation. v2 keeps its
  // envelope under `instrument`, so it passes a SHIM — cached non-enumerably,
  // because `_ambApplyAdsr` hangs `glideLayer` off it and playNote tracks the
  // previous frequency there, so a fresh object per note would kill portamento.
  const perf = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    const L = window._v2.addDefault(E), key = 'v2:' + L.id;
    L.part.bars = 1; L.part.rhythm = { kind: 'pulse', n: 8 }; L.part.pitch = { kind: 'fixed', degree: 1 };
    L.instrument.attack = 12; L.instrument.release = 333;
    E.getCfg();
    const grab = (field) => {
      const seen = []; const orig = window.playNote;
      window.playNote = function (f, p, d, at) {
        try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
        if (window._ambEmitKey === key) seen.push(p && p[field]);
      };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = orig; return seen;
    };
    const out = {};
    out.env = grab('attack')[0] + '/' + grab('release')[0];
    // VEL VAR IS SEEDED on position-in-the-take, so one take replays; a new take
    // differs. Both need `_ambKeyTime` stamped per note — v2 did not stamp it,
    // and the jitter's own sequence counter then just kept counting.
    L.velVar = 80; E.getCfg(); _E._cfg = E.getCfg();   // the tick sets this cache
    const t1 = grab('volume').join(','), t2 = grab('volume').join(',');
    out.replays = (t1 === t2);
    out.spread = new Set(t1.split(',')).size;
    const c2 = E.getCfg(); c2.seed = (c2.seed | 0) + 7777; _E._cfg = c2;
    out.newTake = (grab('volume').join(',') !== t1);
    // HUMANIZE is deliberately UNSEEDED — performance jitter, never replays.
    L.velVar = 0; L.humanize = 70; E.getCfg();
    out.humanVaries = (grab('_humanSec').join(',') !== grab('_humanSec').join(','));
    out.humanRange = Math.max(...grab('_humanSec').map(Math.abs)) <= 0.021;
    L.humanize = 0; L.portamento = 250; L.voiceTrim = -6; E.getCfg();
    out.glide = grab('glideMs')[0];
    out.shimStable = (() => { const a1 = L.__v2shim; grab('volume'); return a1 === L.__v2shim; })();
    out.trimVol = grab('volume')[0];
    out.shimHidden = JSON.stringify(E.getCfg().layers[0]).indexOf('__v2shim') < 0;
    out.stampRestored = (_ambKeyTime === null || Number.isFinite(_ambKeyTime));
    return out;
  });
  ok('the envelope reaches playNote through the shim', perf.env === '12/333', perf.env);
  ok('Vel var REPLAYS for a take and differs for a new one',
    perf.replays && perf.newTake && perf.spread > 2, JSON.stringify(perf));
  ok('Humanize does NOT replay, and stays inside v1\'s ±20ms',
    perf.humanVaries && perf.humanRange, JSON.stringify(perf));
  ok('Glide reaches playNote on a STABLE layer object',
    perf.glide === 250 && perf.shimStable, JSON.stringify(perf));
  // -6 dB is exactly half — the staging is 32, so 16.
  ok('Voice trim is applied in dB', perf.trimVol === 16, String(perf.trimVol));
  // The shim must never be serialised, and the stamp must be left as found.
  ok('the shim is invisible to persistence and the key stamp is restored',
    perf.shimHidden && perf.stampRestored, JSON.stringify(perf));

  // ---- VARIANCE: RESTS, GHOSTS, LEN VARY ----------------------------------
  // The gap the import made concrete. TREATMENTS, not pieces: they apply
  // whatever the rhythm and pitch are, which is why they work on a kit too.
  // Every draw is an ISOLATED seeded stream keyed on (layer, cycle, onset), so a
  // take replays and v1's shared RNG is never touched.
  const varn = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    const L = window._v2.addDefault(E), key = 'v2:' + L.id;
    L.part.bars = 1; L.part.rhythm = { kind: 'pulse', n: 16 }; L.part.pitch = { kind: 'fixed', degree: 1 };
    E.getCfg(); _E._cfg = E.getCfg();
    const grab = () => {
      const seen = []; const orig = window.playNote;
      window.playNote = function (f, p, d, at) {
        try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
        if (window._ambEmitKey === key) seen.push({ at: +(at || 0).toFixed(3), vol: p && p.volume, dur: d });
      };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = orig; return seen;
    };
    const set = (o) => { Object.assign(L, { restProb: 0, ghosts: 0, lenVary: 0 }, o); E.getCfg(); _E._cfg = E.getCfg(); };
    const out = {};
    set({}); out.base = grab().length;
    set({ restProb: 50 });
    const r = grab(); out.rests = r.length;
    out.restsReplay = grab().map((x) => x.at).join(',') === grab().map((x) => x.at).join(',');
    set({ ghosts: 90 });
    const g = grab(); out.ghostNotes = g.length;
    out.ghostVols = [...new Set(g.map((x) => x.vol))].sort((a, b) => a - b);
    set({ lenVary: 80 });
    out.durs = new Set(grab().map((x) => x.dur)).size;
    // ON A KIT TOO — a treatment that only worked on one instrument would not be
    // a treatment.
    set({ ghosts: 90 });
    L.instrument.voice = 'kit'; L.instrument.kit = 'tr808';
    L.part.rhythm = { kind: 'euclid', steps: 8, pulses: 4, rotate: 0,
                      lanes: [[1, 0, 0, 0, 1, 0, 0, 0], [0, 0, 1, 0, 0, 0, 1, 0], [], [], [], [], [], []] };
    E.getCfg(); _E._cfg = E.getCfg();
    const k = grab();
    out.kitNotes = k.length; out.kitVols = [...new Set(k.map((x) => x.vol))].sort((a, b) => a - b);
    return out;
  });
  ok('Rests drop onsets, and the same take replays them',
    varn.rests > 0 && varn.rests < varn.base && varn.restsReplay,
    JSON.stringify(varn));
  // A ghost at full level is just a doubled note — the quieter level IS the feature.
  ok('Ghosts add QUIETER extra hits',
    varn.ghostNotes > varn.base && varn.ghostVols.length === 2 && varn.ghostVols[0] < varn.ghostVols[1],
    JSON.stringify(varn));
  ok('Len vary scatters note lengths', varn.durs > 3, String(varn.durs));
  ok('variance is a TREATMENT — it works on a kit too',
    varn.kitNotes > 4 && varn.kitVols.length === 2 && varn.kitVols[0] < varn.kitVols[1],
    JSON.stringify(varn));

  // ---- THE FOUR SCHEDULE GATES --------------------------------------------
  // `when` and `chordMask` are EMITTER-side in v1, so v2 has to ask them
  // (through v1's own helpers, never a second implementation). `unitGate` and
  // `iterGate` ride the playNote hook and already applied. All four are shared
  // fields, so this is the last of v1's scheduling vocabulary reaching v2.
  const sched = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    cfg.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }] };
    const L = window._v2.add(cfg, { name: 'g', instrument: { tone: 'sine' },
      part: { kind: 'live', bars: 1, rhythm: { kind: 'pulse', n: 4 },
              pitch: { kind: 'fixed', degree: 1 }, shape: { lenRatio: 50 } } });
    const key = 'v2:' + L.id;
    E.getCfg(); _ambSyncMods(E);
    // EMITTED counts what the emitter produced; SKIPPED counts the playNote
    // gate's own verdict — a wrapper cannot see the second, because the gate
    // drops the note INSIDE playNote (the documented trap).
    const emitted = () => {
      let n = 0; const orig = window.playNote;
      window.playNote = function (f, p, d, at) {
        try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
        if (window._ambEmitKey === key) n++;
      };
      E._barGridAnchor = 0; E._v2Phase = {}; E._cfg = E.getCfg();
      try { window._v2Tick(E, 0, 8, 0, 0, E._cfg); } catch (e) {}
      window.playNote = orig; return n;
    };
    const skipped = () => {
      let s2 = 0; const g = window._ambUnitGateSkip;
      window._ambUnitGateSkip = function (k, at) { const r = g.apply(this, arguments); if (k === key && r) s2++; return r; };
      E._barGridAnchor = 0; E._v2Phase = {}; E._cfg = E.getCfg();
      try { window._v2Tick(E, 0, 8, 0, 0, E._cfg); } catch (e) {}
      window._ambUnitGateSkip = g; return s2;
    };
    const out = { unit: JSON.stringify(E.getCfg().layers[0].unit), base: emitted() };
    L.when = '1010'; E.getCfg(); out.when = emitted(); delete L.when;
    L.chordMask = { steps: [0, 100] }; E.getCfg(); out.chord = emitted(); delete L.chordMask;
    // USE THE SETTER — `div` is clamped to a minimum of 2 and a slot's value is
    // a MASK ARRAY, not a number. Inventing that shape is what made this gate
    // read as broken through four probes.
    _ambUnitGateSet(L, 0, [0, 0], 2, 1); E.getCfg(); out.unitAll = skipped();
    _ambUnitGateSet(L, 0, [1, 0], 2, 1); E.getCfg(); out.unitHalf = skipped();
    _ambUnitGateSet(L, 0, [1, 1], 2, 1); E.getCfg();
    out.pruned = E.getCfg().layers[0].unitGate === undefined;
    L.iterGate = { len: 1, steps: [0], ref: 'round' }; E.getCfg(); out.iter = skipped();
    delete L.iterGate; E.getCfg();
    out.restored = emitted();
    // Leave the layer in place — the layout check below reads `.v2-layer`, and
    // clearing the store here left it with no card (twice now).
    cfg.prog = { on: false, chords: [] };
    try { _ambSyncControls(E); window._v2.render(E); } catch (e) {}
    return out;
  });
  // The UNIT MIRROR: v1 indexes the unit schedule by a layer's `unit` ratio, and
  // v2's cycle is `part.bars`. Without the mirror `_ambUnitLaneBars` answers
  // 0.03125 bars and the schedule addresses a thirty-second of a bar.
  ok('part.bars is mirrored as v1\'s unit ratio',
    sched.unit === '{"mode":"sync","ref":"bar","num":1,"den":1}', sched.unit);
  ok('`when` gates which iterations play', sched.when > 0 && sched.when < sched.base,
    sched.when + ' of ' + sched.base);
  ok('`chordMask` gates which chords play', sched.chord > 0 && sched.chord < sched.base,
    sched.chord + ' of ' + sched.base);
  ok('`unitGate` closes a unit, and half of one',
    sched.unitAll === sched.base && sched.unitHalf > 0 && sched.unitHalf < sched.unitAll,
    JSON.stringify(sched));
  // Absence is the neutral state everywhere — an all-on mask must leave no residue.
  ok('an all-on unit gate prunes itself away', sched.pruned, String(sched.pruned));
  ok('`iterGate` silences an iteration', sched.iter === sched.base, sched.iter + ' of ' + sched.base);
  ok('clearing the gates restores the layer', sched.restored === sched.base,
    sched.restored + ' of ' + sched.base);

  // ---- THE GATES GET A SURFACE --------------------------------------------
  // Slice 15 made all four gates APPLY to a v2 layer; they were still
  // uneditable, which is the documented "unreachable forever" failure. v1 edits
  // chordMask/saltMask from the ⌗/▦ matrices, so v2 joins their enumerator
  // rather than growing a second surface. `when` has no home there — v1 edits it
  // in the Scheduler's per-type Advanced block — so it gets a card control.
  const surf = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = []; (cfg.extras || []).length = 0;
    cfg.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }] };
    const L = window._v2.add(cfg, { name: 'Pulse', instrument: { tone: 'sine' },
      part: { kind: 'live', bars: 1, rhythm: { kind: 'pulse', n: 4 }, pitch: { kind: 'fixed', degree: 1 } } });
    E.getCfg(); _ambSyncControls(E);
    const out = {
      rows: _ambChordMatrixRows(E.getCfg()).map((r) => r.key).join(','),
      label: (_ambChordMatrixRows(E.getCfg()).find((r) => r.key === 'v2:' + L.id) || {}).label,
      swept: _ambPartSeqLayers(E.getCfg()).some((x) => x === E.getCfg().layers[0]),
    };
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    card.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const w = card.querySelector('[data-f="when"]');
    out.whenOffered = !!w;
    if (w) { w.value = '10'; w.dispatchEvent(new Event('input', { bubbles: true })); }
    out.whenStored = E.getCfg().layers[0].when;
    const emitted = () => {
      let n = 0; const orig = window.playNote;
      window.playNote = function (f, p, d, at) {
        try { if (window._ambCaptureSink) window._ambCaptureSink(f, p, d, at); } catch (e) {}
        if (window._ambEmitKey === 'v2:' + L.id) n++;
      };
      E._barGridAnchor = 0; E._v2Phase = {}; E._cfg = E.getCfg();
      try { window._v2Tick(E, 0, 8, 0, 0, E._cfg); } catch (e) {}
      window.playNote = orig; return n;
    };
    out.gated = emitted();
    E.getCfg().layers[0].when = 'always'; E.getCfg();
    out.ungated = emitted();
    cfg.prog = { on: false, chords: [] };
    try { _ambSyncControls(E); window._v2.render(E); } catch (e) {}
    return out;
  });
  ok('the chord/pass matrices LIST a v2 layer, under its name',
    /v2:1/.test(surf.rows) && surf.label === 'Pulse', JSON.stringify(surf));
  ok('v2 joins the partSeq / per-layer sweep', surf.swept, String(surf.swept));
  ok('`when` has a card control that stores v1\'s own vocabulary',
    surf.whenOffered && surf.whenStored === '10', JSON.stringify(surf));
  ok('and it gates for real', surf.gated > 0 && surf.gated < surf.ungated,
    surf.gated + ' of ' + surf.ungated);

  // ---- DRAWN PITCH: THE MELODIC STEP SEQUENCER ----------------------------
  // The last of the eight pitch kinds, and the one that turns the pattern grid
  // into a step sequencer you can write a line on. Stores DEGREES, not absolute
  // notes, so a drawn line still follows the changes and transposes with the key.
  const drawn = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    cfg.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }] };
    cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'major'; cfg.keyFollow = false;
    const L = window._v2.add(cfg, { name: 'Line', instrument: { tone: 'sine', register: 4 },
      part: { kind: 'live', bars: 1, rhythm: { kind: 'euclid', steps: 8, pulses: 4, rotate: 0 },
              pitch: { kind: 'drawn' }, shape: { lenRatio: 60 } } });
    E.getCfg(); _ambSyncControls(E);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    card().querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const out = {
      labels: card().querySelectorAll('.v2-note').length,
      // A silent step's label is DISABLED — editing the note of a step that does
      // not sound stores a value with no audible effect, i.e. a dead control.
      silentDisabled: [...card().querySelectorAll('.v2-note.off')].every((x) => x.disabled),
      sounding: [...card().querySelectorAll('.v2-note')].filter((x) => !x.disabled).map((x) => +x.getAttribute('data-ci')),
    };
    const k = out.sounding[0];
    document.querySelector('.v2-note[data-ci="' + k + '"]').click();
    await new Promise((r) => setTimeout(r, 260));
    out.editorOpened = !!card().querySelector('.v2-steppop');
    // …and under a DRAWN line the editor edits that line's own degree, so there
    // is no "follow the rule" to offer and no second store to drift from
    out.noFollow = !card().querySelector('.v2-stepfollow');
    for (let i = 0; i < 2; i++) {
      const el2 = card().querySelector('.v2-sfdeg');
      const b2 = el2 && el2.closest('.ambient-stepper').querySelector('.ambient-step-up');
      if (b2) b2.click();
      await new Promise((r) => setTimeout(r, 160));
    }
    { const cb = card().querySelector('.v2-stepclose'); if (cb) cb.click(); }
    await new Promise((r) => setTimeout(r, 220));
    // RESTATED 2026-09-09: assert the degree of the step that was TAPPED, not a
    // hardcoded slice. Push 0 now starts the pattern on the beat, so this
    // fixture's first sounding step moved from index 1 to index 0 — the
    // contract ("tapping raises the degree") never mentioned which step.
    out.degreeAtK = ((E.getCfg().layers[0].part.pitch.steps || [])[k] | 0);
    out.degrees = (E.getCfg().layers[0].part.pitch.steps || []).slice(0, 4).join(',');
    out.label = card().querySelector('.v2-note[data-ci="' + k + '"]').textContent;
    const mid = (f) => Math.round(69 + 12 * Math.log2(f / 440));
    const cyc = (cs) => window._v2.notesFor(E.getCfg().layers[0],
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: cs, cycleSec: 2 }).map((n) => mid(n.freq)).join(' ');
    out.overC = cyc(0); out.overF = cyc(2);
    cfg.prog = { on: false, chords: [] };
    try { _ambSyncControls(E); window._v2.render(E); } catch (e) {}
    return out;
  });
  ok('drawn pitch shows a note row, one label per step',
    drawn.labels === 8 && drawn.sounding.length === 4, JSON.stringify(drawn));
  ok('a silent step\'s label is disabled, not a dead control', drawn.silentDisabled, String(drawn.silentDisabled));
  // The label asks the EMITTER what it will play, so it cannot promise a note
  // the engine will not sound.
  ok('a step label opens an editor, and the note set there is what plays',
    drawn.editorOpened && drawn.noFollow &&
    drawn.degreeAtK === 3 && drawn.label === 'G4', JSON.stringify(drawn));
  // DEGREES, not notes — the whole reason a drawn line still works under a
  // progression: degree 3 is G over C and C over F.
  ok('a drawn line follows the changes',
    drawn.overC === '67 60 60 60' && drawn.overF === '72 65 65 65',
    JSON.stringify({ C: drawn.overC, F: drawn.overF }));

  // ---- GLITCH + WET ONLY --------------------------------------------------
  // Completes the FX set. Glitch is CORE-ONLY (a granulator has no sane Web
  // Audio node build), so the hint says so when strips are off rather than
  // failing silently. Wet only mutes the DRY output — with a reverb send up, the
  // wash should remain; with no send there is genuinely nothing left, which is
  // v1's behaviour too.
  const fxset = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    const L = window._v2.add(cfg, { name: 'F', instrument: { tone: 'sawtooth' },
      part: { kind: 'live', bars: 1, rhythm: { kind: 'pulse', n: 2 },
              pitch: { kind: 'fixed', degree: 1 }, shape: { lenRatio: 30 } } });
    L.level = 80; L.revSend = 85;              // a send, so wet-only leaves a wash
    E.getCfg(); _ambSyncControls(E); _ambSyncMods(E);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    card().querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const out = { rows: [...card().querySelectorAll('.ambient-ctrl')]
      .filter((r) => getComputedStyle(r).display !== 'none')
      .map((r) => (r.querySelector('label') || {}).textContent)
      .filter((x) => /Glitch|Wet/.test(x)).join('/') };
    const g = card().querySelector('[data-f="glitch.mix"]');
    g.value = 70; g.dispatchEvent(new Event('input', { bubbles: true }));
    const gm = card().querySelector('[data-f="glitch.mode"]');
    gm.value = 'repeat'; gm.dispatchEvent(new Event('input', { bubbles: true }));
    const gl = E.getCfg().layers[0].glitch;
    out.glitch = gl.mix + '/' + gl.mode;
    gl.mix = 0; E.getCfg();
    card().querySelector('.v2-wettoggle').click();
    await zz(250);
    out.wetOn = E.getCfg().layers[0].wetOnly;
    card().querySelector('.v2-wettoggle').click();
    await zz(250);
    out.wetOff = E.getCfg().layers[0].wetOnly;
    return out;
  });
  ok('Glitch and Wet only are on the card',
    /Glitch/.test(fxset.rows) && /Wet only/.test(fxset.rows), fxset.rows);
  ok('Glitch stores its mix and mode', fxset.glitch === '70/repeat', fxset.glitch);
  // A BUTTON, not a select — same reason as the trance gate: '0' is truthy.
  ok('Wet only toggles a NUMERIC flag both ways',
    fxset.wetOn === 1 && fxset.wetOff === 0, JSON.stringify(fxset));

  // ---- PLACEMENT: PROXIMITY -----------------------------------------------
  // Register is on the instrument and `walk.span` already IS v1's Range; the gap
  // was PROXIMITY — how far consecutive notes may move. A live-PITCH treatment:
  // it shapes the relationship between successive picks whatever kind is making
  // them, which is why it works on both `walk` and `chance`.
  const prox = await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    cfg.keyOn = true; cfg.keyRoot = 0; cfg.keyScale = 'major'; cfg.keyFollow = false;
    const L = window._v2.add(cfg, { name: 'W', instrument: { tone: 'sine', register: 4 },
      part: { kind: 'live', bars: 1, rhythm: { kind: 'pulse', n: 12 },
              pitch: { kind: 'walk', degree: 1, span: 8 }, shape: { lenRatio: 40 } } });
    E.getCfg(); _ambSyncControls(E);
    const mid = (f) => Math.round(69 + 12 * Math.log2(f / 440));
    const line = () => window._v2.notesFor(E.getCfg().layers[0],
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 2 }).map((n) => mid(n.freq));
    const jump = (a) => { let s2 = 0; for (let i = 1; i < a.length; i++) s2 += Math.abs(a[i] - a[i - 1]);
      return +(s2 / (a.length - 1)).toFixed(2); };
    const at = (v) => { L.proximity = v; E.getCfg(); return { a: line(), j: jump(line()) }; };
    const p0 = at(0), p50 = at(50), p95 = at(95);
    const out = { j0: p0.j, j50: p50.j, j95: p95.j };
    L.proximity = 70; E.getCfg();
    out.replays = line().join(',') === line().join(',');
    L.part.pitch = { kind: 'chance' };
    L.proximity = 0; E.getCfg(); const c0 = jump(line());
    L.proximity = 95; E.getCfg(); out.chance = [c0, jump(line())];
    // 0 MUST be the old behaviour exactly — a treatment that changes the default
    // path is not absent-by-default.
    L.part.pitch = { kind: 'walk', degree: 1, span: 8 }; L.proximity = 0; E.getCfg();
    out.zeroNeutral = line().join(',') === p0.a.join(',');
    _ambSyncControls(E);
    out.row = !!document.querySelector('.v2-layer [data-f="proximity"]');
    return out;
  });
  ok('proximity tightens the line, monotonically',
    prox.j95 < prox.j50 && prox.j50 < prox.j0, JSON.stringify([prox.j0, prox.j50, prox.j95]));
  ok('it works on `chance` too — it is a treatment, not a piece',
    prox.chance[1] < prox.chance[0], JSON.stringify(prox.chance));
  ok('a proximity-shaped line replays for a take', prox.replays, String(prox.replays));
  ok('proximity 0 leaves the old behaviour byte-identical', prox.zeroNeutral, String(prox.zeroNeutral));
  ok('proximity has a card control', prox.row, String(prox.row));

  // ---- THE SPEECH INSTRUMENT ----------------------------------------------
  // The last instrument. v2's framing is better than v1's here: v1's spoken
  // layers run a bespoke clock ("speak, then gap"), while here the PART decides
  // when a line starts — so a line can land on a euclid pulse like anything else.
  const sp = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.layers = [];
    const L = window._v2.add(cfg, { name: 'V',
      instrument: { voice: 'speech', text: 'Alpha. Beta. Gamma.' },
      part: { kind: 'live', bars: 1, rhythm: { kind: 'pulse', n: 1 } } });
    L.level = 90; E.getCfg(); _ambSyncControls(E); _ambSyncMods(E);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    card().querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const shown = (sel2) => { const el = card().querySelector(sel2); if (!el) return false;
      const r = el.closest('.ambient-ctrl'); return !!r && getComputedStyle(r).display !== 'none'; };
    const out = {
      // The TTS voice is `instrument.speechVoice`, NOT `voice` — that is the
      // instrument enum, and `_ambVoiceChoices` reads `L.voice` meaning the TTS
      // one, so it gets a shim.
      ttsOffered: shown('[data-f="instrument.speechVoice"]'),
      // Words carry the pitch, so the pitched controls must be gone.
      hidesPitch: !shown('[data-f="part.pitch.kind"]') && !shown('[data-f="instrument.tone"]'),
      lines: window._v2.speechLines(E.getCfg().layers[0]),
    };
    out.before = window._v2.speechStat(E, E.getCfg().layers[0]);
    // An UNRENDERED line must be SILENT, never a stall: rendering is seconds of
    // inference and the tick is 150 ms (v1's "nothing loads during playback").
    let n0 = 0; const o0 = window.playNote;
    window.playNote = function () { n0++; };
    E._barGridAnchor = 0; E._v2Phase = {}; E._cfg = E.getCfg();
    const t0 = Date.now();
    try { window._v2Tick(E, 0, 8, 0, 0, E._cfg); } catch (e) {}
    out.stallMs = Date.now() - t0; out.unrenderedNotes = n0;
    window.playNote = o0;
    // STUB the synth — this asserts OUR path (bank → `_ambLearnPlay` → the
    // layer's chain), not a 60 MB model download.
    const ac = Tone.getContext().rawContext;
    const origSynth = window._ambLearnSynth;
    window._ambLearnSynth = async () => {
      const n = Math.round(ac.sampleRate * 0.4), buf = ac.createBuffer(1, n, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 300 * i / ac.sampleRate) * 0.5 * (1 - i / n);
      return buf;
    };
    out.wrote = await window._v2.speechWrite(E, E.getCfg().layers[0]);
    window._ambLearnSynth = origSynth;
    out.after = window._v2.speechStat(E, E.getCfg().layers[0]);
    const tap = _ambMasterTapNode(), an = new Tone.Analyser('waveform', 2048);
    Tone.connect(tap, an);
    _ambStartGenerator(E); await zz(2400);
    let pk = 0;
    for (let i = 0; i < 30; i++) { const v = an.getValue();
      for (let j = 0; j < v.length; j++) pk = Math.max(pk, Math.abs(v[j]));
      await zz(25); }
    _ambStopGenerator(E); try { an.dispose(); } catch (e) {}
    out.peak = +pk.toFixed(4);
    // The bank lives on the ENGINE in a WeakMap — not on the layer (persist
    // serialises underscore fields, so AudioBuffers would land in the save) and
    // not in seqState (`_ambResetClocks` empties that on EVERY play).
    out.notInSave = JSON.stringify(E.getCfg().layers[0]).length < 3000;
    out.survivesStop = window._v2.speechStat(E, E.getCfg().layers[0]).ready;
    return out;
  });
  ok('speech offers a TTS voice and hides the pitched controls',
    sp.ttsOffered && sp.hidesPitch, JSON.stringify(sp));
  ok('lines are DERIVED from the text, never stored',
    sp.lines.length === 3 && sp.lines[0] === 'Alpha.', JSON.stringify(sp.lines));
  // Silent, not stalled — the whole reason rendering is a separate action.
  ok('an unwritten line is silent and does not stall the tick',
    sp.unrenderedNotes === 0 && sp.stallMs < 50, JSON.stringify(sp));
  ok('writing fills the bank and the layer then SOUNDS',
    sp.wrote === 3 && sp.after.ready === 3 && sp.peak > 0.01, JSON.stringify(sp));
  ok('the rendered audio never reaches the save, and survives a stop',
    sp.notInSave && sp.survivesStop === 3, JSON.stringify(sp));

  // ---- the five that were stored and unreachable ---------------------------
  // `reso`, `instrument.decay`, `instrument.sustain`, `fine` and `areaFadeMs`
  // were all read by the engine and had no control on the card — the
  // reachability rule broken quietly, for eight slices. A control is not the
  // fix; a control whose value ARRIVES is. Each is followed to the reader that
  // consumes it, not merely to the store.
  const reach = await page.evaluate(async () => {
    const E = _masterEng;
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const L = E.getCfg().layers[0];
    L.instrument.voice = 'synth'; L.part.kind = 'live';
    window._v2.render(E);
    await zz(120);
    const card = document.querySelector('.v2-layer');
    card.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const set = (f, v) => {
      const el = card.querySelector('[data-f="' + f + '"]');
      if (!el) return 'NO CONTROL';
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const out = {};
    out.wrote = ['reso', 'fine', 'areaFadeMs', 'instrument.decay', 'instrument.sustain']
      .map((f) => f + '=' + set(f, f === 'fine' ? -40 : f === 'areaFadeMs' ? 1200
                                 : f === 'instrument.sustain' ? 55 : f === 'instrument.decay' ? 900 : 65)).join(' ');
    E.getCfg(); E.getCfg();                                  // survive two normalizes
    const L2 = E.getCfg().layers[0];
    out.stored = [L2.reso, L2.fine, L2.areaFadeMs, L2.instrument.decay, L2.instrument.sustain].join('/');
    // what actually reaches a NOTE — `_ambApplyAdsr` is the one builder every
    // emit goes through, so decay/sustain/fine either arrive there or nowhere
    const seen = [];
    const oP = window.playNote;
    window.playNote = function (f, params, dur, dest, at) {
      if (window._ambEmitKey === 'v2:' + L2.id) seen.push(params);
      return oP.apply(this, arguments);
    };
    try {
      const now = _masterEng.getCfg() && 0;
      window._v2Tick(E, 0, 4, 0.1, 0, E.getCfg());
    } catch (e) { out.tickErr = e.message; }
    window.playNote = oP;
    const p0 = seen[0] || {};
    out.inNote = [p0.decay, p0.sustain, p0.detune].join('/');
    out.notes = seen.length;
    // AREA FADE. v1 hard-cuts a BAR-SYNCED layer at an area boundary by design
    // and fades only a FREE one, so the honest check is both arms — a v2 layer
    // was always synced, which is what made this control inert and is why free
    // cycles landed in the same slice.
    try { out.fadeSynced = _ambAreaFadeMap(E.getCfg())['v2:' + L2.id]; } catch (e) { out.fadeSynced = 'ERR ' + e.message; }
    L2.part.clock = 'free'; L2.part.ms = 700; E.getCfg();
    try { out.fadeFree = _ambAreaFadeMap(E.getCfg())['v2:' + L2.id]; } catch (e) { out.fadeFree = 'ERR ' + e.message; }
    out.freeUnit = JSON.stringify(E.getCfg().layers[0].unit);
    try { out.freeCapturable = _ambIsCapturable(E.getCfg().layers[0], 'v2:' + L2.id); } catch (e) { out.freeCapturable = 'ERR'; }
    // the FREE clock must actually drive the onsets — 700ms, not the bar grid
    const at = []; const oP2 = window.playNote;
    window.playNote = function (f, pr, d, t) { at.push(+t.toFixed(3)); };
    E._barGridAnchor = 0; E._v2Phase = {};
    try { window._v2Tick(E, 0, 3, 0, 0, E.getCfg()); } catch (e) {}
    window.playNote = oP2;
    out.freeOnsets = [...new Set(at)].slice(0, 4).join(',');
    L2.part.clock = 'bars'; E.getCfg();
    out.backToSync = (E.getCfg().layers[0].unit || {}).mode + '/' + (E.getCfg().layers[0].part.clock === undefined);
    // and the FILTER reader must see reso where it looks
    out.filterReads = (() => { try { return _ambLayerByKey(E, 'v2:' + L2.id).reso; } catch (e) { return 'ERR ' + e.message; } })();
    return out;
  });
  ok('the five stored-but-unreachable fields all have controls now',
    !/NO CONTROL/.test(reach.wrote), reach.wrote);
  ok('and they survive normalize',
    reach.stored === '65/-40/1200/900/55', reach.stored);
  // decay/sustain/fine ride `_ambApplyAdsr`, the one params builder every emit
  // uses — so this is the check that separates "stored" from "sounding".
  ok('decay, sustain and fine reach the note itself',
    reach.notes > 0 && reach.inNote === '900/55/-40', JSON.stringify(reach));
  ok('resonance reaches the filter reader',
    reach.filterReads === 65, JSON.stringify(reach));
  // A control that cannot apply is the trap this whole slice exists to close.
  ok('area fade is 0 on a bar-synced layer (v1 hard-cuts it) and live when free',
    reach.fadeSynced === 0 && reach.fadeFree === 1200, JSON.stringify(reach));
  ok('a FREE part writes v1\'s own free unit, so every consumer reads it as free',
    reach.freeUnit === '{"mode":"free","ref":"bar","num":1,"den":1}' &&
    reach.freeCapturable === false, JSON.stringify(reach));
  ok('and the free interval drives the onsets, not the bar grid',
    reach.freeOnsets === '0,0.7,1.4,2.1', reach.freeOnsets);
  ok('switching back to bars restores the sync unit and stores no clock',
    reach.backToSync === 'sync/true', reach.backToSync);

  // ---- article fetching ----------------------------------------------------
  // The last v1 capability v2 lacked. `_ambLearnFetch(sourceId, term, corpus,
  // wantChars)` is not layer-shaped — plain arguments in, `{title,text,url}`
  // out — so v2 calls it directly. The source list and the Amount table are
  // v1's, read by id, so the two cannot offer different sources or budgets.
  // The fetch itself is STUBBED here: this gate must not depend on Wikipedia.
  const artcl = await page.evaluate(async () => {
    const E = _masterEng;
    const L = E.getCfg().layers[0];
    L.instrument.voice = 'speech'; L.instrument.kit = 'synth';
    delete L.source; delete L.term; delete L.article; delete L.amount; delete L.lineWords;
    E.getCfg(); window._v2.render(E);
    await zz(160);
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const out = {
      controls: ['[data-f="source"]', '.v2-term', '[data-f="amount"]',
                 '[data-f="lineWords"]', '.v2-fetch'].every((q) => !!c.querySelector(q)),
    };
    // With PASTED text there is no subject, no budget and nothing to fetch —
    // the Words box IS the source, so those rows must be gone.
    out.hiddenForPaste = c.querySelector('.v2-fetch').closest('.ambient-ctrl').getBoundingClientRect().height === 0;
    const L2 = E.getCfg().layers[0];
    L2.source = 'wiki-random'; E.getCfg(); window._v2.render(E);
    await zz(150);
    const c2 = document.querySelector('.v2-layer');
    c2.classList.remove('collapsed');
    c2.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    out.shownForNet = c2.querySelector('.v2-fetch').closest('.ambient-ctrl').getBoundingClientRect().height > 0;
    const orig = window._ambLearnFetch;
    let askedFor = null;
    window._ambLearnFetch = async (id, term, corpus, chars) => {
      askedFor = id + '/' + (term || '') + '/' + chars;
      return { title: 'Test Article', text: 'One two three. Four five six. Seven eight nine.', url: 'x' };
    };
    L2.term = 'kestrels'; L2.amount = 'short';
    const got = await window._v2.fetchArticle(E, E.getCfg().layers[0]);
    window._ambLearnFetch = orig;
    out.asked = askedFor;
    out.title = got && got.title;
    out.lines = got && got.lines;
    out.stored = (E.getCfg().layers[0].instrument.text || '').slice(0, 13);
    out.article = E.getCfg().layers[0].article;
    // pasted text must NOT reach the network at all
    L2.source = 'paste'; E.getCfg();
    let touched = false;
    window._ambLearnFetch = async () => { touched = true; return null; };
    await window._v2.fetchArticle(E, E.getCfg().layers[0]);
    window._ambLearnFetch = orig;
    out.pasteSkipsNetwork = touched === false;
    L2.instrument.text = 'Alpha beta gamma, delta epsilon zeta, eta theta iota, kappa lambda mu, nu xi omicron.';
    L2.lineWords = 60; E.getCfg();
    out.longLines = window._v2.speechStat(E, E.getCfg().layers[0]).lines;
    L2.lineWords = 4; E.getCfg();
    out.shortLines = window._v2.speechStat(E, E.getCfg().layers[0]).lines;
    delete L2.lineWords; L2.instrument.voice = 'synth'; E.getCfg();
    return out;
  });
  ok('a speaking layer has a source, a subject, a budget and a Fetch',
    artcl.controls, JSON.stringify(artcl));
  ok('those rows are gone for pasted text and present for a network source',
    artcl.hiddenForPaste && artcl.shownForNet, JSON.stringify(artcl));
  // The SUBJECT and the BUDGET must both reach v1's fetch, by id.
  ok('Fetch asks v1\'s own loader with the source, subject and char budget',
    artcl.asked === 'wiki-random/kestrels/1200', String(artcl.asked));
  ok('and the article lands as this layer\'s words',
    artcl.title === 'Test Article' && artcl.article === 'Test Article' &&
    artcl.stored === 'One two three' && artcl.lines === 3, JSON.stringify(artcl));
  ok('pasted text never touches the network', artcl.pasteSkipsNetwork, JSON.stringify(artcl));
  // One long sentence must break into MORE spoken lines at a short setting —
  // `_ambSpokenLines` reads it off the layer, so handing it `null` (as v2 did)
  // threw the control away silently.
  ok('Line length re-splits the words into more, shorter lines',
    artcl.shortLines > artcl.longLines && artcl.longLines >= 1, JSON.stringify(artcl));

  // ---- the synth-kit editor ------------------------------------------------
  // v1's own `_ambSynthKitUi`, and — for the THIRD time — no wiring in v2: its
  // handlers resolve the layer through `_ambCardKey` → `_ambLayerByKey`, which
  // have answered for a v2 card since slice 5. What it DID need was
  // `_ambBeatIsSynth` learning that a v2 layer keeps its kit on the INSTRUMENT,
  // because that predicate drives the editor's own visibility sweep.
  const skit = await page.evaluate(async () => {
    let out0err = null;
    const E = _masterEng;
    const L = E.getCfg().layers[0];
    L.instrument.voice = 'kit'; L.instrument.kit = 'synth';
    delete L.synthKit;
    E.getCfg(); window._v2.render(E);
    await zz(160);
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    try { _ambSyncControls(E); } catch (e) {}
    try { _ambSyncSynthKit(E); } catch (e) { out0err = e.message; }
    await zz(120);
    const ed = c.querySelector('.ambient-synthkit');
    const out = { present: !!ed, cardKey: (typeof _ambCardKey === 'function') ? _ambCardKey(c) : null,
                  syncErr: typeof out0err === 'undefined' ? null : out0err };
    if (!ed) return out;
    out.visible = ed.getBoundingClientRect().height > 0;
    out.tabs = ed.querySelectorAll('.ambient-sk-role').length;
    // driven through V1's OWN delegated handlers
    const tab = ed.querySelectorAll('.ambient-sk-role')[2];
    if (tab) { tab.click(); await zz(120); }
    out.active = ed.getAttribute('data-active');
    const kitOf = () => { const k = E.getCfg().layers[0].synthKit; return (k && k.voices) ? JSON.stringify(k.voices[2]) : null; };
    const before = kitOf();
    const roll = ed.querySelector('.ambient-sk-roll');
    if (roll) { roll.click(); await zz(160); }
    out.rolled = before !== kitOf() && kitOf() !== null;
    // a SAMPLE kit must hide it — the editor is for the generated kit only
    E.getCfg().layers[0].instrument.kit = 'tr808';
    E.getCfg(); window._v2.render(E);
    await zz(120);
    try { _ambSyncControls(E); } catch (e) {}
    try { _ambSyncSynthKit(E); } catch (e) {}
    const ed2 = document.querySelector('.v2-layer .ambient-synthkit');
    out.hiddenForSample = !ed2 || ed2.getBoundingClientRect().height === 0;
    E.getCfg().layers[0].instrument.voice = 'synth';
    E.getCfg().layers[0].instrument.kit = 'synth';
    E.getCfg();
    return out;
  });
  ok('a v2 kit layer carries v1\'s synth-kit editor, and it is VISIBLE',
    skit.present && skit.visible && skit.tabs === 8 && skit.cardKey === 'v2:1',
    JSON.stringify(skit));
  ok('v1\'s own handlers drive it: a role tab selects, Roll writes a new voice',
    skit.active === '2' && skit.rolled === true, JSON.stringify(skit));
  ok('a SAMPLE kit hides it — the editor is for the generated kit only',
    skit.hiddenForSample === true, JSON.stringify(skit));

  // ---- polyphonic euclid ---------------------------------------------------
  // `euclidVoices` is NOT `pitch.voices`, which was my third wrong "covered by
  // another name": that stacks N notes on ONE onset (a chord), whereas this
  // gives each voice its OWN euclidean row, its own degree and its own octave,
  // so they INTERLOCK. v1's `_ambEuclidVoicePat` is the spread, so the two
  // engines cannot disagree about what 3-voice euclid sounds like.
  const poly = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    delete cfg.startVary; delete cfg.groove;
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'euclid', pulses: 3, steps: 8, cells: [] };
    L.part.pitch = { kind: 'chord', voices: 1 };
    L.part.shape = { lenRatio: 90 };
    delete L.startVary; delete L.phrasing; delete L.twist; delete L.followSalt;
    E.getCfg(); E._cfg = E.getCfg();
    const shot = () => {
      const r = []; const oP = window.playNote;
      window.playNote = function (fr, p, d, t) {
        r.push(Math.round(t / 2 * 8) + ':' + Math.round(69 + 12 * Math.log2(fr / 440)));
      };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { r.push('ERR'); }
      window.playNote = oP; return r;
    };
    const a2 = shot();
    const out = { oneN: a2.length, oneP: [...new Set(a2.map((x) => x.split(':')[1]))].length };
    const r2 = E.getCfg().layers[0].part.rhythm;
    r2.voices = 3; E.getCfg(); E._cfg = E.getCfg();
    const c2 = shot();
    out.threeN = c2.length;
    out.slots = [...new Set(c2.map((x) => x.split(':')[0]))].length;
    out.pitches = [...new Set(c2.map((x) => x.split(':')[1]))].length;
    r2.voices = 1; E.getCfg(); E._cfg = E.getCfg();
    out.pruned = E.getCfg().layers[0].part.rhythm.voices === undefined;
    out.backN = shot().length;
    return out;
  });
  ok('one euclid voice is the single row it always was',
    poly.oneN === 3 && poly.oneP === 1 && poly.backN === 3, JSON.stringify(poly));
  // MORE notes, across MORE slots, on MORE pitches — all three, or it is not
  // interlocking: same-pitch voices would be a chord's worth of rhythm on one
  // note (measured exactly that before each voice got its own degree).
  ok('three euclid voices interlock: more onsets, more slots, a tone each',
    poly.threeN > poly.oneN && poly.slots > 3 && poly.pitches === 3, JSON.stringify(poly));
  ok('and it prunes back to one row', poly.pruned, JSON.stringify(poly));

  // ---- Start: where the phrase begins inside its cycle ---------------------
  // v1 has this TWICE under two names (`startVary` on a bed, `phraseVary` on a
  // motif) and says so in its own comment — one algorithm, two copies — so v2
  // keeps one field. The cascade is the real prize: `_ambEffStart` falls back
  // to the AREA's `startVary`, which IS the Groove panel's Humanize macro.
  const strt = await page.evaluate(async () => {
    // PER-CYCLE VARIATION IS A CHOICE NOW (`part.vary`) — the default is that
    // playback plays the TAKE the drawing shows, every cycle. This check's
    // whole phenomenon is observed ACROSS cycles, so it asks for the mode it
    // is testing; the contract it pins is unchanged.
    try { (_masterEng.getCfg().layers || [])[0].part.vary = 1; _masterEng.getCfg(); } catch (e) {}
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    delete cfg.startVary; delete cfg.groove;
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 2, steps: 8 };
    L.part.pitch = { kind: 'fixed', degree: 1 };
    delete L.startVary; delete L.phrasing; delete L.twist;
    E.getCfg(); E._cfg = E.getCfg();
    // the FIRST onset of each cycle, relative to that cycle
    const firsts = () => {
      const t = []; const oP = window.playNote;
      window.playNote = function (fr, p, d, tt) { t.push(+tt.toFixed(3)); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 8, 0, 0, E.getCfg()); } catch (e) { t.push(-1); }
      window.playNote = oP;
      const per = {};
      t.forEach((x) => { const c = Math.floor(x / 2); if (per[c] === undefined) per[c] = +(x - c * 2).toFixed(3); });
      return [0, 1, 2, 3].map((c) => per[c]).join(',');
    };
    const out = { one: firsts() };
    const L2 = E.getCfg().layers[0];
    L2.startVary = 100; E.getCfg(); E._cfg = E.getCfg();
    out.varied = firsts(); out.again = firsts();
    delete L2.startVary; E.getCfg(); E._cfg = E.getCfg();
    out.back = firsts();
    // the AREA cascade, with NO per-layer value at all
    cfg.startVary = 100; E.getCfg(); E._cfg = E.getCfg();
    out.area = firsts();
    cfg.groove = { bypass: true }; E.getCfg(); E._cfg = E.getCfg();
    out.bypassed = firsts();
    delete cfg.startVary; delete cfg.groove; E.getCfg();
    return out;
  });
  ok('by default every cycle starts on the 1',
    strt.one === '0,0,0,0' && strt.back === '0,0,0,0', JSON.stringify(strt));
  // …and PUT IT BACK: these run in ONE page against ONE cfg, and a `vary`
  // left on is the next check's bug (it snapshots the part AFTER this was
  // set, so its own restore would keep it).
  await page.evaluate(() => { try {
    delete (_masterEng.getCfg().layers || [])[0].part.vary; _masterEng.getCfg();
  } catch (e) {} });
  ok('Start moves the phrase inside its cycle, and replays for a take',
    strt.varied !== strt.one && strt.varied === strt.again &&
    new Set(strt.varied.split(',')).size > 1, JSON.stringify(strt));
  // THE PRIZE: the Groove panel's Humanize reaches a v2 layer that sets nothing.
  ok('the AREA Start cascade reaches a layer with no value of its own',
    strt.area === strt.varied, JSON.stringify(strt));
  ok('and a groove bypass silences the cascade',
    strt.bypassed === '0,0,0,0', JSON.stringify(strt));

  // ---- phrasing: v1's gesture cells ----------------------------------------
  // With probability `phrasing` an onset takes a shaped FIGURE — relative
  // onsets and durations with an ARRIVAL note (long, and leaned on) — instead
  // of a uniform note. v1's five cells verbatim; a reused cell is the classical
  // sequence device (same rhythm, new pitch level).
  const gest = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 2, steps: 8 };
    L.part.pitch = { kind: 'walk', degree: 1, span: 4 };
    L.part.shape = { lenRatio: 90 };
    delete L.phrasing; delete L.twist; delete L.motion; delete L.slide; delete L.ornament;
    E.getCfg(); E._cfg = E.getCfg();
    const cap = () => {
      const r = []; const oP = window.playNote;
      window.playNote = function (fr, p, d, t) { r.push({ t: +t.toFixed(3), d: d, v: p && p.volume }); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { r.push({ t: -1 }); }
      window.playNote = oP; return r;
    };
    const a2 = cap();
    const out = { plainN: a2.length, plainD: [...new Set(a2.map((x) => x.d))].join('/') };
    const L2 = E.getCfg().layers[0];
    L2.phrasing = 100; E.getCfg(); E._cfg = E.getCfg();
    const c2 = cap();
    out.n = c2.length;
    // one CELL is a fixed shape — durations must be its ratios x the span, and
    // they must NOT all be equal (that would be the uniform path)
    out.durs = [...new Set(c2.map((x) => x.d))].length;
    out.vols = [...new Set(c2.map((x) => x.v))].sort((x, y) => x - y);
    out.again = cap().map((x) => x.t + '/' + x.d).join(' ') === c2.map((x) => x.t + '/' + x.d).join(' ');
    delete L2.phrasing; E.getCfg(); E._cfg = E.getCfg();
    out.pruned = E.getCfg().layers[0].phrasing === undefined;
    out.backN = cap().length;
    return out;
  });
  ok('phrasing turns an onset into a shaped figure of several notes',
    gest.plainN === 2 && gest.n > gest.plainN && gest.durs > 1, JSON.stringify(gest));
  // The arrival is LEANED ON — x1.15 on the volume, v1's agogic emphasis. One
  // volume for every note would mean the arrival flag never reached the emit.
  ok('the arrival note is leaned on',
    gest.vols.length === 2 && gest.vols[1] > gest.vols[0], JSON.stringify(gest));
  ok('the figure replays for a take, and prunes away',
    gest.again && gest.pruned && gest.backN === gest.plainN, JSON.stringify(gest));

  // ---- the chord PHRASE: phraseLen x repeats -------------------------------
  // `_ambPickVoicing` is the SUPERSET of `_ambVoiceProgChord` — it delegates to
  // that one for a progression source and otherwise runs v1's STRUCTURED
  // voicer: a repeating phrase of `chordPhraseLen` chords, repeated
  // `chordRepeats` times, then a fresh one. That is what makes a chord layer
  // sound composed rather than chaotic with no progression to follow.
  const phr = await page.evaluate(async () => {
    // PER-CYCLE VARIATION IS A CHOICE NOW (`part.vary`) — the default is that
    // playback plays the TAKE the drawing shows, every cycle. This check's
    // whole phenomenon is observed ACROSS cycles, so it asks for the mode it
    // is testing; the contract it pins is unchanged.
    try { (_masterEng.getCfg().layers || [])[0].part.vary = 1; _masterEng.getCfg(); } catch (e) {}
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    L.part.pitch = { kind: 'chord', voices: 3 };
    delete L.twist; delete L.motion; delete L.followSalt; delete L.strum;
    E.getCfg(); E._cfg = E.getCfg();
    // one chord per CYCLE, eight cycles — the phrase walks on the cycle index
    const cycles = () => {
      const g = []; let cur = null, lt = -1; const oP = window.playNote;
      window.playNote = function (fr, p, d, t) {
        if (t !== lt) { cur = []; g.push(cur); lt = t; }
        cur.push(Math.round(69 + 12 * Math.log2(fr / 440)));
      };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 16, 0, 0, E.getCfg()); } catch (e) { g.push(['ERR']); }
      window.playNote = oP; return g.slice(0, 8).map((x) => x.join('/'));
    };
    const out = { simple: new Set(cycles()).size };
    const t = E.getCfg().layers[0].part.pitch;
    t.chordMode = 'chords'; t.phraseLen = 2; t.repeats = 2;
    E.getCfg(); E._cfg = E.getCfg();
    const a2 = cycles();
    out.p2 = a2.join(' '); out.d2 = new Set(a2).size;
    out.abab = (a2[0] === a2[2] && a2[1] === a2[3] && a2[0] !== a2[1] && a2[4] !== a2[0]);
    t.phraseLen = 4; t.repeats = 1; E.getCfg(); E._cfg = E.getCfg();
    const c2 = cycles(); out.d4 = new Set(c2).size;
    out.again = cycles().join(' ') === c2.join(' ');
    delete t.chordMode; E.getCfg();
    out.pruned = JSON.stringify({ p: t.phraseLen, r: t.repeats });
    return out;
  });
  ok('with no chord mode the voicing repeats every cycle', phr.simple === 1, JSON.stringify(phr));
  // A 2-chord phrase repeated twice reads A B A B, then a FRESH phrase.
  ok('phrase x repeats builds A B A B then a fresh phrase',
    phr.abab && phr.d2 === 4, JSON.stringify(phr));
  // …and PUT IT BACK: these run in ONE page against ONE cfg, and a `vary`
  // left on is the next check's bug (it snapshots the part AFTER this was
  // set, so its own restore would keep it).
  await page.evaluate(() => { try {
    delete (_masterEng.getCfg().layers || [])[0].part.vary; _masterEng.getCfg();
  } catch (e) {} });
  ok('with no repeat the phrase stops recurring',
    phr.d4 > phr.d2 && phr.d4 >= 6 && phr.again, JSON.stringify(phr));
  ok('the phrase fields prune with the mode', phr.pruned === '{}', phr.pruned);

  // ---- home, and where the voice comes from --------------------------------
  const hv = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 12, steps: 12 };
    L.part.pitch = { kind: 'walk', degree: 1, span: 6 };
    delete L.twist; delete L.motion; delete L.slide; delete L.ornament;
    E.getCfg(); E._cfg = E.getCfg();
    const mean = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(69 + 12 * Math.log2(fr / 440)); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { f.push(0); }
      window.playNote = oP;
      return Math.round(f.reduce((x, y) => x + y, 0) / Math.max(1, f.length) * 10) / 10;
    };
    const t = E.getCfg().layers[0].part.pitch;
    const out = { floor: mean() };
    t.home = 'center'; E.getCfg(); E._cfg = E.getCfg(); out.center = mean();
    t.home = 'ceiling'; E.getCfg(); E._cfg = E.getCfg(); out.ceiling = mean();
    t.home = 'floor'; E.getCfg(); E._cfg = E.getCfg();
    out.homePruned = E.getCfg().layers[0].part.pitch.home === undefined;
    out.back = mean();
    // VOICE FROM — the routing lives in `_ambLearnWarmUp` (which reads
    // `_ambVoiceFrom(L)`), NOT in `_ambLearnSynth`, which takes no layer. So
    // the check that matters is that the write path calls it.
    const L2 = E.getCfg().layers[0];
    L2.instrument.voice = 'speech'; L2.instrument.text = 'One. Two.';
    L2.voiceFrom = 'device'; E.getCfg();
    out.vfStored = E.getCfg().layers[0].voiceFrom;
    let warmed = null;
    const origWarm = window._ambLearnWarmUp;
    const origSynth = window._ambLearnSynth;
    window._ambLearnWarmUp = function (E2, LL) { warmed = LL && LL.voiceFrom; };
    window._ambLearnSynth = async () => null;
    try { await window._v2.speechWrite(E, E.getCfg().layers[0]); } catch (e) { out.wErr = e.message; }
    window._ambLearnWarmUp = origWarm; window._ambLearnSynth = origSynth;
    out.warmedWith = warmed;
    L2.voiceFrom = 'auto'; E.getCfg();
    out.vfPruned = E.getCfg().layers[0].voiceFrom === undefined;
    L2.instrument.voice = 'synth'; E.getCfg();
    return out;
  });
  // Floor walks UP from the register; centre and ceiling shift the window down.
  ok('home moves the walk window relative to the register',
    hv.floor > hv.center && hv.center > hv.ceiling, JSON.stringify(hv));
  ok('home is absent by default and the line returns to floor',
    hv.homePruned && hv.back === hv.floor, JSON.stringify(hv));
  ok('the write path asks `_ambLearnWarmUp`, which is where Voice from is read',
    hv.vfStored === 'device' && hv.warmedWith === 'device' && hv.vfPruned,
    JSON.stringify(hv));

  // ---- twist and motion ----------------------------------------------------
  const twm = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 4, steps: 4 };
    L.part.pitch = { kind: 'walk', degree: 1, span: 4 };
    delete L.twist; delete L.motion; delete L.slide; delete L.ornament; delete L.fine;
    E.getCfg(); E._cfg = E.getCfg();
    const cap = () => {
      const t = [], det = []; const oP = window.playNote;
      window.playNote = function (fr, p, d, tt) { t.push(+tt.toFixed(3)); det.push(p && p.detune); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { t.push(-1); }
      window.playNote = oP; return { t: t, det: det };
    };
    const a2 = cap();
    const out = { plainN: a2.t.length, plainAt: a2.t.slice(0, 4).join(',') };
    const L2 = E.getCfg().layers[0];
    L2.twist = 100; E.getCfg(); E._cfg = E.getCfg();
    const c2 = cap();
    out.twistN = c2.t.length; out.twistAt = c2.t.slice(0, 3).join(',');
    // RESTATED 2026-09-17 — a burst is a SUBDIVISION OF ITS OWN SLOT, not a
    // fixed 120 ms stutter (user: "a lot of these notes are too small and
    // rapidly placed, it's not musical"). So the claim is the floor and the
    // ceiling: every gap inside the first burst is at least a 16th triplet of
    // the bar and no wider than the slot it subdivides. 4 pulses over 1 bar at
    // 120 bpm = a 0.5 s slot, and the floor is 2/24 s ≈ 0.083.
    const gaps2 = c2.t.slice(1, 4).map((v, i) => +(v - c2.t[i]).toFixed(3)).filter((g) => g > 0);
    out.burstGaps = gaps2.join(',');
    out.burstFloorOK = gaps2.length > 0 && gaps2.every((g) => g >= 0.082 && g <= 0.5);
    out.twistAgain = cap().t.length;
    delete L2.twist;
    L2.motion = 100; E.getCfg(); E._cfg = E.getCfg();
    out.detN = [...new Set(cap().det.filter((x) => Number.isFinite(x)))].length;
    L2.fine = 50; E.getCfg(); E._cfg = E.getCfg();
    const withFine = cap().det.filter((x) => Number.isFinite(x));
    out.fineMean = Math.round(withFine.reduce((x, y) => x + y, 0) / Math.max(1, withFine.length));
    out.fineMin = Math.min.apply(null, withFine);
    delete L2.fine;
    L2.motion = 0; E.getCfg(); E._cfg = E.getCfg();
    out.detOffN = cap().det.filter((x) => Number.isFinite(x)).length;
    out.pruned = JSON.stringify({ t: E.getCfg().layers[0].twist, m: E.getCfg().layers[0].motion });
    return out;
  });
  // A burst is EXTRA notes packed tight, not the same notes moved.
  ok('twist bursts the line into packed runs — inside its own slot, never finer than a 16th triplet',
    twm.plainN === 4 && twm.plainAt === '0,0.5,1,1.5' &&
    twm.twistN > twm.plainN && /^0,0\./.test(twm.twistAt) && twm.burstFloorOK, JSON.stringify(twm));
  ok('and the burst replays for a take', twm.twistN === twm.twistAgain, JSON.stringify(twm));
  // Motion ADDS to `params.detune` — v1 warns that `fine` writes the same field,
  // so replacing it would flatten the two together.
  ok('motion scatters the detune, and writes none when off',
    twm.detN > 1 && twm.detOffN === 0, JSON.stringify(twm));
  // ±18 cents at motion 100, so with fine=50 every value stays well above 0 —
  // replacing rather than adding would centre the wobble on zero instead.
  ok('motion ADDS to `fine` rather than replacing it',
    twm.fineMean > 30 && twm.fineMin > 20, JSON.stringify(twm));
  ok('both prune away', twm.pruned === '{}', twm.pruned);

  // ---- shaping the line: contour, stutter, syncopate ------------------------
  const shp = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 12, steps: 12 };
    L.part.pitch = { kind: 'walk', degree: 1, span: 5 };
    delete L.slide; delete L.ornament; delete L.strum;
    E.getCfg(); E._cfg = E.getCfg();
    const midis = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(Math.round(69 + 12 * Math.log2(fr / 440))); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { f.push(-1); }
      window.playNote = oP; return f.slice(0, 12);
    };
    const mean = (a2) => Math.round(a2.reduce((x, y) => x + y, 0) / Math.max(1, a2.length) * 10) / 10;
    const reps = (a2) => { let r = 0; for (let i = 1; i < a2.length; i++) if (a2[i] === a2[i - 1]) r++; return r; };
    const t = E.getCfg().layers[0].part.pitch;
    const out = {};
    out.plainMean = mean(midis()); out.plainReps = reps(midis());
    // CONTOUR raises or lowers the line's CENTRE — v2's walk scatters around a
    // fixed centre rather than accumulating, so up-vs-down TRANSITIONS is the
    // wrong quantity (it shows almost nothing and read as a dead control).
    t.contour = 100; E.getCfg(); E._cfg = E.getCfg(); out.upMean = mean(midis());
    t.contour = -100; E.getCfg(); E._cfg = E.getCfg(); out.downMean = mean(midis());
    delete t.contour;
    t.stutter = 100; E.getCfg(); E._cfg = E.getCfg(); out.stutReps = reps(midis());
    delete t.stutter; E.getCfg(); E._cfg = E.getCfg();
    out.prunedWalk = JSON.stringify({ c: t.contour, s: t.stutter, g: t.gravity });
    // SYNCOPATE weights the odd slots of a chance fill
    const L2 = E.getCfg().layers[0];
    L2.part.rhythm = { kind: 'chance', steps: 16, chance: 50 };
    L2.part.pitch = { kind: 'fixed', degree: 1 };
    E.getCfg(); E._cfg = E.getCfg();
    const slots = () => {
      const o = []; const oP = window.playNote;
      window.playNote = function (fr, p, d, tt) { o.push(Math.round(tt / 2 * 16) % 16); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = oP; return o;
    };
    const s0 = slots(); out.straight = s0.filter((x) => x & 1).length + '/' + s0.length;
    L2.part.rhythm.syncop = 100; E.getCfg(); E._cfg = E.getCfg();
    const s1 = slots(); out.synced = s1.filter((x) => x & 1).length + '/' + s1.length;
    return out;
  });
  ok('contour raises and lowers the line\'s centre',
    shp.upMean > shp.plainMean && shp.downMean < shp.plainMean, JSON.stringify(shp));
  ok('stutter repeats the previous degree, and nothing repeats without it',
    shp.plainReps === 0 && shp.stutReps > 0, JSON.stringify(shp));
  // GRAVITY IS DELIBERATELY ABSENT: v2 picks by index into the sounding tone
  // set, so every pick is already a chord tone and it measured as a literal
  // no-op. This pins that it was not shipped as a dead control.
  ok('gravity is not shipped — v2 has nothing for it to pull to',
    shp.prunedWalk === '{}', shp.prunedWalk);
  ok('syncopate throws a chance fill onto the offbeat',
    shp.straight !== shp.synced && +shp.synced.split('/')[0] === +shp.synced.split('/')[1],
    JSON.stringify(shp));

  // ---- articulation: slide and ornament ------------------------------------
  // Both are v1's own helpers (`_ambSlideMs`, `_ambOrnamentFlicks`) and both
  // work in DEGREES — a slide fires on a leap of 3+ source tones, an ornament
  // flicks to the neighbour degree. v2's pitch contract returns MIDI, so the
  // resolved degree is stashed on the part and carried on the note.
  const art = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 8, steps: 8 };
    L.part.pitch = { kind: 'walk', degree: 1, span: 8 };   // big leaps, so slide can fire
    L.part.shape = { lenRatio: 90 };
    delete L.slide; delete L.ornament; delete L.strum; delete L.followSalt; delete L.wordOut;
    E.getCfg(); E._cfg = E.getCfg();
    const cap = () => {
      let n = 0, glides = 0; const oP = window.playNote;
      window.playNote = function (fr, p) { n++; if (p && p.glideMs > 0) glides++; };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 4, 0, 0, E.getCfg()); } catch (e) { n = -1; }
      window.playNote = oP; return { n: n, glides: glides };
    };
    const a2 = cap();
    const out = { plainN: a2.n, plainG: a2.glides };
    const L2 = E.getCfg().layers[0];
    L2.slide = 100; E.getCfg(); E._cfg = E.getCfg();
    const c2 = cap(); out.slideN = c2.n; out.slideG = c2.glides;
    delete L2.slide;
    L2.ornament = 100; E.getCfg(); E._cfg = E.getCfg();
    out.ornN = cap().n; out.ornAgain = cap().n;
    delete L2.ornament; E.getCfg(); E._cfg = E.getCfg();
    out.pruned = JSON.stringify({ s: E.getCfg().layers[0].slide, o: E.getCfg().layers[0].ornament });
    out.backN = cap().n;
    return out;
  });
  // A slide only fires on a LEAP and only some of the time — "every note glides"
  // would mean it had been read as portamento, which is a different control.
  ok('slide glides SOME notes and adds none',
    art.plainG === 0 && art.slideG > 0 && art.slideG < art.slideN && art.slideN === art.plainN,
    JSON.stringify(art));
  ok('ornament ADDS grace notes, and the figure replays for a take',
    art.ornN > art.plainN && art.ornN === art.ornAgain, JSON.stringify(art));
  ok('both prune away and the line returns to plain',
    art.pruned === '{}' && art.backN === art.plainN, JSON.stringify(art));

  // ---- follow salt (the "Keys" behaviour) ----------------------------------
  // Salt sub-divides ONE chord instance into colour segments, and a chord layer
  // samples its chord once at the onset and holds — so those changes were
  // inaudible. `_ambBedSaltPlan` (v1's own) returns one note per TONE spanning
  // the contiguous run of segments it belongs to: a shared tone gets a single
  // long note, a leaver simply ends, an arrival starts at its boundary.
  const salt = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    cfg.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }],
                 salt: { colors: 80, scatter: 0 } };
    cfg.barsPerChord = 2;
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 2;
    L.part.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    L.part.pitch = { kind: 'chord', voices: 3 };
    L.part.shape = { lenRatio: 100 };
    delete L.followSalt; delete L.strum; delete L.wordOut; delete L.speed;
    E.getCfg(); E._cfg = E.getCfg();
    const shot = () => {
      const r = []; const oP = window.playNote;
      window.playNote = function (fr, p, d, t) {
        r.push(Math.round(69 + 12 * Math.log2(fr / 440)) + '/' + d + '@' + (+t.toFixed(2)));
      };
      E._barGridAnchor = 0; E._v2Phase = {}; E._progAnchor = 0; E._playStartAt = 0;
      try { window._v2Tick(E, 0, 4, 0, 0, E.getCfg()); } catch (e) { r.push('ERR'); }
      window.playNote = oP; return r.join(' ');
    };
    const out = { held: shot() };
    const L2 = E.getCfg().layers[0];
    L2.followSalt = 1; E.getCfg(); E._cfg = E.getCfg();
    out.salted = shot(); out.again = shot();
    cfg.prog.salt = { colors: 0, scatter: 0 }; E.getCfg(); E._cfg = E.getCfg();
    out.noColours = shot();
    L2.followSalt = 0; E.getCfg();
    out.prunedFalsy = E.getCfg().layers[0].followSalt === undefined;
    L2.followSalt = true; E.getCfg();
    out.canon = E.getCfg().layers[0].followSalt;
    delete L2.followSalt; cfg.prog = { on: false, chords: [] }; E.getCfg();
    out.pruned = E.getCfg().layers[0].followSalt === undefined;
    return out;
  });
  ok('a chord layer holds what it struck — every tone the full length',
    salt.held === '60/4000@0 64/4000@0 67/4000@0', JSON.stringify(salt));
  // The tone the colour DROPS ends early; the ones it keeps ring on untouched.
  const _durs = (str) => str.split(' ').map((x) => +x.split('/')[1].split('@')[0]).filter((x) => x > 0);
  const _arrivals = (str) => str.split(' ').filter((x) => +x.split('@')[1] > 0).length;
  ok('following salt ends a leaving tone early and rings the shared ones on',
    salt.salted !== salt.held &&
    _durs(salt.salted).some((d) => d < 4000) && _durs(salt.salted).some((d) => d === 4000),
    JSON.stringify(salt));
  // ARRIVALS are the other half, and were silently absent: `_ambBedSaltPlan`
  // asks `_ambVoiceCap(bed)`, and a shim without `density` resolved it to ONE,
  // so every arriving colour tone was trimmed straight off. A leaver-only check
  // passed throughout.
  ok('and a colour tone that ARRIVES starts mid-chord',
    _arrivals(salt.salted) > 0 && _arrivals(salt.held) === 0, JSON.stringify(salt));
  ok('and it replays identically for a take', salt.salted === salt.again, JSON.stringify(salt));
  // No colours = nothing segmented to do = the plain path, byte-identical.
  ok('with no salt colours it is a no-op, and it prunes away',
    salt.noColours === salt.held && salt.pruned, JSON.stringify(salt));
  ok('a falsy stored value is dropped and a truthy one canonicalised',
    salt.prunedFalsy === true && salt.canon === 1, JSON.stringify(salt));

  // ---- words as notes, and the speech FX -----------------------------------
  // The speech FX (chop / order / reverse / rate / trim) ALREADY worked on a v2
  // layer: `_ambLearnPlay` — which v2 has called since the speech instrument
  // landed — resolves them through `_ambSpeechOpt(L)`. They needed coercion and
  // controls, nothing else. The WORD translator is new capability: v1's own
  // `_ambEmitWordPassage`, given a flat shim (the `adsrShim` pattern).
  const wrd = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true;
    L.instrument.voice = 'speech'; L.instrument.tone = 'sine'; L.instrument.text = 'abc def.';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    delete L.wordOut; delete L.speech; delete L.strum; delete L.speed;
    E.getCfg(); E._cfg = E.getCfg();
    const cap = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(Math.round(69 + 12 * Math.log2(fr / 440))); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 4, 0, 0, E.getCfg()); } catch (e) { f.push(-1); }
      window.playNote = oP; return f;
    };
    const out = {};
    // nothing rendered, so 'speak' is SILENT — which is v2's contract: an
    // unwritten line never stalls the tick and never becomes something else
    out.speakOnly = cap().length;
    const L2 = E.getCfg().layers[0];
    L2.wordOut = 'play'; E.getCfg(); E._cfg = E.getCfg();
    const p2 = cap(); out.playN = p2.length; out.playMidis = p2.slice(0, 6).join(' ');
    L2.wordOut = 'both'; E.getCfg(); E._cfg = E.getCfg();
    out.bothN = cap().length;
    // THE BUFFER HALF. Write real lines (stubbed synth, as the speech section
    // above does) and count `_ambLearnPlay` — 'play' must not reach it, 'both'
    // and 'speak' must.
    const ac = Tone.getContext().rawContext;
    const origSynth = window._ambLearnSynth;
    window._ambLearnSynth = async () => {
      const n2 = Math.round(ac.sampleRate * 0.2), bf = ac.createBuffer(1, n2, ac.sampleRate);
      const d = bf.getChannelData(0);
      for (let i = 0; i < n2; i++) d[i] = Math.sin(2 * Math.PI * 300 * i / ac.sampleRate) * 0.4;
      return bf;
    };
    try { await window._v2.speechWrite(E, E.getCfg().layers[0]); } catch (e) { out.writeErr = e.message; }
    window._ambLearnSynth = origSynth;
    const origPlay = window._ambLearnPlay;
    const bufCalls = () => {
      let c = 0;
      window._ambLearnPlay = function () { c++; return 0.2; };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 4, 0, 0, E.getCfg()); } catch (e) {}
      window._ambLearnPlay = origPlay;
      return c;
    };
    L2.wordOut = 'play'; E.getCfg(); E._cfg = E.getCfg();
    out.bufOnPlay = bufCalls();
    L2.wordOut = 'both'; E.getCfg(); E._cfg = E.getCfg();
    out.bufOnBoth = bufCalls();
    delete L2.wordOut; E.getCfg(); E._cfg = E.getCfg();
    out.bufOnSpeak = bufCalls();
    L2.speech = { chop: 4, reverse: 1, rate: 120 }; E.getCfg();
    out.speechStored = JSON.stringify(E.getCfg().layers[0].speech);
    delete L2.wordOut; delete L2.speech; E.getCfg();
    out.pruned = E.getCfg().layers[0].wordOut === undefined &&
                 E.getCfg().layers[0].speech === undefined;
    L2.instrument.voice = 'synth'; E.getCfg();
    return out;
  });
  ok('with nothing written, a speaking layer is silent — never something else',
    wrd.speakOnly === 0, JSON.stringify(wrd));
  // a·b·c then d·e·f on the chromatic alphabet map — v1's own translator
  ok('Words as notes plays the letters, with no rendered audio needed',
    wrd.playN === 12 && wrd.playMidis === '48 49 50 51 52 53', JSON.stringify(wrd));
  ok('Both keeps the notes alongside the speech', wrd.bothN === 12, JSON.stringify(wrd));
  // 'play' makes the layer purely instrumental — it must NOT also speak.
  ok('Notes-only skips the spoken buffer; Both and Speech still play it',
    wrd.bufOnPlay === 0 && wrd.bufOnBoth > 0 && wrd.bufOnSpeak > 0, JSON.stringify(wrd));
  ok('the speech FX coerce through v1\'s own normalizer, and prune away',
    wrd.speechStored === '{"chop":4,"order":"fwd","reverse":1,"rate":120,"start":0,"len":100}' &&
    wrd.pruned, JSON.stringify(wrd));

  // ---- chord VOICING, through v1's own voicer ------------------------------
  // Chaos / Chords / Chords+ / Monk, plus Spread and Variety, are
  // `_ambVoiceProgChord`'s whole vocabulary — the most musically-loaded code in
  // the app, and re-deriving it here would be a second implementation. It reads
  // a BED-shaped layer, so it gets a shim (the `_ambApplyAdsr` pattern): the
  // field names differ, the meanings do not.
  const voi = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    cfg.prog = { on: true, chords: [{ root: 0, intervals: [0, 4, 7] },
                                    { root: 5, intervals: [0, 4, 7] },
                                    { root: 7, intervals: [0, 4, 7] }] };
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 4, steps: 16 };
    L.part.pitch = { kind: 'chord', voices: 3 };
    delete L.notes; delete L.keyOv; delete L.strum; delete L.speed; delete L.toneSeq;
    E.getCfg(); E._cfg = E.getCfg();
    const midis = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(Math.round(69 + 12 * Math.log2(fr / 440))); };
      E._barGridAnchor = 0; E._v2Phase = {}; E._progAnchor = 0; E._playStartAt = 0;
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { f.push('ERR'); }
      window.playNote = oP; return f.slice(0, 12).join(' ');
    };
    const out = { simple: midis() };
    const t = E.getCfg().layers[0].part.pitch;
    t.chordMode = 'chaos'; E.getCfg(); E._cfg = E.getCfg();
    out.voiced = midis();
    t.spread = 2; E.getCfg(); E._cfg = E.getCfg();
    out.spread = midis();
    t.spread = 0; t.chordMode = 'monk'; t.variety = 90; t.feel = 'stochastic';
    E.getCfg(); E._cfg = E.getCfg();
    out.monk = midis();
    // SUBDIVIDE — grouped by onset time so a voicing is one chord, not 3 notes
    delete t.feel; t.chordMode = 'chaos'; t.variety = 0;
    const groups = () => {
      const g = []; let cur = null, lastT = -1; const oP = window.playNote;
      window.playNote = function (fr, p, d, tt) {
        if (tt !== lastT) { cur = []; g.push(cur); lastT = tt; }
        cur.push(Math.round(69 + 12 * Math.log2(fr / 440)));
      };
      E._barGridAnchor = 0; E._v2Phase = {}; E._progAnchor = 0; E._playStartAt = 0;
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { g.push(['ERR']); }
      window.playNote = oP; return g.slice(0, 4).map((x) => x.join('/')).join(' ');
    };
    t.subdiv = 1; E.getCfg(); E._cfg = E.getCfg(); out.sub1 = groups();
    t.subdiv = 4; E.getCfg(); E._cfg = E.getCfg(); out.sub4 = groups();
    t.feel = 'stochastic'; E.getCfg(); E._cfg = E.getCfg();
    out.stoch = groups(); out.stochAgain = groups();
    delete t.chordMode; E.getCfg(); E._cfg = E.getCfg();
    out.pruned = JSON.stringify({ m: t.chordMode, s: t.spread, v: t.variety, f: t.feel, d: t.subdiv });
    out.back = midis();
    cfg.prog = { on: false, chords: [] }; E.getCfg();
    return out;
  });
  // A simple stack repeats the same three tones; the voicer re-voices per slot.
  ok('a chord mode hands the voicing to v1\'s own voicer',
    voi.simple === '60 64 67 60 64 67 60 64 67 60 64 67' && voi.voiced !== voi.simple,
    JSON.stringify(voi));
  ok('Spread widens the voicing', voi.spread !== voi.voiced, JSON.stringify(voi));
  // Extensions need chordsplus/monk AND variety > 0; sus/aug need monk. (A first
  // probe used `chords` WITH variety and `monk` WITHOUT it, so every mode agreed
  // — correct behaviour, wrong test.)
  ok('Monk with variety and a stochastic feel reaches the sus/aug variants',
    voi.monk !== voi.voiced, JSON.stringify(voi));
  // Absent = the simple stack, byte-identical — which is what makes this additive.
  ok('clearing the mode prunes every voicing field and restores the stack',
    voi.pruned === '{}' && voi.back === voi.simple, JSON.stringify(voi));
  // SUBDIVIDE — how many voicings a chord gets. `_ambProgSpanAt` resolves both
  // the sub-slot and a chordStep unique per group OCCURRENCE, which is what
  // keeps a stochastic feel evolving instead of repeating every pass.
  ok('Subdivide 1 holds ONE voicing per chord; 4 walks the variants inside it',
    new Set(voi.sub1.split(' ')).size === 1 && new Set(voi.sub4.split(' ')).size > 1,
    JSON.stringify({ sub1: voi.sub1, sub4: voi.sub4 }));
  ok('a stochastic feel picks differently, and replays for a take',
    voi.stoch !== voi.sub4 && voi.stoch === voi.stochAgain, JSON.stringify(voi));

  // ---- the scheduled tone --------------------------------------------------
  // v1's own `_ambToneSeqBoxHtml` + `_ambToneAt`, and — like the Key override —
  // NO wiring in v2: the handler is delegated on the panel host and resolves the
  // layer through `_ambCardKey`, which falls back to `[data-phkey]`. A v2 card
  // has carried that since slice 5, so it answers `v2:<id>` already.
  const tseq = await page.evaluate(async () => {
    const E = _masterEng;
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    card.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const out = { cardKey: (typeof _ambCardKey === 'function') ? _ambCardKey(card) : 'no fn' };
    const box = card.querySelector('.ambient-toneseq-box');
    out.box = !!box;
    if (!box) return out;
    const add = box.querySelector('.ambient-toneseq-add');
    out.addBtn = !!add;
    if (add) { add.click(); await zz(150); }
    out.stored = JSON.stringify(E.getCfg().layers[0].toneSeq);
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    L.part.pitch = { kind: 'fixed', degree: 1 };
    L.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 1 }, { tone: 'square', bars: 1 }] };
    delete L.strum; delete L.speed;
    E.getCfg(); E._cfg = E.getCfg();
    const types = () => {
      const t = []; const oP = window.playNote;
      window.playNote = function (f, p) { t.push(p && p.type); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 8, 0, 0, E.getCfg()); } catch (e) { t.push('ERR'); }
      window.playNote = oP; return t.slice(0, 4).join(',');
    };
    out.cycled = types();
    L.toneSeq.on = 0; E.getCfg(); E._cfg = E.getCfg();
    out.off = types();
    delete L.toneSeq; E.getCfg();
    return out;
  });
  ok('a v2 card answers `_ambCardKey`, which is how v1\'s delegated handlers find it',
    tseq.cardKey === 'v2:1', String(tseq.cardKey));
  ok('the scheduled-tone box renders and v1\'s own Add handler writes to it',
    tseq.box && tseq.addBtn && tseq.stored === '{"on":1,"steps":[{"tone":"","bars":4}]}',
    JSON.stringify(tseq));
  // Resolved per NOTE at the note's own time — a tone read once per tick would
  // change on bar boundaries a whole lookahead early.
  ok('the voice cycles on the bar clock, and stops when switched off',
    tseq.cycled === 'sine,square,sine,square' && tseq.off === 'sine,sine,sine,sine',
    JSON.stringify(tseq));

  // ---- the sweep's pool, Hold, and the Max events retirement ---------------
  const pool = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.instrument.register = 4;
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 8, steps: 8 };
    L.part.pitch = { kind: 'series', degree: 1, dir: 'up' };
    L.part.shape = { lenRatio: 90 };
    delete L.notes; delete L.keyOv; delete L.strum; delete L.speed;
    E.getCfg(); E._cfg = E.getCfg();
    const midis = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(Math.round(69 + 12 * Math.log2(fr / 440))); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { f.push('ERR'); }
      window.playNote = oP; return f.slice(0, 8).join(' ');
    };
    const out = { unbounded: midis() };
    const L2 = E.getCfg().layers[0];
    L2.part.pitch.octaves = 1; E.getCfg(); E._cfg = E.getCfg();
    out.oneOct = midis();
    L2.part.pitch.randomness = 90; E.getCfg(); E._cfg = E.getCfg();
    out.scatter = midis(); out.scatterAgain = midis();
    delete L2.part.pitch.randomness; delete L2.part.pitch.octaves;
    // HOLD vs LENGTH — a SPARSE pattern is where they diverge, because Length
    // stretches with the gaps and Hold does not.
    L2.part.rhythm = { kind: 'euclid', pulses: 2, steps: 8, cells: [] };
    L2.part.pitch = { kind: 'fixed', degree: 1 };
    E.getCfg(); E._cfg = E.getCfg();
    const durs = () => {
      const d = []; const oP = window.playNote;
      window.playNote = function (f, p, dm) { d.push(dm); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = oP; return d.slice(0, 2).join(',');
    };
    out.byLength = durs();
    L2.part.shape.holdSteps = 2; E.getCfg(); E._cfg = E.getCfg();
    out.byHold = durs();
    delete L2.part.shape.holdSteps;
    L2.part.rhythm = { kind: 'pulse', n: 8, steps: 8 }; E.getCfg(); E._cfg = E.getCfg();
    const n = () => {
      let c = 0; const oP = window.playNote; window.playNote = function () { c++; };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = oP; return c;
    };
    out.uncapped = n();
    // MAX EVENTS IS RETIRED (2026-09-18) — and this is the MIGRATION guard.
    // Retiring a control that made sound leaves a worse bug than it fixes if
    // the STORED field survives: a project with one set would play a truncated
    // cycle with nothing on the card able to switch it off. So normalize
    // deletes it, and the engine ignores it — both halves, because either one
    // alone is the unrecoverable state.
    L2.part.shape.maxEvents = 3; E.getCfg(); E._cfg = E.getCfg();
    out.capped = n();
    out.migrated = !('maxEvents' in (L2.part.shape || {}));
    delete L2.part.shape.maxEvents; E.getCfg();
    return out;
  });
  // OPT-IN: wrapping the pool unconditionally broke `down` (descending from the
  // bottom wraps to the TOP by definition), which the direction check caught.
  ok('with no Octaves the sweep is unbounded, exactly as before',
    pool.unbounded === '60 62 64 65 67 69 71 72', JSON.stringify(pool));
  ok('Octaves bounds the pool and the sweep WRAPS inside it',
    pool.oneOct === '60 62 64 65 67 69 71 60', JSON.stringify(pool));
  ok('Scatter jumps about the pool, and replays for a take',
    pool.scatter !== pool.oneOct && pool.scatter === pool.scatterAgain, JSON.stringify(pool));
  // Length is a % of the ONSET span, Hold is N steps of the GRID — they answer
  // different questions and a sparse pattern is where that shows.
  ok('Hold sizes the note off the step grid, where Length sizes it off the gaps',
    pool.byLength === '900,900' && pool.byHold === '500,500', JSON.stringify(pool));
  ok('a retired Max events neither caps the cycle nor survives a normalize',
    pool.uncapped === 8 && pool.capped === 8 && pool.migrated === true, JSON.stringify(pool));

  // ---- rhythm vary ---------------------------------------------------------
  // v1's rule verbatim, from all four of its euclid renderers: a seed hit is
  // dropped at 0.40× the setting, a silent slot added at 0.22×. Asymmetric on
  // purpose — it thins harder than it thickens, which is what keeps a varied
  // pattern recognisable instead of filling in.
  const vary = await page.evaluate(async () => {
    // PER-CYCLE VARIATION IS A CHOICE NOW (`part.vary`) — the default is that
    // playback plays the TAKE the drawing shows, every cycle. This check's
    // whole phenomenon is observed ACROSS cycles, so it asks for the mode it
    // is testing; the contract it pins is unchanged.
    try { (_masterEng.getCfg().layers || [])[0].part.vary = 1; _masterEng.getCfg(); } catch (e) {}
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'euclid', pulses: 4, steps: 8, cells: [] };
    L.part.pitch = { kind: 'fixed', degree: 1 };
    delete L.strum; delete L.keyOv; delete L.notes; delete L.speed; delete L.restProb;
    E.getCfg(); E._cfg = E.getCfg();
    // the onset POSITIONS per cycle, not just the counts — the same count can
    // hide a pattern that never actually moved
    const cycles = () => {
      const per = {}; const oP = window.playNote;
      window.playNote = function (f, p, d, t) {
        const c = Math.floor(t / 2); (per[c] = per[c] || []).push(Math.round((t - c * 2) / 2 * 8));
      };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 12, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = oP;
      return [0, 1, 2, 3, 4, 5].map((c) => (per[c] || []).join('')).join('|');
    };
    const out = { steady: cycles() };
    const L2 = E.getCfg().layers[0];
    L2.part.rhythm.vary = 70; E.getCfg(); E._cfg = E.getCfg();
    out.varied = cycles();
    out.again = cycles();
    L2.part.rhythm.vary = 0; E.getCfg();
    out.pruned = E.getCfg().layers[0].part.rhythm.vary === undefined;
    out.afterPrune = cycles();
    return out;
  });
  ok('with no vary the pattern repeats exactly',
    // RESTATED 2026-09-09: E(4,8) at Push 0 is `0246`, not `1357`. The
    // generator's accumulator tests AFTER adding, so its first hit landed at
    // `ceil(steps/pulses) - 1` and Push 0 already pushed ("at 0 all notes are
    // set forward 3 values" — 2 of 8 began on step 3). v2 normalises the phase
    // so Push 0 starts on the beat. Same contract: no vary, no movement.
    vary.steady === '0246|0246|0246|0246|0246|0246' && vary.afterPrune === vary.steady,
    JSON.stringify(vary));
  // Distinct per cycle, measured on the onset POSITIONS: the same count can hide
  // a pattern that never moved. (Counts alone misled once here — a 2,5,2,5
  // alternation over four cycles read as a seeding defect and was not.)
  // …and PUT IT BACK: these run in ONE page against ONE cfg, and a `vary`
  // left on is the next check's bug (it snapshots the part AFTER this was
  // set, so its own restore would keep it).
  await page.evaluate(() => { try {
    delete (_masterEng.getCfg().layers || [])[0].part.vary; _masterEng.getCfg();
  } catch (e) {} });
  ok('vary re-rolls the pattern every cycle, differently each time',
    vary.varied !== vary.steady && new Set(vary.varied.split('|')).size >= 5,
    JSON.stringify(vary));
  ok('and the same take replays it identically', vary.varied === vary.again, JSON.stringify(vary));

  // ---- the per-layer KEY override -----------------------------------------
  // `keyOv` was coerced and READ from the day v2 asked `_ambNotesOf`; what it
  // lacked was a door. v1 builds that control inline in its schema renderer, so
  // it was EXTRACTED into `_ambKeyOvHtml` and both models call it — and because
  // everything in it is keyed on `data-kokey` and v1's wiring is DELEGATED on
  // the panel host by that key, a v2 card inside the host gets working controls
  // with NO wiring of its own. This check is what proves that claim.
  const kov = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    card.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const id = card.getAttribute('data-v2id') | 0;
    const md = card.querySelector('.amb-keyov-mode[data-kokey="v2:' + id + '"]');
    const out = { present: !!md, inHost: !!(md && md.closest('#mix-view')) };
    if (!md) return out;
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 2, steps: 16 };
    L.part.pitch = { kind: 'chord', voices: 3 };
    delete L.notes; delete L.strum; delete L.keyOv;
    E.getCfg(); E._cfg = E.getCfg();
    const cap = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(Math.round(69 + 12 * Math.log2(fr / 440))); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { f.push('ERR'); }
      window.playNote = oP; return [...new Set(f)].slice(0, 3).join(',');
    };
    out.inherited = cap();
    // driven through V1's OWN delegated handler — no v2 code involved
    md.value = 'key'; md.dispatchEvent(new Event('change', { bubbles: true }));
    await zz(140);
    out.afterMode = JSON.stringify(E.getCfg().layers[0].keyOv);
    const rt = card.querySelector('.amb-keyov-root[data-kokey="v2:' + id + '"]');
    if (rt) { rt.value = '9'; rt.dispatchEvent(new Event('change', { bubbles: true })); await zz(120); }
    out.afterRoot = JSON.stringify(E.getCfg().layers[0].keyOv);
    E.getCfg(); E._cfg = E.getCfg();
    out.withOwnKey = cap();
    md.value = ''; md.dispatchEvent(new Event('change', { bubbles: true }));
    await zz(140);
    E.getCfg(); E._cfg = E.getCfg();
    out.cleared = E.getCfg().layers[0].keyOv === undefined;
    out.backToInherit = cap();
    // …and v1's OWN card must still work — `_ambKeyOvHtml` was extracted FROM it.
    try {
      _ambAddExtra(E, 'motif'); _ambRebuildMaster();
      await zz(300);
      document.querySelectorAll('.ambient-layer:not(.v2-layer)').forEach((c2) => {
        c2.classList.remove('collapsed');
        c2.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
      });
      const m1 = document.querySelector('.ambient-layer:not(.v2-layer) .amb-keyov-mode');
      out.v1Present = !!m1;
      if (m1) {
        out.v1Rows = ['amb-keyov-yokerow', 'amb-keyov-keyrow', 'amb-keyov-progrow']
          .every((k) => !!document.querySelector('.ambient-layer:not(.v2-layer) .' + k));
        const kk = m1.dataset.kokey;
        m1.value = 'key'; m1.dispatchEvent(new Event('change', { bubbles: true }));
        await zz(140);
        out.v1Stored = JSON.stringify((_ambLayerByKey(E, kk) || {}).keyOv);
        m1.value = ''; m1.dispatchEvent(new Event('change', { bubbles: true }));
        await zz(140);
        out.v1Cleared = (_ambLayerByKey(E, kk) || {}).keyOv === undefined;
      }
    } catch (e) { out.v1Err = e.message; }
    return out;
  });
  ok('a v2 card carries v1\'s Key control, inside the panel host',
    kov.present && kov.inHost, JSON.stringify(kov));
  ok('v1\'s own delegated wiring drives it — v2 adds none',
    kov.afterMode === '{"mode":"key","root":0,"scale":"major"}' &&
    kov.afterRoot === '{"mode":"key","root":9,"scale":"major"}', JSON.stringify(kov));
  // The point: a layer that does NOT follow the area's key.
  // The extraction touched V1's OWN renderer, and no audio gate can see a
  // broken control — so v1's copy is pinned here too.
  ok('v1\'s own Key control still renders and round-trips after the extraction',
    kov.v1Present && kov.v1Rows && kov.v1Stored === '{"mode":"key","root":0,"scale":"major"}' && kov.v1Cleared,
    JSON.stringify({ p: kov.v1Present, r: kov.v1Rows, s: kov.v1Stored, c: kov.v1Cleared }));
  // The digits moved when Chord started building in THIRDS over a scale
  // (C+E+G, not the adjacent C+D+E it used to play) — the contract is
  // unchanged, so this is restated on it: an own key plays a DIFFERENT chord
  // and Inherit puts the first one back. The relationship is asserted as well
  // as the pitches, so the next pitch change fails on meaning, not on digits.
  ok('a layer with its own key plays in it, and reverts on Inherit',
    kov.inherited === '60,64,67' && kov.withOwnKey === '69,73,76' &&
    kov.withOwnKey !== kov.inherited &&
    kov.cleared && kov.backToInherit === kov.inherited, JSON.stringify(kov));

  // ---- strum ---------------------------------------------------------------
  const strum = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    L.part.pitch = { kind: 'chord', voices: 4 };
    delete L.strum; delete L.strumFidelity; delete L.notes; delete L.speed;
    E.getCfg(); E._cfg = E.getCfg();
    const cap = () => {
      const r = []; const oP = window.playNote;
      window.playNote = function (f, p, d, t) { r.push({ t: +t.toFixed(3), m: Math.round(69 + 12 * Math.log2(f / 440)) }); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) {}
      window.playNote = oP; return r.slice(0, 4);
    };
    const out = {};
    const a2 = cap(); out.struckT = a2.map(x => x.t).join(','); out.struckM = a2.map(x => x.m).join(',');
    const L2 = E.getCfg().layers[0];
    L2.strum = 50; E.getCfg(); E._cfg = E.getCfg();
    const c2 = cap(); out.strumT = c2.map(x => x.t).join(','); out.strumM = c2.map(x => x.m).join(',');
    L2.strumFidelity = 100; E.getCfg(); E._cfg = E.getCfg();
    out.wanderM = cap().map(x => x.m).join(',');
    L2.strum = 0; delete L2.strumFidelity; E.getCfg();
    out.pruned = E.getCfg().layers[0].strum === undefined;
    return out;
  });
  // TIME is what these two are about; the pitches are the fixture, and they
  // moved with Chord's thirds (C E G B, a maj7, where it used to be the
  // adjacent C D E F). Pinned as "four distinct pitches" plus the digits, so a
  // chord collapsing to one note still fails here.
  const CHORD4 = '60,64,67,71';
  ok('with no strum a chord is STRUCK — every note at the same instant',
    strum.struckT === '0,0,0,0' && strum.struckM === CHORD4 &&
    new Set(strum.struckM.split(',')).size === 4, JSON.stringify(strum));
  ok('strum spreads the chord across a fraction of the span',
    strum.strumT === '0,0.333,0.667,1' && strum.strumM === CHORD4, JSON.stringify(strum));
  // v1's own `_ambStrumOrder` — fidelity 0 is low→high every time, higher wanders.
  ok('strum order wanders with fidelity, and only then',
    strum.wanderM !== CHORD4 && strum.pruned, JSON.stringify(strum));

  // ---- speed, and what a recorded part does when the chords move -----------
  const spd = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'euclid', pulses: 4, steps: 4, cells: [] };
    L.part.pitch = { kind: 'fixed', degree: 1 };
    delete L.speed; delete L.harmony; delete L.notes;
    E.getCfg(); E._cfg = E.getCfg();
    const times = () => {
      const t = []; const oP = window.playNote;
      window.playNote = function (f, p, d, tt) { t.push(+tt.toFixed(3)); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 4, 0, 0, E.getCfg()); } catch (e) { t.push('ERR'); }
      window.playNote = oP; return t.slice(0, 5).join(',');
    };
    const out = { normal: times() };
    const sel = document.querySelector('.v2-layer [data-f="speed"]');
    out.hasSpeed = !!sel;
    if (sel) {
      // A <select> writes a STRING — `_ambRateMult` tests `Number.isFinite`, so
      // an uncoerced store would have deleted it and the control would be dead.
      sel.value = '2'; sel.dispatchEvent(new Event('input', { bubbles: true }));
      E.getCfg(); E._cfg = E.getCfg();
      out.speedStored = E.getCfg().layers[0].speed;
      out.doubled = times();
      sel.value = '1'; sel.dispatchEvent(new Event('input', { bubbles: true }));
      E.getCfg();
      out.speedPruned = E.getCfg().layers[0].speed === undefined;
    }
    // HARMONY on a recorded part
    const L2 = E.getCfg().layers[0];
    L2.part.kind = 'recorded';
    L2.part.notes = [{ t: 0, midi: 60, dur: 0.2 }, { t: 0.25, midi: 62, dur: 0.2 },
                     { t: 0.5, midi: 64, dur: 0.2 }, { t: 0.75, midi: 67, dur: 0.2 }];
    L2.part.key = { root: 0, scale: 'major' };
    delete L2.harmony;
    E.getCfg(); E._cfg = E.getCfg();
    const midis = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(Math.round(69 + 12 * Math.log2(fr / 440))); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { f.push('ERR'); }
      window.playNote = oP; return f.slice(0, 4).join(',');
    };
    out.inC = midis();
    cfg.keyRoot = 9; cfg.keyScale = 'minor'; E.getCfg(); E._cfg = E.getCfg();
    out.fixedInAm = midis();
    L2.harmony = 'diatonic'; E.getCfg(); E._cfg = E.getCfg();
    out.diatonicInAm = midis();
    // the key a part was WRITTEN in must be stamped by the doors, not guessed
    out.stampedByAdopt = (() => {
      try {
        const before = JSON.stringify(L2.part.key);
        L2.part.key = null; E.getCfg();
        return before !== 'null';
      } catch (e) { return false; }
    })();
    cfg.keyRoot = 0; cfg.keyScale = 'major'; L2.part.kind = 'live'; delete L2.harmony; E.getCfg();
    return out;
  });
  ok('a v2 layer has a Speed control that stores a NUMBER',
    spd.hasSpeed && spd.speedStored === 2 && spd.speedPruned, JSON.stringify(spd));
  ok('speed scales the cycle', spd.normal === '0,0.5,1,1.5,2' && spd.doubled === '0,0.25,0.5,0.75,1',
    JSON.stringify(spd));
  // A recorded part is fixed material by default — that is what "recorded" means.
  ok('a recorded part plays as written when the key moves',
    spd.inC === '60,62,64,67' && spd.fixedInAm === '60,62,64,67', JSON.stringify(spd));
  // …and can be told to follow, through v1's own remapper: the same scale
  // DEGREES in the new key (C D E G in C major → A B C E in A minor).
  ok('Follow the key remaps a recorded part into the new key',
    spd.diatonicInAm === '57,59,60,64', JSON.stringify(spd));

  // ---- the mod matrix ------------------------------------------------------
  // It ALREADY WORKED on a v2 layer — `_ambSyncMods` walks `_ambWantSet` and
  // `_ambSyncTarget` reads `L.mod`, both joined in slice 5 — and had no
  // control. Measured before a line was written: setting `L.mod` built a live
  // source on the v2 chain. So this is a surface over working machinery, built
  // from v1's OWN `_ambModTarget` / `_ambWireModTarget`.
  const mod = await page.evaluate(async () => {
    const E = _masterEng;
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    card.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const id = card.getAttribute('data-v2id') | 0;
    const el = (s2) => document.getElementById('ambient-v2-' + id + '-' + s2);
    const out = {};
    out.controls = ['mod-sync', 'mod-vca-depth', 'mod-vca-rate', 'mod-vca-shape',
                    'mod-vco-depth', 'mod-vcf-depth'].every((k) => !!el(k));
    // absent by default — an untouched layer stores no matrix at all
    delete E.getCfg().layers[0].mod; E.getCfg();
    out.absent = E.getCfg().layers[0].mod === undefined;
    const d = el('mod-vcf-depth');
    if (!d) { out.stored = 'NO CONTROL'; return out; }
    d.value = 70; d.dispatchEvent(new Event('input', { bubbles: true }));
    await zz(150);
    const L = E.getCfg().layers[0];
    out.stored = JSON.stringify(L.mod && L.mod.vcf);
    try { _ambSyncMods(E); } catch (e) { out.err = e.message; }
    await zz(200);
    const e2 = E.mod && E.mod['v2:' + id];
    out.chainSrc = !!(e2 && e2.src);
    const sh = el('mod-vcf-shape');
    if (sh) { sh.value = 'triangle'; sh.dispatchEvent(new Event('change', { bubbles: true })); }
    out.shape = ((E.getCfg().layers[0].mod || {}).vcf || {}).shape;
    E.getCfg().layers[0].name = 'Rebuilt' + Math.floor(E.getCfg().layers[0].part.bars);
    window._v2.render(E);
    await zz(120);
    const dEl = el('mod-vcf-depth');
    out.rebuilt = !!dEl && dEl !== d;             // a genuinely new node
    out.afterRebuild = dEl ? dEl.value : 'gone';
    ['vca', 'vco', 'vcf'].forEach((t) => {
      const x = el('mod-' + t + '-depth');
      if (x) { x.value = 0; x.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    E.getCfg();
    out.pruned = E.getCfg().layers[0].mod === undefined;
    return out;
  });
  ok('the mod matrix has controls, from v1\'s own builder', mod.controls, JSON.stringify(mod));
  ok('it is absent by default and seeds from v1\'s defaults when first touched',
    mod.absent && mod.stored === '{"depth":70,"rate":15,"shape":"sine"}', JSON.stringify(mod));
  // The check that separates "stored" from "modulating".
  ok('a depth builds a live source on the v2 chain', mod.chainSrc === true, JSON.stringify(mod));
  ok('a shape change goes through v1\'s own handler', mod.shape === 'triangle', JSON.stringify(mod));
  ok('the values survive a REAL rebuild', mod.rebuilt === true && mod.afterRebuild === '70',
    JSON.stringify({ rebuilt: mod.rebuilt, v: mod.afterRebuild }));
  // Absent-is-neutral: zeroing every depth must leave NO store behind.
  ok('zeroing every depth prunes the matrix away again', mod.pruned === true, JSON.stringify(mod));

  // ---- groove: swing, accent, tight, and the AREA macros -------------------
  // Wired through v1's OWN helpers (`_ambSwingSec`, `_ambAccentVol`,
  // `_ambTightOn`/`_ambTightChoke`, `_ambEffRest`) — and the point is not the
  // three knobs: each of those helpers FOLDS IN the Area Groove macro, so
  // before this a v2 layer felt no swing, no accent and no density however the
  // Groove panel was set.
  const grv = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    delete cfg.groove;
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'euclid', pulses: 8, steps: 8, cells: [] };
    L.part.pitch = { kind: 'fixed', degree: 1 };
    delete L.swing; delete L.accent; delete L.tight; L.restProb = 0;
    E.getCfg(); E._cfg = E.getCfg();
    const cap = () => {
      const t = [], v = [], rel = [];
      const oP = window.playNote;
      window.playNote = function (f, p, d, tt) { t.push(+tt.toFixed(4)); v.push(p && p.volume); rel.push(p && p.release); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 2, 0, 0, E.getCfg()); } catch (e) { t.push('ERR'); }
      window.playNote = oP;
      return { gaps: t.slice(1, 5).map((x, i) => +(x - t[i]).toFixed(4)), vols: [...new Set(v)], rel: rel[0], n: t.length };
    };
    const out = {};
    out.straight = cap().gaps.join(',');
    const L2 = E.getCfg().layers[0];
    L2.swing = 60; E.getCfg(); E._cfg = E.getCfg();
    out.swung = cap().gaps.join(',');
    delete L2.swing;
    // the AREA macro, with NO per-layer value at all
    cfg.groove = { swing: 70 }; E.getCfg(); E._cfg = E.getCfg();
    out.areaSwing = cap().gaps.join(',');
    delete cfg.groove; E.getCfg(); E._cfg = E.getCfg();
    L2.accent = 90; E.getCfg(); E._cfg = E.getCfg();
    out.accentSpread = cap().vols.length;
    delete L2.accent; E.getCfg(); E._cfg = E.getCfg();
    L2.tight = 1; E.getCfg(); E._cfg = E.getCfg();
    out.tightRel = cap().rel;
    delete L2.tight; E.getCfg(); E._cfg = E.getCfg();
    out.looseRel = cap().rel;
    // and the groove DENSITY macro must thin the layer out
    out.dense = cap().n;
    cfg.groove = { density: 90 }; E.getCfg(); E._cfg = E.getCfg();
    out.thinned = cap().n;
    delete cfg.groove; E.getCfg(); E._cfg = E.getCfg();
    return out;
  });
  ok('swing shuffles the layer\'s own odd slots', grv.straight === '0.25,0.25,0.25,0.25' &&
    grv.swung === '0.325,0.175,0.325,0.175', JSON.stringify(grv));
  // THE REAL PRIZE: the Area Groove reaches a v2 layer that sets nothing.
  ok('the AREA groove swing reaches a v2 layer with no swing of its own',
    grv.areaSwing === '0.3375,0.1625,0.3375,0.1625', JSON.stringify(grv));
  ok('accent scatters the velocities', grv.accentSpread >= 2, JSON.stringify(grv));
  ok('tight clamps the release', grv.tightRel === 60 && grv.looseRel > 60, JSON.stringify(grv));
  ok('the AREA groove density thins a v2 layer out',
    grv.thinned < grv.dense && grv.dense > 0, JSON.stringify(grv));

  // ---- the per-layer note source ------------------------------------------
  // v2 always played the AREA harmony: a layer could not carry its own scale,
  // chord set, wrap or progression, which is one of the three structural gaps
  // between v2 and v1. The fix is not a second resolver — it is asking v1's
  // (`_ambNotesOf` → `_ambSrcRootPc` / `_ambScaleIntervals`), so the precedence
  // (area-progression lock, then keyOv, then the layer's own notes) and the key
  // transpose are v1's rather than a copy that can drift.
  const src = await page.evaluate(async () => {
    const E = _masterEng;
    const cfg = E.getCfg();
    cfg.prog = { on: false, chords: [] };
    cfg.keyOn = true; cfg.keyFollow = false; cfg.keyRoot = 0; cfg.keyScale = 'major';
    const L = E.getCfg().layers[0];
    L.on = true; L.present = true; L.instrument.voice = 'synth'; L.instrument.tone = 'sine';
    L.part.kind = 'live'; L.part.clock = 'bars'; L.part.bars = 1;
    L.part.rhythm = { kind: 'pulse', n: 2, steps: 16 };
    L.part.pitch = { kind: 'chord', voices: 3 };
    delete L.notes;
    E.getCfg(); window._v2.render(E);
    await zz(120);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    card.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    const btn = () => document.querySelector('.v2-layer .ambient-notes-btn');
    const cap = () => {
      const f = []; const oP = window.playNote;
      window.playNote = function (fr) { f.push(+fr.toFixed(1)); };
      E._barGridAnchor = 0; E._v2Phase = {};
      try { window._v2Tick(E, 0, 4, 0, 0, E.getCfg()); } catch (e) { f.push('ERR'); }
      window.playNote = oP;
      return [...new Set(f)].slice(0, 3).join(',');
    };
    const out = { hasBtn: !!btn(), h: btn() ? Math.round(btn().getBoundingClientRect().height) : 0 };
    if (!out.hasBtn) { out.scaleLabel = out.chordLabel = out.lockLabel = 'NO BUTTON'; out.scalePitches = out.chordPitches = out.lockPitches = ''; return out; }
    out.scaleLabel = btn().textContent;
    out.scalePitches = cap();
    // an explicit CHORD source — A minor, which is not in the C-major default
    L.notes = { type: 'chord', root: 9, intervals: [0, 3, 7] };
    E.getCfg(); window._v2.render(E);
    out.chordLabel = (document.querySelector('.v2-layer .ambient-notes-btn') || {}).textContent || '';
    out.chordPitches = cap();
    // the AREA PROGRESSION LOCK — v1 overrides every layer's source while one
    // is on, so the control must say so rather than appear to do nothing
    E.getCfg().prog = { on: true, chords: [{ root: 5, intervals: [0, 4, 7] }] };
    E.getCfg(); window._v2.render(E);
    const b2 = document.querySelector('.v2-layer .ambient-notes-btn') || { textContent: '', classList: { contains: () => false } };
    out.lockLabel = b2.textContent; out.locked = b2.classList.contains('ambient-src-locked');
    out.lockPitches = cap();
    E.getCfg().prog = { on: false, chords: [] };
    delete E.getCfg().layers[0].notes;
    E.getCfg();
    return out;
  });
  ok('a v2 layer has a Notes source control, built by v1\'s own builder',
    src.hasBtn && src.h === 25, JSON.stringify(src));
  // C-E-G, not the C-D-E this pinned before: over a SCALE, Chord steps in
  // thirds. The two checks below are untouched, and that is the tell that the
  // line is drawn in the right place — a chord source and a progression are
  // POOLS whose consecutive tones already are the harmony, so they never moved.
  ok('with no source it follows the area key, and says so',
    /Scale/.test(src.scaleLabel) && src.scalePitches === '261.6,329.6,392', JSON.stringify(src));
  // The whole point: a layer that does NOT play the area harmony.
  ok('an explicit chord source changes what the layer plays',
    /chord/i.test(src.chordLabel) && src.chordPitches === '440,523.3,659.3', JSON.stringify(src));
  ok('an area progression still overrides every layer, and the control says so',
    src.locked && /Progression/.test(src.lockLabel) && src.lockPitches === '261.6,329.6,392',
    JSON.stringify(src));

  // ---- card structure -----------------------------------------------------
  // Reported as "the v2 layer UI is a total mess". It was: 4 groups, 45 rows,
  // 2873px on a 780px viewport, with an 18-row "Mix & FX" mixing routing,
  // filtering, time FX, gating and movement, and "Tone" used for two different
  // things. The spec had warned about exactly this shape and it arrived anyway,
  // by accretion over sixteen slices — so the SHAPE is gated now, not just the
  // controls. Every number here is a measurement from that audit.
  const shape = await page.evaluate(async () => {
    const wait = () => zz(120);
    // RESET TO THE DEFAULT SHAPE FIRST. This runs after the speech section, and
    // a speech layer HIDES the pitched rows — including `instrument.tone`, so
    // the duplicate-label check saw only one "Tone" and passed while the two
    // were genuinely colliding (a poison that passed, which is the finding).
    // A structural check must state the state it measures.
    const L0 = _masterEng.getCfg().layers[0];
    L0.instrument.voice = 'synth';
    L0.part.kind = 'live';
    window._v2.render(_masterEng);
    await wait();
    const c = document.querySelector('.v2-layer');
    // fully collapse, then expand the way a user does
    if (!c.classList.contains('collapsed')) c.querySelector('.v2-caret').click();
    await wait();
    c.querySelector('.v2-caret').click();
    await wait();
    const grps = [...c.querySelectorAll('.ambient-grp')];
    const vis = (g) => [...g.querySelectorAll('.ambient-ctrl')]
      .filter((r) => r.getBoundingClientRect().height > 0);
    const btns = [...c.querySelectorAll('.v2-gototab')];
    const out = {
      groups: grps.map((g) => g.getAttribute('data-v2grp')),
      // RESTATED with the embed: the expanded card is the EDITOR — six section
      // tabs at a real touch size, and zero rows left behind in the storage
      // groups (the open section's rows are MOVED into the pane).
      gridBtns: btns.filter((b2) => b2.getBoundingClientRect().height >= 44).length,
      rowsShowing: grps.reduce((a2, g) => a2 + vis(g).length, 0),
      height: Math.round(c.getBoundingClientRect().height),
      // THE CARD SCROLLS AS ONE. The pane was a capped, separately-scrolling
      // window inside a page that already scrolls — "this scroll section is
      // still too small; the whole area body should scroll" — so what is pinned
      // now is that it is NOT its own scroll region, and that the card's CHROME
      // (everything except the rows) stays bounded, which is the axis accretion
      // actually threatens.
      paneH: (() => { const pn = c.querySelector('.v2-pop-pane');
        return pn ? Math.round(pn.getBoundingClientRect().height) : -1; })(),
      // no pane at all = nothing inside the card scrolls, which is the claim
      paneScrolls: (() => { const pn = c.querySelector('.v2-pop-pane'); if (!pn) return false;
        const cs = getComputedStyle(pn);
        return cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.maxHeight !== 'none'; })(),
      chromeH: (() => {
        // WITHOUT the viz block: its canvas is content, capped by its own
        // sizing (reading cap 190/240), and the sticky pitch window may
        // legitimately hold it at that cap — counting it here made the
        // watchdog fire on a wide-but-capped drawing, not on frame growth
        const q = (sel) => { const e = c.querySelector(sel);
          return e ? e.getBoundingClientRect().height : 0; };
        return Math.round(q('.ambient-layer-head') + q('.v2-find') + q('.v2-pop-head') +
                          q('.v2-pop-tabs') + q('.v2-pop-foot'));
      })(),
      cvH: (() => { const e = c.querySelector('.v2-vizcv');
        return e ? Math.round(e.getBoundingClientRect().height) : 0; })(),
      vh: window.innerHeight,
      // the card at rest must still SAY what is engaged — the summaries live
      // on the buttons now (the drum-solo rule: state that can vanish while
      // its widget keeps state gets reported as a bug)
      folded: btns.map((b2) => b2.getAttribute('data-goto') + '=' +
        (b2.getAttribute('title') || '')),
      // …and Content's summary, which is the body's own — it has no button
      contentSum: ((c.querySelector('.v2-pop-head .v2-grpsum[data-grp="Content"]') || {})
        .textContent || '').trim(),
      unnamed: grps.filter((g) => !g.getAttribute('data-v2grp')).length,
    };
    // widest group, with EVERY group open — the wall test
    grps.forEach((g) => g.classList.add('open'));
    await wait();
    out.widest = Math.max(...grps.map((g) => vis(g).length));
    out.widestName = grps.map((g) => [g.getAttribute('data-v2grp'), vis(g).length])
      .sort((x, y) => y[1] - x[1])[0].join(':');
    // TABS PER SHEET — the unit the accretion check now uses. Same derivation
    // the sheet itself does (an explicit `data-v2tab`, else the row label's
    // first text node), so this counts what the chooser will actually show.
    const tabsOf = (g) => {
      const names = vis(g).map((r) => {
        const t = r.getAttribute('data-v2tab');
        if (t) return t;
        const lab = r.querySelector(':scope > label') || r.querySelector('.ambient-mod-sub');
        if (!lab) return '…';
        const s2 = ((lab.childNodes[0] && lab.childNodes[0].textContent) || lab.textContent || '').trim();
        return (s2.split('·')[0].trim()) || '…';
      });
      return [...new Set(names)].length;
    };
    out.tabCounts = grps.map((g) => g.getAttribute('data-v2grp') + ':' + tabsOf(g));
    out.widestTabs = Math.max(...grps.map(tabsOf));
    out.widestTabsName = grps.map((g) => [g.getAttribute('data-v2grp'), tabsOf(g)])
      .sort((x, y) => y[1] - x[1])[0].join(':');
    out.allOpenHeight = Math.round(c.getBoundingClientRect().height);
    // duplicate labels across the whole card — "Tone" meant both the voice and
    // the filter cutoff, which is the naming rule's own failure mode
    const labels = grps.flatMap((g) => vis(g))
      .map((r) => {
        const t2 = ((r.querySelector('label') || {}).textContent || '').replace(/[↻].*$/, '').trim();
        const sub = r.closest('.ambient-mod-target');
        const head = sub ? ((sub.querySelector('.ambient-mod-sub') || {}).textContent || '') : '';
        return t2 ? (head ? head + '/' + t2 : t2) : '';
      })
      .filter(Boolean);
    out.dups = [...new Set(labels.filter((x, i) => labels.indexOf(x) !== i))];
    // an FX stage's own params are hidden until the stage is engaged
    // GUARDED: a missing group is precisely the regression being hunted, and an
    // unguarded reference throws and kills the whole run — which tells you less
    // than one red line.
    const fxg = grps.find((g) => g.getAttribute('data-v2grp') === 'FX');
    if (!fxg) { out.fxRest = -1; out.fxEngaged = ''; out.fxBack = -1; out.afterRebuild = 'NO FX GROUP'; return out; }
    out.fxRest = vis(fxg).length;
    const set = (f, v) => { const el = c.querySelector('[data-f="' + f + '"]'); el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('delay.mix', 50); set('dist.mix', 40);
    await wait();
    out.fxEngaged = vis(fxg).map((r) => (r.querySelector('label') || {}).textContent).join('/');
    set('delay.mix', 0); set('dist.mix', 0);
    await wait();
    out.fxBack = vis(fxg).length;
    // group open/closed state must survive a structure rebuild
    grps.forEach((g) => g.classList.toggle('open', g.getAttribute('data-v2grp') === 'FX'));
    _masterEng.getCfg().layers[0].name = 'Restructured';
    window._v2.render(_masterEng);
    await wait();
    out.afterRebuild = [...document.querySelectorAll('.v2-layer .ambient-grp.open')]
      .map((g) => g.getAttribute('data-v2grp')).join(',');
    return out;
  });
  // SEVEN top-level groups, along the model's own spine: a layer is an
  // INSTRUMENT and a PART, and everything after it is treatment. Envelope,
  // Voicing, Motion, Mod and Space were not peers of FX — they are sub-tabs of
  // the group each belongs to now.
  ok('the card is grouped by what a control DOES, every group named',
    shape.groups.join(',') === 'Instrument,Content,Pitch,Shape,Mix,FX' && shape.unnamed === 0,
    JSON.stringify(shape.groups));
  ok('expanding shows the editor — a button per section at a real touch size, no rows left behind',
    shape.gridBtns === 8 && shape.rowsShowing === 0,
    JSON.stringify({ btns: shape.gridBtns, rows: shape.rowsShowing }));
  // RESTATED with the embed: the card WAS a grid of buttons at rest, so half a
  // screen was the right bar for it; it is the editor itself now. The accretion
  // this catches is the same one — the pane is capped and SCROLLS rather than
  // growing without limit, so the card stays about one screen whatever a tab
  // holds.
  // RESTATED (was "about one screen, and the pane is capped"): the pane is no
  // longer a scroll region of its own — the card grows and the PANEL scrolls,
  // which is what was asked for. So the ceiling moves off the card's total
  // height, which is now legitimately as tall as its rows, and onto the two
  // things that still have to hold: nothing scrolls inside the card, and the
  // CHROME around the rows stays about half a screen however much the rows grow.
  ok('an expanded card scrolls as ONE — no window inside it, and its chrome stays bounded',
    // 0.85 of a screen is a WATCHDOG, not a target: the frame measures 625px of
    // 780 today (head 38 · find 34 · sheet head 171 · tabs 140 · drawing ~150 ·
    // foot ~90), most of it things asked for by name — 44px section tabs on two
    // rows, the family bar, the piano roll. It is here so the FRAME cannot
    // double while nobody is looking; the rows below it are free to grow.
    shape.paneScrolls === false && shape.chromeH <= shape.vh * 0.68 &&
    shape.cvH <= 200,
    JSON.stringify({ card: shape.height, pane: shape.paneH, chrome: shape.chromeH,
                     cv: shape.cvH, paneScrolls: shape.paneScrolls, vh: shape.vh }));
  // THE ACCRETION CHECK, restated in the unit that now matters. It counted ROWS
  // because rows used to be what you saw; a group's rows live in a TABBED sheet
  // now and only one tab shows at a time, so the wall this catches is a wall of
  // TABS. Kept deliberately tight — 16 is about three wrapped rows of chips at
  // 390px, past which a chooser stops being scannable.
  ok('no group is a dump — no sheet exceeds 16 tabs',
    shape.widestTabs <= 16, shape.widestTabsName + ' of ' + JSON.stringify(shape.tabCounts));
  // RESTATED 2026-09-13, and it was asserting nothing before: it read
  // `data-v2grp` and a `.v2-grpsum` CHILD off the section buttons, which carry
  // neither — every entry was the string "null=undefined", whose split half is
  // non-empty, so it passed on garbage. A button says what is engaged through
  // its TITLE; Content says it through the body's own summary.
  ok('every section button says what is engaged inside it, and the body says Content',
    shape.folded.length === 8 &&
    shape.folded.every((f) => { const [g, t] = f.split('='); return g && g !== 'null' && t.indexOf(g) === 0; }) &&
    shape.contentSum.length > 0,
    JSON.stringify({ folded: shape.folded, content: shape.contentSum }));
  ok('no two rows on the card carry the same label',
    shape.dups.length === 0, JSON.stringify(shape.dups));
  ok("an effect's own parameters appear only once the effect is engaged",
    shape.fxRest === 9 && /Delay time/.test(shape.fxEngaged) && /Ping-pong/.test(shape.fxEngaged) &&
    /Drive amt/.test(shape.fxEngaged) && /Drive tone/.test(shape.fxEngaged) &&
    shape.fxBack === 9, JSON.stringify(shape));
  ok('which groups are open survives a rebuild',
    shape.afterRebuild === 'FX', shape.afterRebuild);

  // ---- KNOBS --------------------------------------------------------------
  // In a sheet every slider is a large knob — a WRAPPER over the row's real
  // <input type=range> (never replaced, so every binding and every synthetic
  // drive in this file still works). Drag is delta-based from the press; a
  // tap must never jump the value (the mis-tap-wrecks-the-setting rule).
  await page.evaluate(async () => {
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    // Envelope is a TAB of Instrument now — the group to open is Instrument
    const b2 = [...c.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === 'Instrument');
    b2.scrollIntoView({ block: 'center' });
  });
  await tap('.v2-gototab[data-goto="Instrument"]');
  // The envelope is a FOLDED SUBSECTION of the Live tab now, not a tab of its
  // own — so the sliders it holds are hidden until it is opened, and a probe
  // that skips that measures `{w:0}` on a perfectly good card. Open the tab,
  // then open the subsection. (It was a tab; before that it was a group. A
  // probe for a control has to be re-derived every time its home moves.)
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.v2-pop-tab')].find((b) => b.getAttribute('data-tab') === 'Live');
    if (t) t.click();
  });
  await zz(150);
  await page.evaluate(() => {
    const d = document.querySelector('.v2-pop-pane .v2-discbtn[data-disc="env"]');
    if (d && !document.querySelector('.v2-layer').classList.contains('v2-so-env')) d.click();
  });
  await zz(200);
  const knob = await page.evaluate(() => {
    const k = document.querySelector('.v2-pop-pane .ambient-ctrl:not(.v2-rowoff) .v2-knob');
    if (!k) return { err: 'no knob' };
    // SCROLL IT INTO VIEW FIRST — the editor is in the page flow now, so a
    // control can sit below the fold and `elementFromPoint` there answers
    // about the wrong pixels (it returned null, which reads as "no knob").
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    const inp = k.closest('.ambient-ctrl').querySelector('input.ambient-sl');
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             w: Math.round(r.width), v0: +inp.value,
             hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).closest('.v2-knob') === k };
  });
  // RESTATED with the compact dial (2026-09-05, user: "dials too large") —
  // the contract is a real, hit-testable dial, now 80-110px.
  ok('the sheet shows a knob where the slider was', !knob.err && knob.w >= 80 && knob.w <= 110 && knob.hit,
    JSON.stringify(knob));
  await page.touchscreen.touchStart(knob.x, knob.y);
  for (let i = 1; i <= 8; i++) await page.touchscreen.touchMove(knob.x, knob.y - i * 8);
  await page.touchscreen.touchEnd();
  await zz(150);
  let kn = await page.evaluate(() => {
    const L = _masterEng.getCfg().layers[0];
    const k = document.querySelector('.v2-pop-pane .ambient-ctrl:not(.v2-rowoff) .v2-knob');
    return { attack: L.instrument.attack, face: (k.querySelector('.v2-knob-val') || {}).textContent };
  });
  ok('a knob drag writes the config and the face follows',
    kn.attack > knob.v0 && String(kn.attack) === kn.face, JSON.stringify({ from: knob.v0, to: kn }));
  const kv1 = kn.attack;
  await page.touchscreen.tap(knob.x, knob.y);
  await zz(150);
  kn = await page.evaluate(() => {
    const L = _masterEng.getCfg().layers[0];
    const n = document.querySelector('.v2-knob-num');
    return { attack: L.instrument.attack, entry: !!n,
             font: n ? getComputedStyle(n).fontSize : null };
  });
  ok('a knob TAP never jumps the value — it opens 16px numeric entry',
    kn.attack === kv1 && kn.entry && kn.font === '16px', JSON.stringify(kn));
  await page.keyboard.type('500');
  await page.keyboard.press('Enter');
  await zz(150);
  kn = await page.evaluate(() => ({
    attack: _masterEng.getCfg().layers[0].instrument.attack,
    gone: !document.querySelector('.v2-knob-num'),
  }));
  ok('typed entry commits and closes', kn.attack === 500 && kn.gone, JSON.stringify(kn));

  // ---- THE HEADER IS A SECTION NAVIGATOR ----------------------------------
  // The title named the open group and nothing more, so moving between sections
  // meant closing the sheet and finding the next button — a round trip through
  // a grid you had just left. It is a dropdown of the seven groups now.
  await tap('.v2-gototab[data-goto="Instrument"]');
  const nav = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const tabOf = (g) => document.querySelector('.v2-gototab[data-goto="' + g + '"]');
    const o = {
      opts: [...document.querySelectorAll('.v2-gototab')].map((x) => x.getAttribute('data-goto')),
      start: ((document.querySelector('.v2-gototab.on') || {}).textContent || '').trim(),
      hops: [],
    };
    // ALL SIX VISIBLE AT ONCE is the point of the change — a select showed only
    // the section you were already in. Equal widths filling the row, on ONE
    // line, nothing clipped, and the ✕ still beside them.
    const tbs = [...document.querySelectorAll('.v2-gototab')];
    const rects = tbs.map((t) => t.getBoundingClientRect());
    // AT MOST TWO ROWS, and every tab in a row the same width as its
    // neighbours. Six on ONE row wrapped every label onto two lines on a phone
    // and read as cut off, so the phone splits 4 + 2 and shares row two with
    // Register and the ✕ — hence "equal WITHIN a row" rather than overall.
    const byRow = {};
    rects.forEach((r, i) => { const k = Math.round(r.top); (byRow[k] = byRow[k] || []).push(Math.round(r.width)); });
    const rowKeys = Object.keys(byRow).map(Number).sort((a, b) => a - b);
    o.tabRows = rowKeys.length;
    // EQUAL ON THE FIRST ROW, which is the one that fills. Row two is Mix and
    // FX sized to their TEXT on purpose, leaving that row's width for the
    // Register stepper and the ✕ — so "equal everywhere" is the wrong claim
    // and failed on a correct layout.
    o.equal = new Set(byRow[rowKeys[0]]).size === 1;
    // …and when it wraps, row one spans the head rather than leaving a gap
    const hd0 = document.querySelector('.v2-secpop-head');
    const cs0 = getComputedStyle(hd0);
    const inner = hd0.clientWidth - parseFloat(cs0.paddingLeft) - parseFloat(cs0.paddingRight);
    const r1 = rects.filter((r) => Math.round(r.top) === rowKeys[0]);
    o.row1Fill = +((Math.max(...r1.map((r) => r.right)) - Math.min(...r1.map((r) => r.left))) / inner).toFixed(2);
    o.fills = o.tabRows === 1 || o.row1Fill >= 0.9;
    o.clipped = tbs.filter((t) => t.scrollWidth > t.clientWidth + 1).length;
    o.tall = Math.min(...rects.map((r) => Math.round(r.height)));
    o.allSix = tbs.length === 8 && rects.every((r) => r.width > 0 && r.height > 0);
    // THE TABS OWN THE ROW: nothing else shares their last line — the trio and
    // Register sit below them (it was [Mix FX · Reg ± · ✕] on one row, which
    // is what squeezed "Instrument" into three stacked syllables).
    const lastTop = rowKeys[rowKeys.length - 1];
    const others = [...document.querySelectorAll('.v2-pop-head > *:not(.v2-pop-title)')];
    o.closeBeside = others.every((n) =>
      n.getBoundingClientRect().height === 0 ||
      n.getBoundingClientRect().top >= lastTop + 20);
    // ASSERT WHAT ONLY A REAL NAVIGATION PRODUCES. Reading the select's own
    // value back after setting it proves nothing — it is the same element,
    // still holding what was just assigned, and the FIRST version of this
    // check passed with `popOpen` disabled entirely. `aria-label` and the wrap
    // NODE are both minted by popOpen, and the destination row only exists in
    // the destination's body.
    // a marker only that section's rows carry — a field path, or a class where
    // the row has no field of its own (the bank is a list, not a setting)
    // ✦ Generate's marker is its DOOR, not a knob (2026-09-15): every
    // `part.rhythm.*` field left this section for the ⚙ Generated panel, which
    // is a card child rather than a row in the pane, so `part.rhythm.steps`
    // stopped being reachable from here at all. `.v2-genbtn` is what the
    // section actually holds — the same shape as Bank's `.v2-bankrow` marker,
    // used for the same reason (a list, or a door, has no field of its own).
    const WANT = { Generate: '.v2-genbtn', Time: 'part.bars', Bank: '.v2-bankrow',
                   Pitch: 'part.pitch.kind',
                   Shape: 'part.shape.holdSteps', Mix: 'level', FX: 'delay.mix',
                   Instrument: 'instrument.voice' };
    // RESTATED 2026-09-13 with the reason (the old-CONTRACT fork): the section
    // row no longer REBUILDS the body, so "a NEW sheet, not the old one" and
    // "built by popOpen for THIS group" are claims this change deliberately
    // contradicts — Content IS the body, and the other five open OVER it. What
    // is still worth pinning, and is strictly stronger, is that every section
    // is reachable, arrives holding its OWN rows and its OWN tab strip, that
    // the row says where you are, and that THE BODY NEVER MOVES while you do it.
    const bodyW = document.querySelector('.v2-pop-wrap');
    // THE BODY'S SHAPE — its height and the drawing inside it. NOT its
    // viewport position (scroll moves that) and NOT its offset in the card (a
    // storage group left `.open` by an earlier probe's test hook sits above it
    // and shifts it — the probe's doing, not the design's).
    const bodyGeo = () => { const r = bodyW.getBoundingClientRect();
      const v = bodyW.querySelector('.v2-partviz');
      const vr = v ? v.getBoundingClientRect() : null;
      return Math.round(r.height) + '/' + (vr ? Math.round(vr.height) + 'x' + Math.round(vr.width) : 'no-viz'); };
    o.bodyBefore = bodyGeo();
    o.bodyMoved = 0;
    // …and the body's sheet is the SAME NODE throughout. This is the exact
    // inverse of what this check used to assert ("a NEW sheet, not the old
    // one"), and it is the claim with teeth: a section press must not replace
    // the body, only put something over it.
    o.bodyRebuilt = 0;
    for (const g of ['Generate', 'Time', 'Bank', 'Pitch', 'Shape', 'Mix', 'FX', 'Instrument']) {
      // CLOSE FIRST, as a finger must: the popover is modal, so the body's
      // section row is behind its scrim until it is dismissed.
      // Content has no button — it IS the body, so getting to it is dismissing
      // whatever treatment is open over it. The other five have to be dismissed
      // first too: the popover is modal, so the row is behind its scrim.
      { const c0 = document.querySelector('.v2-layer .v2-secpop-close'); if (c0) c0.click(); }
      await wait(140);
      { const bt = tabOf(g); if (bt) bt.click(); }
      await wait(240);
      const ov = document.querySelector('.v2-secpop-wrap');
      // every section opens a popover NAMED for it, holding its own rows and
      // its own tab strip, with the body's row marking where you are
      const named = !!ov && ((ov.querySelector('.v2-secpop') || {}).getAttribute
        && ov.querySelector('.v2-secpop').getAttribute('aria-label') === g);
      o.hops.push({ g, ok: !!named &&
        !!ov.querySelector('.v2-pop-pane ' + (WANT[g][0] === '.' ? WANT[g]
              : '[data-f="' + WANT[g] + '"]')) &&
        ov.querySelectorAll('.v2-pop-tabs .v2-pop-tab').length > 0 &&
        (((document.querySelector('.v2-gototab.on') || {}).getAttribute
          && document.querySelector('.v2-gototab.on').getAttribute('data-goto')) || '') === g });
      if (bodyGeo() !== o.bodyBefore) o.bodyMoved++;
      if (document.querySelector('.v2-pop-wrap') !== bodyW) o.bodyRebuilt++;
    }
    o.oneSheet = document.querySelectorAll('.v2-pop-wrap').length;
    await wait(220);
    const card = document.querySelector('.v2-layer');
    o.groups = card.querySelectorAll('.ambient-grp[data-v2grp]').length;
    const hd = document.querySelector('.v2-pop-head');
    o.headOverflow = hd ? hd.scrollWidth - hd.clientWidth : 0;
    return o;
  });
  ok('the section row reaches every section, and the body never moves',
    nav.opts.join(',') === 'Generate,Time,Bank,Instrument,Pitch,Shape,Mix,FX' &&
    nav.start === 'Instrument' && nav.hops.every((x) => x.ok) && nav.oneSheet === 1 &&
    nav.bodyMoved === 0 && nav.bodyRebuilt === 0,
    JSON.stringify(nav.hops.filter((x) => !x.ok)) + ' opts=' + nav.opts.length +
    ' bodyMoved=' + nav.bodyMoved + ' bodyRebuilt=' + nav.bodyRebuilt);
  ok('…and all eight sections are visible at once — the rows they fill outright',
    nav.allSix && nav.tabRows >= 1 && nav.tabRows <= 3 && nav.equal && nav.fills &&
    nav.clipped === 0 && nav.tall >= 30 && nav.closeBeside && nav.headOverflow === 0,
    JSON.stringify({ allSix: nav.allSix, tabRows: nav.tabRows, equal: nav.equal,
      fills: nav.fills, row1Fill: nav.row1Fill, clipped: nav.clipped, tall: nav.tall,
      closeBeside: nav.closeBeside, over: nav.headOverflow }));
  // NOT a second body-return check — "closing the sheet returns its rows to the
  // group" already covers that and has teeth (poison-verified). This asserts
  // only that the hops leave the card's groups intact (six since the Rhythm
  // group folded into Content, 2026-09-05).
  ok('hopping between sections leaves the card\'s groups intact',
    nav.groups === 6, JSON.stringify({ groups: nav.groups }));

  // ---- SHEET SURVIVES A REBUILD -------------------------------------------
  // A voice/steps/pitch-kind change re-renders the whole host, which destroys
  // the sheet with the card holding it — it must come back on the fresh card,
  // same group, or a select flipped from inside the sheet slams it shut.
  await tap('.v2-gototab[data-goto="Instrument"]');
  await page.evaluate(() => {
    const sel = document.querySelector('.v2-pop-pane [data-f="instrument.voice"]');
    sel.value = 'speech'; sel.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await zz(300);
  const toneField = () => page.evaluate(() => {
    const r2 = [...document.querySelectorAll('.v2-layer [data-v2tab="Live"]')]
      .find((x) => /^Tone$/.test(((x.querySelector('label') || {}).textContent || '').trim()));
    const s2 = r2 && r2.querySelector('select');
    return s2 ? s2.getAttribute('data-f') : null;
  });
  let re = await page.evaluate(() => ({
    open: !!document.querySelector('.v2-pop-wrap'),
    title: ((document.querySelector('.v2-gototab.on') || {}).textContent || '').trim(),
    tabs: [...document.querySelectorAll('.v2-pop-tab')].map((t) => t.getAttribute('data-tab')).join(','),
  }));
  // RESTATED. It pinned "a speech layer has no Tone tab", which was true while
  // Tone meant the SYNTH tone and each type had a row of its own. Tone is now
  // ONE row whose options the type narrows, so the contract worth pinning is
  // that it FOLLOWS the type — which is the stronger statement anyway.
  ok('the sheet survives the rebuild its own select caused',
    re.open && re.title === 'Instrument' && /Words/.test(re.tabs), JSON.stringify(re));
  ok('the Tone row follows the Tone type — speech picks a speaker',
    (await toneField()) === 'instrument.speechVoice', String(await toneField()));
  await page.evaluate(() => {
    const sel = document.querySelector('.v2-pop-pane [data-f="instrument.voice"]');
    sel.value = 'synth'; sel.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await zz(300);
  re = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.v2-pop-tab')].map((t) => t.getAttribute('data-tab')).join(','),
  }));
  ok('…and the gate re-tabs it the other way', /Tone/.test(re.tabs) && !/Words/.test(re.tabs),
    JSON.stringify(re));
  ok('…and the Tone row is the synth tone again',
    (await toneField()) === 'instrument.tone', String(await toneField()));

  // ---- THE FULL FX PARAMETER SET ------------------------------------------
  // Reported as "fx are missing params": the v2 FX group had mixes and little
  // else. Every v1 per-layer FX param has a v2 control now — this block pins
  // the ones with traps in them.
  const fxp = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const out = {};
    const L = () => _masterEng.getCfg().layers[0];
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    [...card.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === 'FX').click();
    await wait(200);
    const set = (f, v) => { const el = document.querySelector('.v2-pop-pane [data-f="' + f + '"]');
      if (!el) { out.missing = (out.missing || []).concat(f); return; }
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('delay.mix', 40); await wait(120);
    set('delay.sync', '1/8'); set('delay.spread', 30);
    const ping = [...document.querySelectorAll('.v2-pop-pane .v2-ftog')].find((x) => x.getAttribute('data-f') === 'delay.ping');
    if (ping) ping.click(); await wait(120);
    out.delay = { sync: L().delay.sync, spread: L().delay.spread, ping: L().delay.ping };
    set('dist.mix', 30); await wait(120);
    set('dist.flavor', 'fuzz'); set('dist.tone', 70); set('dist.focus', 20); await wait(100);
    out.dist = { flavor: L().dist.flavor, tone: L().dist.tone, focus: L().dist.focus };
    set('chorus.mix', 25); await wait(120);
    set('chorus.depth', 80); set('chorus.rate', 60); await wait(100);
    out.chorus = { depth: L().chorus.depth, rate: L().chorus.rate };
    // PITCH ECHO — the strict-boolean trap: v1's normalize does
    // `pe.on = pe.on === true`, so a numeric 1 flattens to false on the very
    // next getCfg and the toggle reads as dead. The v2 toggle writes a boolean.
    [...document.querySelectorAll('.v2-pop-tab')].find((t) => t.getAttribute('data-tab') === 'Pitch echo').click();
    await wait(120);
    const pt = [...document.querySelectorAll('.v2-pop-pane .v2-ftog')].find((x) => x.getAttribute('data-f') === 'pecho.on');
    if (pt) pt.click(); await wait(150);
    const pat = document.querySelector('.v2-pop-pane [data-f="pecho.pattern"]');
    if (pat) { pat.value = '0,4,7'; pat.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(100);
    out.pecho = { on: L().pecho && L().pecho.on, pattern: L().pecho && L().pecho.pattern };
    // …and it actually SPAWNS for a v2 layer (the tee resolves `v2:` keys)
    let echo = 0;
    const orig = window.playNote;
    window.playNote = function (f, pr) { if (pr && pr._pecho) echo++; return orig.apply(this, arguments); };
    window._ambSilentCapture = true;
    try { window._v2Tick(_masterEng, Tone.now(), Tone.now() + 2.0, 0.15, 0, _masterEng.getCfg()); } catch (e) { out.tickErr = e.message; }
    window.playNote = orig; window._ambSilentCapture = false;
    out.echoes = echo;
    // undo the noisy state
    if (pt) pt.click(); await wait(100);
    set('delay.mix', 0); set('dist.mix', 0); set('chorus.mix', 0);
    const png2 = [...document.querySelectorAll('.v2-pop-pane .v2-ftog')].find((x) => x.getAttribute('data-f') === 'delay.ping');
    if (png2 && png2.classList.contains('on')) png2.click();
    await wait(100);
    // EQ lives in Mix as its own tab
    [...card.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === 'Mix').click();
    await wait(150);
    const eqTab = [...document.querySelectorAll('.v2-pop-tab')].find((t) => t.getAttribute('data-tab') === 'EQ');
    if (eqTab) { eqTab.click(); await wait(100); set('eq.low', -6); await wait(100); }
    out.eq = L().eq && L().eq.low;
    set('eq.low', 0);
    return out;
  });
  ok('delay carries sync, width and ping-pong',
    fxp.delay && fxp.delay.sync === '1/8' && fxp.delay.spread === 30 && fxp.delay.ping === 1 && !fxp.missing,
    JSON.stringify(fxp));
  ok('drive carries type, tone and focus',
    fxp.dist && fxp.dist.flavor === 'fuzz' && fxp.dist.tone === 70 && fxp.dist.focus === 20,
    JSON.stringify(fxp.dist));
  ok('chorus carries depth and rate', fxp.chorus && fxp.chorus.depth === 80 && fxp.chorus.rate === 60,
    JSON.stringify(fxp.chorus));
  ok('pitch echo switches ON and STAYS on (v1 normalize accepts only boolean true)',
    fxp.pecho && fxp.pecho.on === true && fxp.pecho.pattern === '0,4,7', JSON.stringify(fxp.pecho));
  ok('…and spawns echoes for a v2 layer', fxp.echoes > 0, 'echoes: ' + fxp.echoes + (fxp.tickErr ? ' ERR ' + fxp.tickErr : ''));
  ok('the 3-band EQ is reachable from Mix', fxp.eq === -6, JSON.stringify(fxp.eq));

  // ---- PREVIEW ------------------------------------------------------------
  // Every sheet carries a large ▶ Preview that plays one cycle of the layer
  // through the REAL emitter and the layer's own chain — no capture sink, so
  // nothing is baked and the stopped-clock gates never see it.
  const pv = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const out = {};
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    // the button is in EVERY sheet, at a real size
    out.sized = [];
    for (const g of ['Instrument', 'Content', 'FX']) {
      if (g === 'Content') window.__toContent();
      else [...card.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === g).click();
      await wait(150);
      const b2 = document.querySelector(g === 'Content' ? '.v2-pop-preview' : '.v2-secprev');
      const r = b2 && b2.getBoundingClientRect();
      out.sized.push(g + ':' + (r ? Math.round(r.height) : 0));
      await wait(100);
    }
    // a press reaches playNote, routes to the CHAIN, captures nothing, and
    // leaves no phase state behind to skew the next real play
    [...card.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === 'Instrument').click();
    await wait(150);
    let calls = 0, chained = 0, keyed = 0;
    const orig = window.playNote;
    window.playNote = function (f, pr, d, at, dest) {
      const r0 = orig.apply(this, arguments);
      // read the key AFTER the call-through — the sink stamps it INSIDE
      // playNote (the documented wrapper-attribution trap)
      calls++; if (dest) chained++;
      if (window._ambEmitKey === 'v2:' + _masterEng.getCfg().layers[0].id) keyed++;
      return r0;
    };
    const L = _masterEng.getCfg().layers[0];
    // earlier checks ran the real tick, which captures — the claim is that the
    // PREVIEW adds nothing, so measure the delta, not the presence
    const capBefore = (_masterEng.cap && _masterEng.cap['v2:' + L.id] || []).length;
    // A NOTE COUNT IS NOT A SOUND — the first Preview shipped with 9 playNote
    // calls and a silent master (unkeyed core posts land in no strip slot), and
    // this check passed. Measure the AUDIO, with a positive control first: a
    // probe that measures audio must prove it can hear before a zero means
    // anything.
    const tap2 = _ambMasterTapNode(); const an2 = new Tone.Analyser('waveform', 2048);
    Tone.connect(tap2, an2);
    const meas = async (ms) => { let pk = 0; const t2 = Date.now() + ms;
      while (Date.now() < t2) { const w = an2.getValue();
        for (let i = 0; i < w.length; i++) pk = Math.max(pk, Math.abs(w[i]));
        await wait(35); } return pk; };
    const osc2 = new Tone.Oscillator(523, 'sine'); Tone.connect(osc2, tap2);
    osc2.volume.value = -14; osc2.start();
    out.posCtl = +(await meas(500)).toFixed(3);
    osc2.stop(); osc2.dispose();
    await wait(250);   // let the control decay so it cannot masquerade as the preview
    out.floor = +(await meas(300)).toFixed(3);
    // `_ambEmitKey` is STICKY — nothing clears it between scopes, so a stale
    // value from an earlier tick satisfies the equality and the keyed count
    // asserts nothing (this poison passed once). Null it; only a stamp made
    // DURING the preview can then count.
    window._ambEmitKey = null;
    document.querySelector('.v2-pop-preview').click();
    await wait(150);
    // read the pulse NOW — the class clears when the cycle ends, and the
    // 2.2 s audio measurement below outlives a short cycle
    out.pulsing = document.querySelector('.v2-pop-preview').classList.contains('playing');
    out.peak = +(await meas(2200)).toFixed(3);
    window.playNote = orig;
    out.calls = calls; out.chained = chained; out.keyed = keyed;
    out.phaseClean = !(_masterEng._v2Phase && _masterEng._v2Phase['v2:' + L.id]);
    out.captured = ((_masterEng.cap && _masterEng.cap['v2:' + L.id] || []).length) > capBefore;
    // PRESS AGAIN = STOP. The first build's 'playing' guard expired with the
    // cycle while tails rang, so a re-press stacked a second copy — reported
    // as "firing a few times on top of each other". Stop must return the
    // label AND kill the audio (tails included), click-free.
    document.querySelector('.v2-pop-preview').click();
    // unscaled: this is the ring-down before measuring the stop — audio
    // runs on wall time (stopPeak read 0.12 when this scaled down)
    await new Promise((r) => setTimeout(r, 350));
    out.stopLabel = document.querySelector('.v2-pop-preview').textContent;
    out.stopPeak = +(await meas(800)).toFixed(3);
    return out;
  });
  ok('every sheet carries a large Preview button',
    pv.sized.every((x) => parseInt(x.split(':')[1], 10) >= 44), JSON.stringify(pv.sized));
  ok('Preview plays one cycle through the layer chain, bakes nothing, leaves no state',
    pv.calls > 0 && pv.chained === pv.calls && pv.phaseClean && !pv.captured && pv.pulsing,
    JSON.stringify(pv));
  ok('Preview is AUDIBLE at the master tap (positive control heard, floor quiet, preview loud)',
    pv.posCtl > 0.05 && pv.peak > Math.max(0.02, pv.floor * 3),
    JSON.stringify({ posCtl: pv.posCtl, floor: pv.floor, peak: pv.peak }));
  // The marker sink stamps the emit key — an UNKEYED core post lands in no
  // strip slot and renders SILENCE (the shipped first build: 9 calls, master
  // tap 0.000). The audio check above only catches that when the core worklet
  // is live in this environment, so the keying is pinned structurally too.
  ok("every preview note carries the layer's emit key",
    pv.keyed === pv.calls && pv.calls > 0, JSON.stringify({ keyed: pv.keyed, calls: pv.calls }));
  ok('pressing again STOPS the preview — label back, audio killed',
    /Preview/.test(pv.stopLabel) && pv.stopPeak < Math.max(0.05, pv.floor * 3),
    JSON.stringify({ label: pv.stopLabel, stopPeak: pv.stopPeak, floor: pv.floor }));

  // ---- ARRANGEMENT INTEGRATION --------------------------------------------
  // "Arrangement must be fully integrated with layer v2": the four gaps found
  // by reading the sweeps — the hang shift skipped `E._v2Phase`, the section
  // mask was editable and unread, the ▦ Passes phrase mapping never swept
  // cfg.layers, and a hang burst could not voice a v2 layer.
  const arr = await page.evaluate(async () => {
    const res = {};
    const E = _masterEng;
    const cfg = E.getCfg(); const L = cfg.layers[0]; const key = 'v2:' + L.id;
    const saveSm = L.sectionMask, saveSec = cfg.sections, savePs = L.partSeqs;
    const saveAnch = [E._progAnchor, E._playStartAt, E._barGridAnchor];
    // 1. the hang PAUSE lands the v2 phase on the part's downbeat
    E._barGridAnchor = 100;
    E._v2Phase = {}; E._v2Phase[key] = { startAt: 100, lastAt: 105 };
    _ambHangShiftLayers(E, cfg, { t0: 104, t1: 105 });
    res.hang = { startAt: E._v2Phase[key].startAt, lastAt: E._v2Phase[key].lastAt, anchor: E._barGridAnchor };
    E._v2Phase = {};
    // 2. the section mask gates a v2 note
    const t0 = Tone.now() + 0.1;
    cfg.sections = [{ name: 'A', bars: 8 }];
    L.sectionMask = { steps: [0] };
    E.getCfg();
    E._progAnchor = t0; E._playStartAt = t0; E._barGridAnchor = null;
    const count = () => { let n = 0; const orig = window.playNote;
      window.playNote = function () { n++; };
      window._ambSilentCapture = true;
      E._v2Phase = {}; E._v2Phase[key] = { startAt: t0, lastAt: null };
      try { window._v2Tick(E, t0 - 0.05, t0 + 3.9, 0.1, 0, E.getCfg()); } catch (e) { res.tickErr = e.message; }
      window.playNote = orig; window._ambSilentCapture = false;
      delete E._v2Phase[key];
      return n; };
    res.masked = count();
    delete L.sectionMask; E.getCfg();
    res.unmasked = count();
    // 3. a mapped phrase installs a freeze, outranks the pipeline, and the
    //    preview PARKS it rather than replaying it
    // the mapping resolves per part/pass/chord, so it needs a PROGRESSION on
    const saveProgOn = cfg.prog && cfg.prog.on, saveChords = cfg.prog && cfg.prog.chords;
    cfg.prog = cfg.prog || {};
    cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }];
    savedSequences.push({ name: '__arrTest', kind: 'phrase', bpm: 120, subdivision: 0.25,
      steps: [{ freq: 220, duration: 1, subdivision: 0.25 }, { freq: 440, duration: 1, subdivision: 0.25 }] });
    L.partSeqs = { 0: { all: '__arrTest' } };
    E.getCfg();
    try { _ambPartSeqSync(E, E.getCfg(), t0); } catch (e) { res.syncErr = e.message; }
    const fs = E.freeze && E.freeze[key];
    res.mapped = { frozen: !!(fs && fs.frozen), name: fs && fs._partSeqName };
    let freqs = [];
    { const orig = window.playNote;
      window.playNote = function (f) { freqs.push(Math.round(f)); };
      window._ambSilentCapture = true;
      try { window._v2Tick(E, t0, t0 + 3.9, 0.1, 0, E.getCfg()); } catch (e) { res.tick2Err = e.message; }
      window.playNote = orig; window._ambSilentCapture = false; }
    res.replay = [...new Set(freqs)].sort((x, y) => x - y);
    res.genSilenced = !(E._v2Phase && E._v2Phase[key]);
    const upto = fs ? fs.scheduledUpto : null;
    window._v2.preview(E, L);
    res.parked = !!(E.freeze && E.freeze[key]) && (fs ? fs.scheduledUpto === upto : false);
    // 4. a hang burst answers in the layer's own voice
    L.instrument.tone = 'fm'; E.getCfg();
    delete E.freeze[key];
    let types = [];
    { const orig = window.playNote;
      window.playNote = function (f, pr) { types.push(pr && pr.type); };
      window._ambSilentCapture = true;
      try { _ambHangEmit(E, cfg, { t0: t0 + 10, t1: t0 + 11, bars: 0.5, pi: 0, kind: 'head' }, key, L); }
      catch (e) { res.burstErr = e.message; }
      window.playNote = orig; window._ambSilentCapture = false; }
    res.burst = [...new Set(types)];
    // restore everything this block touched
    const bi = savedSequences.findIndex((x) => x && x.name === '__arrTest');
    if (bi >= 0) savedSequences.splice(bi, 1);
    if (savePs) L.partSeqs = savePs; else delete L.partSeqs;
    if (saveSm) L.sectionMask = saveSm;
    if (saveSec) cfg.sections = saveSec; else delete cfg.sections;
    cfg.prog.on = !!saveProgOn;
    if (saveChords) cfg.prog.chords = saveChords;
    if (E.freeze) delete E.freeze[key];
    E._progAnchor = saveAnch[0]; E._playStartAt = saveAnch[1]; E._barGridAnchor = saveAnch[2];
    E._v2Phase = {};
    E.getCfg();
    return res;
  });
  ok('a hang PAUSES a v2 layer — its phase lands on the part downbeat',
    arr.hang && arr.hang.startAt === 105 && arr.hang.lastAt === null && arr.hang.anchor === 101,
    JSON.stringify(arr.hang));
  ok('the section mask gates a v2 layer', arr.masked === 0 && arr.unmasked > 0,
    JSON.stringify({ masked: arr.masked, unmasked: arr.unmasked }));
  ok('a ▦ Passes phrase mapping installs on a v2 layer and outranks the pipeline',
    arr.mapped && arr.mapped.frozen && arr.mapped.name === '__arrTest' &&
    arr.replay.length && arr.replay.every((f) => f === 220 || f === 440) && arr.genSilenced,
    JSON.stringify({ mapped: arr.mapped, replay: arr.replay, gen: arr.genSilenced }));
  ok('…and Preview parks the mapped freeze rather than replaying it', arr.parked === true,
    JSON.stringify(arr.parked));
  ok('a hang burst answers in the v2 layer\'s own voice',
    arr.burst && arr.burst.length > 0 && arr.burst.indexOf('fm') >= 0, JSON.stringify(arr.burst));

  // ---- pinch zoom on a phone ----------------------------------------------
  // Reported as "can't pinch zoom out on phone, it zooms in when I don't want
  // it to" — two halves of one bug, and three causes:
  //   1. Capacitor's `ios.zoomEnabled` defaults to FALSE and literally does
  //      `pinchGestureRecognizer.isEnabled = false` (fixed in capacitor.config).
  //   2. `touch-action: none` blocks EVERY browser gesture including pinch, and
  //      the grid was the biggest touch surface on the page.
  //   3. iOS zooms IN when a focused TEXT-ENTRY field is under 16px — and with
  //      1 and 2 there was then no way to zoom back out.
  // This gate can see 2 and 3.
  const zoom = await page.evaluate(() => {
    const out = { viewport: (document.querySelector('meta[name=viewport]') || {}).content || '' };
    // No text-entry field may sit under 16px on a coarse pointer.
    const small = [];
    document.querySelectorAll('input,textarea').forEach((e) => {
      const tag = e.tagName.toLowerCase();
      const typing = tag === 'textarea' ||
        ['text', 'number', 'search', 'tel', 'url', 'email', 'password', ''].indexOf(e.type || '') >= 0;
      if (!typing) return;
      if (parseFloat(getComputedStyle(e).fontSize) < 16) {
        small.push(tag + (e.id ? '#' + e.id : '') + '.' + String(e.className || '').split(' ')[0]);
      }
    });
    out.small = [...new Set(small)];
    // Nothing with real area may block pinch outright.
    const blocked = {};
    document.querySelectorAll('*').forEach((e) => {
      if (getComputedStyle(e).touchAction !== 'none') return;
      const r = e.getBoundingClientRect();
      const k = e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ')[0];
      blocked[k] = (blocked[k] || 0) + Math.round(r.width * r.height);
    });
    out.blockers = Object.entries(blocked).filter(([, a2]) => a2 > 2000).map(([k, a2]) => k + '=' + a2);
    return out;
  });
  // `user-scalable=no` / `maximum-scale` would disable pinch outright.
  ok('the viewport does not forbid zooming',
    !/user-scalable\s*=\s*no/.test(zoom.viewport) && !/maximum-scale/.test(zoom.viewport), zoom.viewport);
  ok('no text-entry field is under 16px (iOS zooms IN on focus below that)',
    zoom.small.length === 0, zoom.small.join(', '));
  // `pinch-zoom` still denies single-finger pan — the part these surfaces need.
  ok('no sizeable surface blocks pinch with touch-action:none',
    zoom.blockers.length === 0, zoom.blockers.join(', '));

  // ---- PRESETS, SPEED, MOTIF, ANTICIPATE (2026-09-16) ----------------------
  // A shape is an intention; a preset is a named set of that shape's values.
  // Pinned through the DOORS a user presses (the shape, then the preset chip),
  // with the engine claims measured off the notes rather than the settings:
  //   · a preset lights, names itself, and says "· tuned" once a value moves;
  //     ↺ Reset is disabled until then and puts the value back
  //   · Speed is a note value PER BAR and survives a different bar count
  //   · Motif 'bar' repeats bar 1's figure on bars 2 and 4, refitted to the
  //     chord (same onsets, different pitches), and bar 3 is its own
  //   · an anticipated change sounds ONCE, an 8th early, and the choke measures
  //     it from the change it belongs to
  const presetRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms <= 350 ? Math.round(ms * (window.__WS || 1)) : ms));
    const E = _masterEng, L = () => window.__Lv2(E);
    const h = document.getElementById('bloom-v2-layers');
    const c0 = E.getCfg();
    const sv = { prog: JSON.stringify(c0.prog || null), part: JSON.stringify(L().part), ring: L().ring, prox: L().proximity,
                 bpm: c0.bpm, bpc: c0.barsPerChord,
                 cfg: E._cfg, pa: E._progAnchor, ps: E._playStartAt, bg: E._barGridAnchor };
    // one bar per chord at 120, so the part is 4 bars and a change is a bar
    c0.bpm = 120; c0.barsPerChord = 1;
    const svCf = window.confirm; window.confirm = () => true;
    c0.prog = { on: true, chords: [0, 5, 7, 9].map((r) => ({ root: r, intervals: [0, 4, 7] })) };
    L().part.kind = 'live'; L().part.bars = 4; delete L().part.mat; delete L().part.mem; delete L().part.preset;
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(260);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(320);
    const pop = () => card().querySelector('.v2-shapepop');
    const o = {};
    pop().querySelector('[data-mk="ground"]').click(); await wait(420);
    // A LABELLED PICKER since 2026-09-16 (chips under the shapes read as more
    // shapes) — driven as a user does: pick, then read what it says
    const pick = () => pop().querySelector('.v2-presetpick');
    const shown = () => { const s2 = pick(); return s2 && s2.selectedIndex >= 0 ? s2.options[s2.selectedIndex].text : ''; };
    const choose = async (id) => { const s2 = pick(); if (!s2) return;
      s2.value = id; s2.dispatchEvent(new Event('input', { bubbles: true })); await wait(420); };
    const reset = () => pop().querySelector('.v2-presetreset');
    o.chips = pick() ? [...pick().options].map((x) => x.text).join('|') : 'no picker';
    o.pickerVisible = !!pick() && pick().getBoundingClientRect().height > 0 &&
      pick().closest('.ambient-ctrl').querySelector('label').textContent.trim() === 'Character';
    o.resetOffFirst = !!reset() && reset().disabled && /Choose a character/.test(shown());
    await choose('comp');
    o.lit = !!pick() && pick().value === 'comp' && shown() === 'Comp';
    o.applied = L().part.preset === 'comp' && L().part.rhythm.strike === 'comp' && L().part.rhythm.antic === 1 &&
      (L().part.shape.lenRatio | 0) === 40;
    const lr = [...pop().querySelectorAll('[data-f="part.shape.lenRatio"]')]
      .find((e) => e.closest('.ambient-ctrl').getBoundingClientRect().height > 0);
    if (lr) { lr.value = '70'; lr.dispatchEvent(new Event('input', { bubbles: true })); } await wait(320);
    o.tuned = /Comp · tuned/.test(shown()) && !!reset() && !reset().disabled;
    if (reset()) reset().click(); await wait(420);
    o.reset = (L().part.shape.lenRatio | 0) === 40 && shown() === 'Comp' && reset().disabled;
    // ANTICIPATE, off the notes and through the choke
    const barSec = 2;
    o.partBars = +L().part.bars;
    const ns = window._v2.withEdit(() => window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
      cycleStart: 0, cycleSec: 4 * barSec })) || [];
    const onsBars = [...new Set(ns.map((n) => Math.round(n.at / barSec * 1000) / 1000))].sort((a, b) => a - b);
    o.anticOnsets = onsBars.join(',');
    o.anticOnce = onsBars.indexOf(0.875) >= 0 && onsBars.indexOf(1) < 0 && onsBars.indexOf(2) < 0 &&
      ns.every((n) => n.durMs > 60);
    E._cfg = E.getCfg(); E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const k = 'v2:' + L().id;
    o.chokeLead = [window._ambNoteChoke(k, 0.875 * barSec, 2000, { _chokeLead: barSec / 8 }),
                   window._ambNoteChoke(k, 0.875 * barSec, 2000, {})];
    o.chokeHonoursLead = o.chokeLead[0] === 2000 && o.chokeLead[1] < 2000;
    // SPEED on a line: a note value per bar, through the picker
    pop().querySelector('.v2-rollrun').click(); await wait(520);
    await choose('melody');
    const spd = pop().querySelector('.v2-speed');
    o.speedShown = !!spd && spd.getBoundingClientRect().height > 0 && spd.value === '8';
    if (spd) { spd.value = '16'; spd.dispatchEvent(new Event('input', { bubbles: true })); } await wait(520);
    o.speedWrote = (L().part.rhythm.steps | 0) === 64 && Math.abs(window._v2.speedOf(L()) - 16) < 0.01 &&
      (pop().querySelector('.v2-speed') || {}).value === '16';
    // MOTIF 'bar' — same onsets in bars 1/2/4, other pitches under other chords
    L().part.pitch.motif = 'bar'; E.getCfg();
    const mn = window._v2.withEdit(() => window._v2.notesFor(L(), { E, cfg: E.getCfg(), key: 'v2:' + L().id,
      cycleStart: 0, cycleSec: 4 * barSec })) || [];
    const bar = (b) => mn.filter((n) => Math.floor(n.at / barSec + 1e-6) === b);
    const pos = (b) => bar(b).map((n) => ((n.at / barSec) % 1).toFixed(3)).join(',');
    const mid = (b) => bar(b).map((n) => Math.round(69 + 12 * Math.log2(n.freq / 440))).join(',');
    o.motif = { p0: pos(0), p1: pos(1), p3: pos(3), m0: mid(0), m1: mid(1) };
    o.motifRepeats = !!pos(0) && pos(0) === pos(1) && pos(0) === pos(3) && mid(0) !== mid(1);
    // ── THE DRAFT (2026-09-16): nothing a panel does is kept until ✓ Done ──
    // Done first, so everything above is the committed state…
    { const d0 = pop().querySelector('.v2-gendone'); if (d0) d0.click(); await wait(300); }
    const before = JSON.stringify(L().part);
    o.noDraftAfterDone = !window._v2.draftOf(L());
    // …then open ⚙ Deep, change the shape (NO confirm may fire), and ✕ Cancel
    let asked = 0; window.confirm = () => { asked++; return true; };
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(320);
    o.draftOpen = window._v2.draftOf(L());
    const realBefore = JSON.stringify(window.__Lreal(E));
    const cardCv = card().querySelector('.v2-partviz .v2-vizcv');
    const cardPix = () => { try { return cardCv.toDataURL().length + ':' + cardCv.toDataURL().slice(-64); } catch (e) { return ''; } };
    const pix0 = cardPix();
    pop().querySelector('[data-mk="sustain"]').click(); await wait(420);
    o.draftChanged = L().part.mat === 'sustain';
    // STAGED (2026-09-16): the layer proper is untouched, its drawing did not
    // move, and the panel draws what ✓ Done would write
    o.layerUntouched = JSON.stringify(window.__Lreal(E)) === realBefore;
    o.cardDrawingStill = !!pix0 && cardPix() === pix0;
    const scv = pop().querySelector('.v2-stagecv');
    o.stagedDrawn = !!scv && scv.getBoundingClientRect().width > 100 && (() => {
      const g = scv.getContext('2d'); const d = g.getImageData(0, 0, scv.width, scv.height).data;
      let lit = 0; for (let q = 0; q < d.length; q += 4) if (d[q] > 120 && d[q + 2] > 180) lit++;
      return lit > 20; })();
    const pv0 = pop().querySelector('.v2-genprev');
    if (pv0) pv0.click(); await wait(300);
    o.previewStarted = !!window._v2.previewing(L());
    const cx = pop().querySelector('.v2-gencancel'); if (cx) cx.click(); await wait(420);
    o.cancelRestores = JSON.stringify(L().part) === before && !window._v2.draftOf(L()) &&
      !card().classList.contains('v2-genopen');
    o.cancelStopsPreview = !window._v2.previewing(L());
    // …and the same change with ✓ Done stands
    window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); await wait(320);
    pop().querySelector('[data-mk="sustain"]').click(); await wait(420);
    const dn2 = pop().querySelector('.v2-gendone'); if (dn2) dn2.click(); await wait(420);
    o.doneKeeps = window.__Lreal(E).part.mat === 'sustain' && !window._v2.draftOf(L());
    o.neverAsked = asked === 0;
    window.confirm = svCf;
    try {
      const c9 = E.getCfg(); c9.prog = JSON.parse(sv.prog); c9.bpm = sv.bpm; c9.barsPerChord = sv.bpc;
      L().part = JSON.parse(sv.part);
      if (sv.ring) L().ring = sv.ring; else delete L().ring;
      if (Number.isFinite(sv.prox)) L().proximity = sv.prox;
      E._cfg = sv.cfg; E._progAnchor = sv.pa; E._playStartAt = sv.ps; E._barGridAnchor = sv.bg;
      E.getCfg(); if (h) h._sig = ''; window._v2.render(E); await wait(200);
      document.querySelector('.v2-layer').classList.remove('collapsed');
    } catch (e) {}
    return o;
  } catch (e) { return { err: String(e && e.message) }; } });
  ok('a Character lights and applies, says "· tuned" once moved, and ↺ Reset puts it back',
    presetRun && !presetRun.err && presetRun.pickerVisible && presetRun.resetOffFirst && presetRun.lit && presetRun.applied &&
    presetRun.tuned && presetRun.reset, JSON.stringify(presetRun));
  ok('an anticipated change sounds ONCE, an 8th early, and the choke measures it from its own change',
    presetRun && !presetRun.err && presetRun.anticOnce && presetRun.chokeHonoursLead, JSON.stringify(presetRun));
  ok('⚙ Deep is STAGED — the layer and its drawing do not move, the panel draws what ✓ Done writes, ✕ Cancel drops it and stops Preview',
    presetRun && !presetRun.err && presetRun.noDraftAfterDone && presetRun.draftOpen && presetRun.draftChanged &&
    presetRun.layerUntouched && presetRun.cardDrawingStill && presetRun.stagedDrawn &&
    presetRun.previewStarted && presetRun.cancelRestores && presetRun.cancelStopsPreview &&
    presetRun.doneKeeps && presetRun.neverAsked, JSON.stringify(presetRun));
  ok('Speed is a note value per bar, and Motif repeats bar 1 on bars 2 and 4 refitted to the chord',
    presetRun && !presetRun.err && presetRun.speedShown && presetRun.speedWrote && presetRun.motifRepeats,
    JSON.stringify(presetRun));

  // ---- layout + errors ----------------------------------------------------
  const layout = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const small = [...c.querySelectorAll('button, select, input')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 28; }).length;
    return { overflow: Math.round(c.scrollWidth - c.clientWidth),
             docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
             undersized: small };
  });
  ok('no horizontal overflow at 390px', layout.overflow === 0 && layout.docScrollX === 0, JSON.stringify(layout));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  finish();
})().catch((e) => {
  // a halted run keeps driving a closed browser for a moment; that is not an error
  if (halting) return;
  console.error('UI LIFECYCLE: harness error —', e.message);
  console.error(e.stack || ''); process.exit(1);
});
