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
// ─────────────────────────────────────────────────────────────────────────────
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:3001/bloops.html';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));

  // ---- the REAL lifecycle -------------------------------------------------
  // THE CARD IS CREATED THROUGH THE MENU, not `_v2.addDefault`. Calling the API
  // is how this gate went 43 checks green while the user could not find the
  // surface at all: everything after "a card exists" was verified, and nothing
  // verified that pressing + Add layer produces one. Drive the door.
  await page.evaluate(() => {
    document.body.classList.add('view-mix');
    _ambInitMaster();                 // 1. panel builds (wiring sweeps run)
  });
  await new Promise((r) => setTimeout(r, 500));
  const doorOpened = await page.evaluate(() => {
    const b = document.getElementById('mix-bloom-add-layer'); if (!b) return 'no + Add layer button';
    b.scrollIntoView({ block: 'center' }); b.click(); return null;
  });
  await new Promise((r) => setTimeout(r, 450));
  const doorPicked = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (!bs.length) return 'Add-layer popover did not open';
    const t = bs.find((x) => x.textContent.trim() === 'Layer');
    if (!t) return 'no "Layer" entry among: ' + bs.map((x) => x.textContent.trim()).join(' | ');
    t.click(); return null;
  });
  await new Promise((r) => setTimeout(r, 600));
  ok('+ Add layer → "Layer" creates a v2 card', !doorOpened && !doorPicked, doorOpened || doorPicked);
  await page.evaluate(() => { _ambRebuildMaster(); });   // 3. THE STEP ad-hoc probes skip
  await new Promise((r) => setTimeout(r, 500));

  // ---- helpers ------------------------------------------------------------
  // A tap is only meaningful if the element is actually reachable: non-zero box,
  // and whatever is at its centre is the element itself (not something covering
  // it). Both have been real failures here.
  const tap = async (sel) => {
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
    await new Promise((r) => setTimeout(r, 250));
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
    const row = c.querySelector('.v2-cellrow'), g = c.querySelector('.v2-cells');
    const r = g ? g.getBoundingClientRect() : null;
    const out = { rhythm: (_masterEng.getCfg().layers || [])[0].part.rhythm.kind,
             gridShown: !!row && getComputedStyle(row).display !== 'none',
             cells: g ? g.children.length : 0, w: r ? Math.round(r.width) : 0,
             lit: g ? g.querySelectorAll('.on').length : 0 };
    if (wasCollapsed) c.classList.add('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((gr, i) => gr.classList.toggle('open', !!wasOpen[i]));
    return out;
  });
  ok('a NEW layer opens on the pattern grid, no hunting',
    asAdded.gridShown && asAdded.cells > 0 && asAdded.w > 100 && asAdded.lit > 0, JSON.stringify(asAdded));

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
      buttonless: grps.filter((g) => btns.indexOf(g) < 0),
      groupless: btns.filter((b2) => grps.indexOf(b2) < 0),
    };
  });
  // The invariant is the PAIRING in both directions, not a count — pinning 12
  // made a deliberate regroup look like a break. (12 -> 7: Envelope, Voicing,
  // Motion, Mod and Space folded into the group each belongs to.)
  ok('every group has a section tab and every tab a group',
    s.btns === s.grps && s.grps > 0 && !s.buttonless.length && !s.groupless.length, JSON.stringify(s));
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
      // the navigator is six TABS now — the section you are in is the lit
      // one, where it used to be the select's value
      title: w ? ((w.querySelector('.v2-gototab.on') || {}).textContent || '').trim() : null,
      tabs: w ? w.querySelectorAll('.v2-pop-tab').length : 0,
      onTabs: w ? w.querySelectorAll('.v2-pop-tab.on').length : 0,
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
  ok('the editor is embedded in the layer body (opens on Content, tabbed, no overflow)',
    s.open && s.title === 'Content' && s.tabs > 0 && s.onTabs === 1 && s.embedded && s.over <= 0,
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
  await new Promise((r) => setTimeout(r, 250));
  s = await state();
  ok('select writes to the config', s.rhythm === 'euclid');
  const gate = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    // Pulses/Rotate/Vary are MICRO CELLS in the Pattern row now (five full
    // rows were ~500px of a phone sheet), so the gate's own units are rows
    // AND cells — each read from its own label element.
    const vis = [...c.querySelectorAll('.ambient-ctrl, .v2-mini')]
      .filter((r) => r.style.display !== 'none')
      .map((r) => {
        const lb = r.classList.contains('v2-mini')
          ? r.querySelector('.v2-mini-lab') : r.querySelector(':scope > label');
        return ((lb && lb.textContent) || '').trim();
      });
    return { pulses: vis.includes('Pulses'), onsets: vis.includes('Onsets') };
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
    await new Promise((r) => setTimeout(r, 400));
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
  await new Promise((r) => setTimeout(r, 350));
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
  // take / Roll a take / Replace / Re-roll bar N) and 🔒/🔓 is a pure toggle.
  // The lock used to carry a "Replace with a new take" face — a lock that
  // sometimes DISCARDS your notes is two actions in one control — and before
  // that it read "❄ Re-take live" on a fixed part, which sounds like the way
  // back to Generated. Each face carries its own tooltip.
  const capFaces = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    nt().click(); await wait(350);          // 🎲 fills it, still locked
    const filled = { cap: face(), nt: ntFace(), kind: L().part.kind };
    cap().click(); await wait(350);         // 🔓 the SAME button releases
    const released = { cap: face(), kind: L().part.kind };
    return { live, emptyFixed, filled, released, made: L().part.made, n: (L().part.notes || []).length };
  });
  ok('the take bar is 🎲 make + 🔒/🔓 toggle — each face with its own tooltip',
    /Lock this take/.test(capFaces.live.txt) && /drawn above/.test(capFaces.live.title) &&
    /New take/.test(capFaces.live.nt.txt) &&
    /Unlock/.test(capFaces.emptyFixed.cap.txt) && /Roll a take/.test(capFaces.emptyFixed.nt.txt) &&
    /Replace/.test(capFaces.filled.nt.txt) && /still locked/.test(capFaces.filled.nt.title) &&
    capFaces.filled.kind === 'recorded' &&
    /Lock this take/.test(capFaces.released.cap.txt) && capFaces.released.kind === 'live' &&
    capFaces.live.title !== capFaces.emptyFixed.cap.title,
    JSON.stringify(capFaces).slice(0, 300));
  ok('nothing on the card offers to "re-take live" — the way back is the Source select',
    await page.evaluate(() => !/Re-take live/i.test(document.querySelector('.v2-layer').textContent)), '');
  // Replacing WORK asks first; re-rolling a plain locked take does not.
  const capConfirm = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    // 🎲 owns replacing (the lock is a pure toggle now), so the confirm does too
    const cap = () => document.querySelector('.v2-layer .v2-newtake');
    let asked = null; window.confirm = (m) => { asked = m; return true; };
    // REPLACING presupposes a LOCKED part with notes — set it up through the
    // real button rather than inheriting whatever the previous check left
    if (L().part.kind !== 'recorded' || !(L().part.notes || []).length) {
      document.querySelector('.v2-layer .v2-capture').click(); await wait(350);
    }
    asked = null;
    cap().click(); await wait(350);
    const plain = asked;
    L().part.notes[0].vel = 40; E.getCfg();
    asked = null; cap().click(); await wait(350);
    const edited = asked;
    // declining must change nothing
    L().part.notes[0].atk = 900; E.getCfg();
    const before = JSON.stringify(L().part.notes);
    window.confirm = () => false;
    cap().click(); await wait(350);
    return { plain, edited, declineKeeps: JSON.stringify(L().part.notes) === before, made: L().part.made };
  });
  ok('re-rolling a locked take is silent; replacing hand-edited notes asks first',
    capConfirm.plain === null && !!capConfirm.edited && /discarded/.test(capConfirm.edited) && capConfirm.declineKeeps,
    JSON.stringify(capConfirm).slice(0, 260));
  e = await tap('.v2-layer .v2-newtake');
  ok('rolling a take is reachable ON THE CARD', !e, e);
  const escaped = await page.evaluate(() => ((_masterEng.getCfg().layers || [])[0].part.notes || []).length);
  ok('the card button fills an empty recorded part', escaped > 0, 'notes=' + escaped);

  // ---- MATERIAL FIRST, AND EACH ONE REMEMBERS ITSELF ----------------------
  // Material is what the part is MADE OF; Cycle, Bars, Plays and Transpose are
  // answers ABOUT a part you already made, and it sat eighth behind them. And
  // pressing a material button used to overwrite the live spec outright, so
  // tuning an arpeggio, trying a pad and coming back gave you the FACTORY
  // arpeggio and your work was gone.
  const matRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    L().part.kind = 'live'; E.getCfg(); window._v2.render(E);
    await wait(250);
    const c2 = document.querySelector('.v2-layer');
    c2.classList.remove('collapsed');
    [...c2.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === 'Content').click();
    await wait(300);
    const tabs = [...document.querySelectorAll('.v2-pop-tab')].map((t) => t.getAttribute('data-tab'));
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
  ok('Material is the first thing the Part sheet offers',
    matRun.tabs[0] === 'Material', JSON.stringify(matRun.tabs));
  ok('each material remembers its own settings across a switch',
    matRun.sus.n === 1 && matRun.back.n === 13 && matRun.back.oct === 4 && matRun.backSus.voices === 5,
    JSON.stringify(matRun));
  ok('…and a roll still rolls, because a re-roll is what it is for',
    matRun.rolled, String(matRun.rolled));

  // ---- SAVE A TAKE, INTO THE BANK THAT MAPS TO CHANGES --------------------
  // The next press of ⟳ replaces the take, so the way to keep one sits beside
  // the thing that would destroy it — and it goes into the SAME bank
  // `partSeqs` maps by name onto a part/pass/chord, not a private list.
  const bankRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const btn = card().querySelector('.v2-savetake');
    if (!btn) return { err: 'no save button' };
    window.prompt = () => 'gate-take'; window.confirm = () => true;
    btn.click(); await wait(320); card().classList.remove('collapsed');
    const inBank = savedSequences.some((s2) => s2 && s2.name === 'gate-take');
    // it must READ BACK as the same notes — a take that cannot be reloaded
    // exactly is a take you have lost
    window._v2.rollRun(E, L()); E.getCfg();
    const row = card().querySelector('.v2-bankit .v2-bkload');
    const bi = row ? row.getAttribute('data-bi') : null;
    if (row) row.click();
    await wait(320); card().classList.remove('collapsed');
    const after = JSON.stringify(L().part.notes.map((n) => [Math.round(n.t * 1000), n.midi, cells(n)]));
    const names = () => savedSequences.map((s2) => s2.name).join(',');
    const order0 = names();
    const up = card().querySelector('.v2-bkup[data-bi="1"]');
    if (up) { up.click(); await wait(280); card().classList.remove('collapsed'); }
    const order1 = names();
    const out2 = { inBank, roundTrip: after === before, rows: card().querySelectorAll('.v2-bankit').length,
                   order0, order1, bi };
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
  ok('a take saves into the bank and reloads EXACTLY',
    bankRun.inBank && bankRun.roundTrip, JSON.stringify(bankRun).slice(0, 240));
  ok('the Saved bank can be reordered',
    bankRun.rows >= 1 && (bankRun.rows < 2 || bankRun.order0 !== bankRun.order1),
    JSON.stringify({ rows: bankRun.rows, a: bankRun.order0, b: bankRun.order1 }));

  // ---- PER-BAR RE-ROLL ----------------------------------------------------
  // Tap a bar in the drawing to pick it; Replace then rolls ONLY those bars —
  // everything else keeps exactly what it has, per-note edits included. With
  // nothing picked, Replace re-rolls everything, and that press must actually
  // CHANGE the notes: the pinned take meant a "replace" that rolled the same
  // take again returned identical notes, and the old verification compared
  // `made`, never the notes.
  const barRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    // cascaded three checks deep. Search the bar for a spot no note claims,
    // with the handler's own padding (±4 x, ±7 y).
    const tapBar = (bar) => {
      const r = cv().getBoundingClientRect(); const geo = cv()._barsGeo;
      const hits = cv()._hits || [];
      const gx = geo.x0 || 0;
      const x0 = gx + (bar / geo.barsF) * geo.w, x1 = gx + ((bar + 1) / geo.barsF) * geo.w;
      const free = (px, py) => !hits.some((b2) =>
        px >= b2.x - 4 && px <= b2.x + b2.w + 4 && py >= b2.y - 7 && py <= b2.y + b2.h + 7);
      let fx = (x0 + x1) / 2, fy = 17;
      outer: for (let yi = 17; yi < 180; yi += 9) {
        for (let xi = 0; xi < 10; xi++) {
          const px = x0 + 2 + ((x1 - x0 - 4) * xi) / 9;
          if (free(px, yi)) { fx = px; fy = yi; break outer; }
        }
      }
      cv().dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: r.left + fx, clientY: r.top + fy }));
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
    for (let k2 = 0; k2 < 6 && !(selMoved && selFilled); k2++) {
      card().querySelector('.v2-newtake').click(); await wait(350);
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
    // deselect, then a FULL replace must change the notes
    tapBar(SB); await wait(250);
    const faceBack = card().querySelector('.v2-newtake').textContent.trim();
    const b4 = snap();
    card().querySelector('.v2-newtake').click(); await wait(350);
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
  ok('a tapped bar re-rolls ALONE — every other bar, edits included, is untouched',
    /Re-roll bar \d/.test(barRun.face) && barRun.othersKept && barRun.selChanged &&
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const card = () => document.querySelector('.v2-layer');
    L().part.kind = 'live'; delete L().part.takeb; E.getCfg();
    window._v2.rollRun(E, L()); L().part.bars = 4; E.getCfg();
    window._v2.render(E); await wait(250); card().classList.remove('collapsed');
    const cv = () => card().querySelector('.v2-vizcv');
    const barsOf = () => { const m = {}; (cv()._hits || []).forEach((h) => {
      const b2 = Math.floor(h.t * 4); (m[b2] = m[b2] || []).push(Math.round(h.x) + ':' + Math.round(h.midi)); }); return m; };
    const tapBar = (bar) => { const r = cv().getBoundingClientRect(); const geo = cv()._barsGeo;
      const hits = cv()._hits || []; const gx = geo.x0 || 0;
      const x0 = gx + (bar / geo.barsF) * geo.w, x1 = gx + ((bar + 1) / geo.barsF) * geo.w;
      const fr2 = (px, py) => !hits.some((b2) => px >= b2.x - 4 && px <= b2.x + b2.w + 4 && py >= b2.y - 7 && py <= b2.y + b2.h + 7);
      let fx = (x0 + x1) / 2, fy = 17;
      outer: for (let yi = 17; yi < 180; yi += 9) { for (let xi = 0; xi < 10; xi++) {
        const px = x0 + 2 + ((x1 - x0 - 4) * xi) / 9; if (fr2(px, yi)) { fx = px; fy = yi; break outer; } } }
      cv().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + fx, clientY: r.top + fy })); };
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
    for (let k2 = 0; k2 < 6 && !moved; k2++) {
      card().querySelector('.v2-newtake').click(); await wait(300);
      const b1 = barsOf();
      ['0', '1', '2', '3'].filter((kk) => +kk !== SB).forEach((kk) => {
        if (JSON.stringify(b0[kk] || []) !== JSON.stringify(b1[kk] || [])) held = false; });
      if (JSON.stringify(b0[String(SB)] || []) !== JSON.stringify(b1[String(SB)] || []) && (b1[String(SB)] || []).length) moved = true;
    }
    const takeb = JSON.stringify(L().part.takeb || null);
    // 3. LOCK freezes the composite exactly as drawn, and consumes the map
    const drawn = (cv()._hits || []).map((h) => Math.round(h.midi)).sort().join(',');
    window.confirm = () => true;
    card().querySelector('.v2-capture').click(); await wait(350);
    const locked = { kind: L().part.kind, mapGone: !L().part.takeb,
      match: (L().part.notes || []).map((n) => n.midi).sort().join(',') === drawn };
    // cleanup: back to live, selection cleared by a real deselect next render
    L().part.kind = 'live'; delete L().part.takeb; E.getCfg();
    window._v2.render(E); await wait(200); card().classList.remove('collapsed');
    return { silent, whole, face, moved, held, takeb, locked };
  });
  ok('🎲 New take REWRITES silently — no audition, and the drawing moves',
    ntRun.silent && ntRun.whole, JSON.stringify(ntRun).slice(0, 160));
  ok('a selected bar RETAKES alone on a live part, pinned in part.takeb',
    /Retake bar \d/.test(ntRun.face) && ntRun.moved && ntRun.held && /"\d":/.test(ntRun.takeb),
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    const face = (b) => ((b && b.childNodes[0] && b.childNodes[0].nodeValue) || '').trim();
    const st2 = () => ({
      on: [...card().querySelectorAll('.v2-genshapes .ambient-seg.on, .v2-seedv1.on')]
        .map((x) => face(x).slice(0, 14)).join('|'),
      // …and what the CARD says without the panel open — the door names the
      // shape in force, which is what consolidating four buttons must not cost
      door: (card().querySelector('.v2-genface') || {}).textContent || '',
      hint: card().querySelector('.v2-notecount').textContent });
    // the shapes live behind ⚙ Shape… now; the panel stays open across a
    // choice, so this opens it once
    card().querySelector('.v2-genbtn').click(); await wait(280); card().classList.remove('collapsed');
    card().querySelector('.v2-shapepop .v2-rollrun').click(); await wait(350); card().classList.remove('collapsed');
    const roll = st2();
    card().querySelector('.v2-shapepop .v2-mkpart[data-mk="sustain"]').click(); await wait(400); card().classList.remove('collapsed');
    const sus = st2();
    // shut the panel before the seed row — it covers the card, and a panel
    // left open breaks whatever runs next (it already broke the Pattern tab's
    // hit test one check later)
    const gc = card().querySelector('.v2-shapepop .v2-genclose'); if (gc) gc.click();
    await wait(200); card().classList.remove('collapsed');
    card().querySelector('.v2-seedv1[data-v1="bass"]').click(); await wait(450); card().classList.remove('collapsed');
    const seed = st2();
    window.confirm = () => true;
    card().querySelector('.v2-capture').click(); await wait(400); card().classList.remove('collapsed');
    const locked = st2();
    // back to a plain live state for whoever runs next
    L().part.kind = 'live'; delete L().part.mat; delete L().part.mem; E.getCfg();
    window._v2.render(E); await wait(200); card().classList.remove('collapsed');
    return { roll, sus, seed, locked };
  });
  // RESTATED: it pinned the JARGON hint (`euclid 5 of 8 · walk · take 1`),
  // which was every term correct and no answer to "what will this generate" —
  // reported as the whole thing being opaque. Same contract (the hint NAMES
  // THE RULES, and the take), now asserted on the words a reader gets.
  ok('the Material door that made the content is LIT, and the hint names the rules',
    /Roll/.test(provRun.roll.on) && /Roll/.test(provRun.roll.door) &&
    /Sustained/.test(provRun.sus.door) &&
    /hits spread evenly over \d+ steps/.test(provRun.roll.hint) &&
    /take \d/.test(provRun.roll.hint) &&
    /Sustained/.test(provRun.sus.on) && !/Roll/.test(provRun.sus.on) &&
    /notes? of the chord/.test(provRun.sus.hint),
    JSON.stringify(provRun).slice(0, 240));
  ok('a v1 seed lights its chip, and a locked take still says what it was a take OF',
    /Bass/.test(provRun.seed.on) && /seeded like a v1 bass/.test(provRun.seed.hint) &&
    /Bass/.test(provRun.locked.on) && /v1 bass seed/.test(provRun.locked.hint) &&
    // RESTATED with the vocabulary: one pair of words for the axis, so a
    // locked take is WRITTEN DOWN (it was "LOCKED", which named the action
    // rather than the state and left "Fixed" naming the same state elsewhere).
    // The contract is unchanged — it still says it plays these notes.
    /WRITTEN DOWN/.test(provRun.locked.hint) &&
    /plays these notes, not the rules/.test(provRun.locked.hint),
    JSON.stringify(provRun).slice(0, 240));
  // NO STAMP IS NOT NO MATERIAL — a part made before provenance existed (or
  // assembled by hand on the knobs) still IS one of the materials, and the
  // rules' shape says which: series = an arpeggiator, one held chord = a
  // sustain, a walked line = the run. The reported case exactly: a locked
  // take, no `mat`, euclid + walk — and no door lit.
  const inferRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, cfg = E.getCfg(), L = () => (E.getCfg().layers || [])[0];
    const svProg = cfg.prog ? JSON.parse(JSON.stringify(cfg.prog)) : null;
    cfg.prog = { on: true, name: 'SY', chords: [0, 5, 7, 2, 9].map(rt => ({ root: rt, intervals: [0, 4, 7] })) };
    L().part.kind = 'live'; L().part.bars = 4; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    const gb = [...card.querySelectorAll('.v2-gototab')].find(x =>
      x.tagName === 'BUTTON' && x.getAttribute('data-goto') === 'Content');
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, cfg = E.getCfg();
    const L = () => (E.getCfg().layers || [])[0];
    const svProg = cfg.prog ? JSON.parse(JSON.stringify(cfg.prog)) : null;
    const svPart = JSON.stringify(L().part);   // restore WHOLE, or the leaked
    // fixed/degree-1 pitch makes every later retake check unable to move
    cfg.prog = { on: true, name: 'PP', chords: [0, 7, 5, 9].map(rt => ({ root: rt, intervals: [0, 4, 7] })),
                 parts: [{ name: 'Verse', len: 2 }, { name: 'Chorus', len: 2 }] };
    L().part.kind = 'live'; E.getCfg();
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    [...card.querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Content').click();
    await wait(250);
    const sel = () => document.querySelector('.v2-pop-part');
    const ppb = () => document.querySelector('.v2-pop-pp');
    const rp = ppb().getBoundingClientRect(), rs = sel().getBoundingClientRect(),
          rb = document.querySelector('.v2-pop-sync').getBoundingClientRect();
    const o = { joined: Math.abs(rp.right - rs.left) < 2 && Math.abs(rs.right - rb.left) < 2 && rp.width > 40,
      modeOff: ppb().textContent.trim(), selDisabled: sel().disabled,
      selDash: (sel().selectedOptions[0] || {}).text,
      label: document.querySelector('.v2-pop-sync').textContent.trim() };
    // enable per-part with the TOGGLE, then pick with the selector
    ppb().click(); await wait(300);
    o.modeOn = ppb() && ppb().classList.contains('on');
    o.selEnabled = sel() && !sel().disabled;
    const pick = async (v) => { const s2 = sel(); s2.value = v;
      s2.dispatchEvent(new Event('input', { bubbles: true })); await wait(300); };
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
    o.readsAfter = sel().selectedOptions[0].text;
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
  ok('the Content head is a joined trio — [mode][which part][⇄ Sync] — mode toggles, selector follows',
    ppRun.joined && /Everywhere/.test(ppRun.modeOff) && ppRun.selDisabled && ppRun.selDash === '\u2014' &&
    ppRun.modeOn && ppRun.selEnabled && ppRun.label === '\u21c4 Sync' && ppRun.readsAfter === 'Verse',
    JSON.stringify(ppRun).slice(0, 260));
  ok('choosing a part files the old record and restores its own — bars, pitch, everything',
    ppRun.roundTrip && ppRun.barsFollowPart, JSON.stringify(ppRun).slice(0, 240));
  ok('the EMITTER plays each arrangement part its own content, resolved by time (2 vs 7 onsets)',
    ppRun.emitDiffers && ppRun.emitStable,
    JSON.stringify({ verse: ppRun.verse, chorus: ppRun.chorus }));
  ok('the mode toggle (confirmed) returns to one-everywhere and drops the filed records',
    ppRun.cleared, JSON.stringify(ppRun).slice(0, 200));
  // THE CURRENT-PART STRIP — between the tab section and the layers: a readout
  // of the part being EDITED, and tapping one switches every v2 layer's
  // content record to it. Playback must be untouched (the clocks never move).
  const cpRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, cfg = E.getCfg();
    const L = () => (E.getCfg().layers || [])[0];
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
    const chips = () => [...strip().querySelectorAll('.ambient-curpart-chip')];
    o.shown = strip().style.display !== 'none';
    o.chips = chips().map(c => c.textContent + (c.classList.contains('on') ? '*' : '')).join(' ');
    const kids = [...strip().parentElement.children];
    o.placed = kids.indexOf(strip()) === kids.findIndex(k => k.classList.contains('ambient-tabsec')) + 1 &&
      kids.indexOf(strip()) < kids.findIndex(k => k.classList.contains('ambient-layer'));
    const clock0 = { prog: E._progAnchor, grid: E._barGridAnchor, timer: !!E.timer };
    // a SHARED layer must not follow — per-part is its own explicit control
    chips()[1].click(); await wait(300);
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
  // GREY, NOT GONE — on a Fixed part, a row whose only failing gate is
  // `kind:live` stays visible and inert (.v2-rowna): hiding the rhythm rows
  // there read as "where did the rhythm params go". An ALTERNATIVE gate
  // (wrong rhythm kind, wrong voice) still hides.
  const greyRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const svPart = JSON.stringify(L().part);
    L().part.kind = 'live'; L().part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 }; E.getCfg();
    window._v2.capture(E, L()); E.getCfg();
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    [...card.querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Content').click();
    await wait(250);
    const pop = document.querySelector('.v2-pop');
    const open = async (nm) => { const t = [...pop.querySelectorAll('.v2-pop-tabs [data-tab]')]
      .find(x => x.getAttribute('data-tab') === nm); if (t) { t.click(); await wait(200); } return !!t; };
    // THE RHYTHM TABS REFUSE TO OPEN on a Fixed part now (a no-op control
    // that answers beats one that silently does nothing), so the VISIBLE grey
    // is observed through a tab that DOES open — Shape's `kind:live` rows —
    // while the rhythm rows are asserted at the class level, which is where
    // applyGate sets them whether or not their tab is showing.
    const o = { patternTab: !!pop.querySelector('.v2-pop-tabs [data-tab="Pattern"]') };
    // GREY IS FOR PARAMETER ROWS ONLY — a gated BUTTON still hides: 🎲 New
    // take is the LIVE re-roll and "Replace with a new take" its recorded
    // twin; greying leaked both dice onto one recorded take bar (reported).
    o.noGreyButtons = ![...card.querySelectorAll('button')].some(x => x.classList.contains('v2-rowna'));
    const grid = pop.querySelector('.v2-cellrow');
    o.gridNa = !!grid && grid.classList.contains('v2-rowna') && grid.style.display !== 'none';
    const pulses = [...pop.querySelectorAll('[data-f="part.rhythm.pulses"]')].map(x => x.closest('.v2-mini'))[0];
    o.pulsesNa = !!pulses && pulses.style.display !== 'none' && pulses.classList.contains('v2-rowna');
    // VISIBLE, INERT, and readable — on a tab that opens
    await wait(150);
    [...card.querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Shape').click();
    await wait(250);
    const sp = document.querySelector('.v2-pop');
    // the row of the ACTIVE tab — every other tab's rows are `v2-rowoff` and
    // measure 0, so an unscoped find picks one that is merely not showing
    const st2 = [...sp.querySelectorAll('.ambient-ctrl.v2-rowna')]
      .find(r => !r.classList.contains('v2-rowoff') && r.getBoundingClientRect().height > 10);
    o.greyVisible = !!st2 && getComputedStyle(st2).pointerEvents === 'none' &&
      parseFloat(getComputedStyle(st2.querySelector('label') || st2).opacity) < 0.6;
    await wait(150);
    [...card.querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Content').click();
    await wait(250);
    // an ALTERNATIVE gate still hides: Onsets is rhythm:pulse and this part is euclid
    const onsets = [...document.querySelectorAll('.v2-pop [data-f="part.rhythm.n"]')]
      .map(x => x.closest('.ambient-ctrl'))[0];
    o.altStillHidden = !!onsets && onsets.style.display === 'none';
    // back to Generated: the grey lifts
    L().part.kind = 'live'; E.getCfg();
    window._v2.render(E); await wait(250);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    const p2 = [...document.querySelectorAll('[data-f="part.rhythm.pulses"]')].map(x => x.closest('.ambient-ctrl'))[0];
    o.liveClear = p2 && !p2.classList.contains('v2-rowna');
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('on a Fixed part the live-only rows GREY OUT instead of hiding — alternatives hide, and no BUTTON is ever greyed',
    greyRun.patternTab && greyRun.gridNa && greyRun.pulsesNa && greyRun.greyVisible &&
    greyRun.altStillHidden && greyRun.liveClear && greyRun.noGreyButtons,
    JSON.stringify(greyRun));
  // TAB FAMILIES — Content's thirteen tabs were an undifferentiated wall; the
  // strip is labelled, tinted family rows now (make · rhythm · time · pitch),
  // with a trailing unlabelled row so a NEW tab can never vanish from it.
  const famRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const svKind = L().part.kind;
    L().part.kind = 'recorded'; E.getCfg();       // the fullest tab set
    window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer'); card.classList.remove('collapsed');
    [...card.querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Content').click();
    await wait(250);
    const strip = document.querySelector('.v2-pop-tabs');
    // TWO-LEVEL STRIP: the family BAR carries the names; only the active
    // family's tab row is visible (four stacked rows were "way too small a
    // scrollable section" on a phone); hidden tabs stay in the DOM so
    // programmatic navigation works.
    const fams = [...strip.querySelectorAll('.v2-fambtn')].map(f => f.textContent + ':' +
      (f.classList.contains('on') ? 'on' : 'off'));
    const inFams = [...strip.querySelectorAll('.v2-tabfam [data-tab]')].length;
    const total = [...strip.querySelectorAll('[data-tab]')].length;
    const visRows = [...strip.querySelectorAll('.v2-tabfam')].filter(f => f.getBoundingClientRect().height > 0).length;
    const stripH = Math.round(strip.getBoundingClientRect().height);
    // the family chips FILL the row, equal widths (the strip is a row flex
    // from the flat design, so they sized to content until it stacked)
    const bar = strip.querySelector('.v2-fambar');
    const allChips = [...bar.querySelectorAll('.v2-fambtn')];
    // RESTATED: Saved is deliberately NOT an equal sibling — it is the bank,
    // an inverse-filled chip sized to its own text at the right end. The
    // SHARING chips still split the row evenly.
    const bw = allChips.filter(x => !x.classList.contains('fam-saved'))
      .map(x => Math.round(x.getBoundingClientRect().width));
    const chipsEqual = bw.length >= 3 && new Set(bw).size === 1 && bw[0] > 60 &&
      Math.abs(allChips.reduce((a, c) => a + c.getBoundingClientRect().width, 0) +
               6 * (allChips.length - 1) - bar.getBoundingClientRect().width) < 3;
    // SAVED: inverse (filled, text knocked out in the sheet ground), last chip
    const sv = bar.querySelector('.v2-fambtn.fam-saved');
    const svCs = sv ? getComputedStyle(sv) : null;
    const savedInverse = !!sv && sv === allChips[allChips.length - 1] &&
      svCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && svCs.color === 'rgb(18, 18, 31)';
    // RHYTHM LIVES IN MAKE, tinted teal — and on a Fixed part it is a no-op,
    // so the tabs dim (still openable: the rows behind explain themselves)
    const mk = [...strip.querySelectorAll('.v2-fambtn')].find(x => /make/i.test(x.textContent));
    if (mk) mk.click();
    const mkTabs = [...strip.querySelectorAll('.v2-tabfam.fam-on .v2-pop-tab')];
    const rhy = mkTabs.find(x => x.getAttribute('data-tab') === 'Rhythm');
    const rhythmInMake = !!rhy && /tint-fam-rhythm/.test(rhy.className) &&
      mkTabs.some(x => x.getAttribute('data-tab') === 'Material');
    const naDim = !!rhy && rhy.classList.contains('v2-tabna') &&
      parseFloat(getComputedStyle(rhy).opacity) < 0.6 && rhy.getAttribute('aria-disabled') === 'true';
    // …AND A PRESS REFUSES AND EXPLAINS. A control that visibly does nothing
    // is worse than one that answers, so the no-op tab does not navigate —
    // it toasts the condition under which it becomes usable.
    const onBefore = (document.querySelector('.v2-pop-tab.on') || {}).textContent;
    if (rhy) rhy.click();
    await wait(220);
    const tst = document.querySelector('.bloops-toast');
    const naRefuses = !!rhy && !rhy.classList.contains('on') &&
      (document.querySelector('.v2-pop-tab.on') || {}).textContent === onBefore &&
      // it names the way out, which is 🔓 Unlock under the drawing now that the
      // Source select (a third door to the same field) is gone
      !!tst && getComputedStyle(tst).display !== 'none' && /Unlock/.test(tst.textContent);
    // a row label that repeats the active tab is hidden — EXCEPT one carrying
    // a control (Pattern's ↻ regen button lives inside its label)
    const labOf = (nm) => { const t2 = [...strip.querySelectorAll('[data-tab]')].find(x => x.getAttribute('data-tab') === nm);
      if (t2) t2.click();
      const r2 = [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')].find(x =>
        x.getBoundingClientRect().height > 0 && !x.classList.contains('v2-rowoff'));
      const lb = r2 && r2.querySelector(':scope > label');
      return lb ? getComputedStyle(lb).display : 'none'; };
    const dupHidden = labOf('Material') === 'none';
    // A LABEL CARRYING A CONTROL IS NEVER DEDUPED (the Pattern row's ↻ regen
    // button lives inside its label). Asserted on the mechanism — every such
    // row, whichever tab is showing — rather than on the first visible row,
    // which the grid-leads reorder moved out from under the old probe.
    const withCtrl = [...document.querySelectorAll('.v2-pop-pane .ambient-ctrl')]
      .filter(r => r.querySelector(':scope > label button, :scope > label input, :scope > label select'));
    const ctrlLabKept = withCtrl.length > 0 && withCtrl.every(r => !r.classList.contains('v2-labdup'));
    // PHONE HEAD: two deliberate rows — [title ... ✕] then the trio — and the
    // family labels sit ABOVE their chips (the gutter scattered the wrap).
    const head = document.querySelector('.v2-pop-head');
    // PHONE HEAD, restated: the section tabs WRAP to two rows —
    // [Instrument Content Pitch Shape] then [Mix FX · Reg ± · ✕] — with the
    // per-part trio below both. Measured off the TABS, not `.v2-pop-title`:
    // that box is `display: contents` on a phone (which is what lets Mix and
    // FX share a row with their siblings), so its rect is zero.
    const tabsH = [...head.querySelectorAll('.v2-gototab')];
    const rT = tabsH[0].getBoundingClientRect();
    const rL = tabsH[tabsH.length - 1].getBoundingClientRect();
    // RESTATED with the embed: the sections own the top row(s) outright
    // ("the section buttons should be the whole top row, and 2 rows if
    // necessary so the buttons are large enough"), and the per-part trio sits
    // BELOW them. There is no ✕ — the editor is the card's body.
    const rP = head.querySelector('.v2-pop-pair').getBoundingClientRect();
    const phoneHead = rL.top >= rT.bottom - 4 &&                    // it wrapped
      tabsH.every((t2) => t2.getBoundingClientRect().height >= 36) && // still a real target
      rP.top >= rL.bottom - 4 &&                                    // trio below the tabs
      head.scrollWidth - head.clientWidth === 0;
    // tapping a family chip shows its row and lands on its first tab
    [...strip.querySelectorAll('.v2-fambtn')].find(x => /time/i.test(x.textContent)).click(); await wait(200);
    const famNav = [...document.querySelectorAll('.v2-tabfam.fam-on [data-tab]')].map(x => x.textContent).join(',');
    const t = [...strip.querySelectorAll('[data-tab]')].find(x => x.getAttribute('data-tab') === 'Bars');
    t.click(); await wait(200);
    // the PANE wears the family: row labels take its hue (Bars → time → blue)
    const pane = document.querySelector('.v2-pop-pane');
    const lab = [...pane.querySelectorAll('.ambient-ctrl')].find(r =>
      r.style.display !== 'none' && !r.classList.contains('v2-rowoff'));
    const o = { fams: fams.join(' '), allInFams: inFams === total && total >= 10,
      navWorks: t.classList.contains('on'), phoneHead, famNav, visRows, stripH,
      chipsEqual, dupHidden, ctrlLabKept, bw: bw.join(','),
      savedInverse, rhythmInMake, naDim, naRefuses,
      paneFam: pane.getAttribute('data-fam'),
      labHue: lab ? getComputedStyle(lab.querySelector('label')).color : null };
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
  ok('the Content tab strip is a two-level navigator — make (with rhythm) · time · pitch · Saved',
    /make:/.test(famRun.fams) && /saved:/.test(famRun.fams) && /time:/.test(famRun.fams) &&
    /pitch:/.test(famRun.fams) && famRun.allInFams && famRun.navWorks &&
    famRun.savedInverse && famRun.rhythmInMake && famRun.naDim && famRun.naRefuses &&
    famRun.phoneHead && famRun.visRows === 1 && famRun.stripH <= 160 &&
    /Cycle/.test(famRun.famNav) && famRun.chipsEqual && famRun.dupHidden && famRun.ctrlLabKept &&
    famRun.paneFam === 'fam-time' && famRun.labHue === 'rgb(99, 179, 237)',
    JSON.stringify(famRun));
  // THE ICE MODEL — the Everywhere record survives per-part mode intact, every
  // part (added whenever) starts from a FITTED copy of it, an un-diverged
  // part's playback never depends on which part is selected, and part deletion
  // re-indexes the records (the clamped-index trap).
  const iceRun = await page.evaluate(async () => {
    const E = _masterEng, cfg = E.getCfg();
    const L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
  // THE PATTERN TAB: the GRID LEADS (it is the thing you edit — it sat under
  // five knob rows), and the knobs that describe it are ONE row of micro
  // steppers (five full rows were ~500px of a ~170px pane). The markup is the
  // sheet head's Register pattern, so the document ± delegation drives it and
  // the card's `.v2-f` handler commits it — no wiring of its own.
  const patRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const svPart = JSON.stringify(L().part);
    L().part.kind = 'live'; L().part.rhythm = { kind: 'euclid', pulses: 5, steps: 16, rotate: 0 }; E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E); await wait(250);
    const card = () => document.querySelector('.v2-layer');
    card().classList.remove('collapsed');
    const openPat = async () => {
      if (!document.querySelector('.v2-pop'))
        [...card().querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Content').click();
      await wait(220);
      const t = [...document.querySelectorAll('.v2-pop-tabs [data-tab]')].find(x => x.getAttribute('data-tab') === 'Pattern');
      if (t) t.click(); await wait(200);
    };
    await openPat();
    const pane = document.querySelector('.v2-pop-pane');
    const micro = pane.querySelector('.v2-microrow');
    const cells = [...micro.querySelectorAll('.v2-mini')].filter(c => c.style.display !== 'none');
    const b0 = cells[0].querySelector('.ambient-step-btn').getBoundingClientRect();
    const o = {
      order: [...pane.querySelectorAll('.ambient-ctrl')]
        .filter(r => r.getBoundingClientRect().height > 0 && !r.classList.contains('v2-rowoff'))
        .map(r => (/v2-cellrow/.test(r.className) ? 'GRID' : /v2-microrow/.test(r.className) ? 'knobs' : 'row')).join(','),
      labs: cells.map(c => c.querySelector('.v2-mini-lab').textContent).join(','),
      microH: Math.round(micro.getBoundingClientRect().height),
      // iOS zooms a focused field under 16px and never zooms back
      font: getComputedStyle(cells[0].querySelector('.ambient-step-inp')).fontSize,
      hitOK: (() => { const b1 = cells[0].querySelector('.ambient-step-btn');
        b1.scrollIntoView({ block: 'center' });
        const q1 = b1.getBoundingClientRect();
        return document.elementFromPoint(q1.left + q1.width / 2, q1.top + q1.height / 2) === b1; })(),
      overflow: pane.scrollWidth - pane.clientWidth,
    };
    // DRIVE THEM — re-query after every click, the card re-renders on a commit
    const cell = (nm) => [...document.querySelectorAll('.v2-pop-pane .v2-mini')]
      .find(c => c.querySelector('.v2-mini-lab').textContent === nm);
    const s0 = +(L().part.rhythm.steps);
    cell('Steps').querySelector('.ambient-step-up').click(); await wait(280); await openPat();
    o.steps = (+(L().part.rhythm.steps)) - s0;
    // `data-nudge` — a 0-100 field would be unusable at ±1
    cell('Vary').querySelector('.ambient-step-up').click(); await wait(280); await openPat();
    o.varyNudge = +(L().part.rhythm.vary || 0);
    await wait(150);
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    document.querySelector('.v2-layer').classList.remove('collapsed');
    return o;
  });
  ok('the Pattern tab leads with the GRID, and its knobs are one compact micro row that commits',
    patRun.order === 'GRID,knobs' && patRun.labs === 'Steps,Pulses,Rotate,Voices,Vary' &&
    patRun.microH <= 130 && patRun.font === '16px' && patRun.hitOK && patRun.overflow === 0 &&
    patRun.steps === 1 && patRun.varyNudge === 5,
    JSON.stringify(patRun));
  // CHOOSING THE MODE YOU ARE ALREADY IN IS A NO-OP. These name what the part
  // IS, so the lit one restates a fact — and pressing 🎲 Roll used to REPLACE
  // your take (it re-rolled), which is 🎲-above-the-drawing's job.
  const noopRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const card = () => document.querySelector('.v2-layer');
    const svPart = JSON.stringify(L().part);
    window.confirm = () => true;
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    // the shapes moved into the ⚙ Shape… popover; it stays open across a
    // choice, so one press gets in and one gets out at the end
    card().querySelector('.v2-genbtn').click(); await wait(280);
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
    const gc2 = card().querySelector('.v2-shapepop .v2-genclose'); if (gc2) gc2.click();
    await wait(200); card().classList.remove('collapsed');
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    card().classList.remove('collapsed');
    return o;
  });
  ok('a Material button is a MODE, not a status or an action — the lit one is a no-op',
    noopRun.label === '\ud83c\udfb2 Roll' && noopRun.mark === 'none' &&
    noopRun.rollNoop && noopRun.modeNoop && /Sustained/.test(noopRun.stillLit),
    JSON.stringify(noopRun));
  // THREE THINGS THE MATERIAL ROW OWES THE USER: choosing a mode is SILENT
  // (an audition while clicking through the row reads as a stray note from
  // nowhere — the same rule 🎲 New take already follows), the row says WHICH
  // KIND each option is ("what's the difference between Composed and
  // Sustained?" — one writes notes, the other is a rule), and on a phone the
  // pattern grid has finger-sized cells (16 steps across a 333px pane is 18px).
  const matKindRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    [...card().querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Content').click();
    await wait(250);
    [...document.querySelectorAll('.v2-pop-tabs [data-tab]')].find(x => x.getAttribute('data-tab') === 'Pattern').click();
    await wait(250);
    const pane = document.querySelector('.v2-pop-pane');
    const cells = [...pane.querySelectorAll('.v2-cellrow:not(.v2-lanerow) .ambient-euclid-cell')]
      .filter(c => c.getBoundingClientRect().height > 0);
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
    const now = [...document.querySelectorAll('.v2-pop-pane .v2-cellrow:not(.v2-lanerow) .ambient-euclid-cell')]
      .filter(c => c.getBoundingClientRect().height > 0);
    o.toggles = !!now[3] && now[3].classList.contains('on') !== was;
    o.overflow = pane.scrollWidth - pane.clientWidth;
    await wait(150);
    try { L().part = JSON.parse(svPart); } catch (e) {}
    delete L().part.mat; delete L().part.mem; E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(200);
    card().classList.remove('collapsed');
    return o;
  });
  ok('choosing a Material is SILENT, the row says which KIND each option is, and the phone grid is finger-sized',
    // Generated is FOUR doors since ⚇ Mixed — the other three each commit to
    // one texture, so chords-and-single-notes had no door. The contract is the
    // two labelled clusters, not the count, but the count is worth pinning so
    // a door cannot vanish unnoticed.
    // ONE Generated door now — the four shapes moved behind ⚙ Shape…, which
    // is where their knobs are. The contract is the two labelled clusters.
    // TWO Generated doors: ⚙ Shape… (the figure on top) and ⛰ Groundwork
    // (playing the changes themselves). The contract is the two labelled
    // clusters; the count is pinned so a door cannot vanish unnoticed.
    matKindRun.silent && /Written:2/.test(matKindRun.groups) && /Generated:2/.test(matKindRun.groups) &&
    matKindRun.cellBig && matKindRun.hit && matKindRun.toggles && matKindRun.overflow === 0,
    JSON.stringify(matKindRun));
  // COMPOSING TAKES THE SHEET. The docked Grid editor is a full instrument
  // (~464px) and the sheet's pane is ~230px on a phone — it could not fit, and
  // ✓ Done / ⬇ To bank / ✕ Cancel sat below the fold (measured at y=1183 in an
  // 800px window). While a session is open the drawing, the tab strip and
  // ▶ Preview step aside, the actions PIN to the bottom, and on a phone the
  // sheet fills the screen.
  const compRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const svPart = JSON.stringify(L().part);
    // the per-chord strip only has blocks to draw when there ARE changes
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    E.getCfg().prog = { on: true, name: 'CMP', chords: [0, 2, 4, 5, 7].map(rt => ({ root: rt, intervals: [0, 4, 7] })) };
    E.getCfg();
    const card = () => document.querySelector('.v2-layer');
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    if (!document.querySelector('.v2-pop'))
      [...card().querySelectorAll('.v2-gototab')].find(x => x.getAttribute('data-goto') === 'Content').click();
    await wait(250);
    document.querySelector('.v2-compose').click(); await wait(700);
    const pop = document.querySelector('.v2-pop');
    const acts = document.querySelector('.v2-gacts');
    const o = { composing: card().classList.contains('v2-composing'), started: !!acts };
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
      o.stepsAside = getComputedStyle(pop.querySelector('.v2-partviz')).display === 'none' &&
        getComputedStyle(pop.querySelector('.v2-pop-foot')).display === 'none' &&
        getComputedStyle(pop.querySelector('.v2-pop-tabs')).display !== 'none' &&
        (() => { const bn = pop.querySelector('.v2-compbanner');
          return !!bn && getComputedStyle(bn).display !== 'none' &&
                 bn.getBoundingClientRect().height > 10; })() &&
        // …and the tab strip READS as inert
        +getComputedStyle(pop.querySelector('.v2-pop-tabs').firstElementChild).opacity < 0.6;
      // A PRESS REFUSES AND EXPLAINS — it used to be hidden, and the Material
      // doors silently did nothing ("clicking the other options does nothing")
      const wasTab = (pop.querySelector('.v2-pop-tab.on') || {}).textContent;
      const other = pop.querySelector('.v2-pop-tab:not(.on)');
      if (other) other.click(); await wait(240);
      const tst2 = document.querySelector('.bloops-toast');
      o.refuses = !!other && (pop.querySelector('.v2-pop-tab.on') || {}).textContent === wasTab &&
        !!tst2 && /composing/i.test(tst2.textContent);
      o.editorDocked = (() => { const ex = document.getElementById('lane-expander');
        return !!ex && !!ex.closest('.v2-dock') && ex.getBoundingClientRect().height > 200; })();
      // THE COMPOSITION SURFACE LEADS — the per-chord strip is what you write
      // INTO, and it used to sit a whole keyboard (464px) below the fold
      const dk = document.querySelector('.v2-dock');
      const ch = dk && dk.querySelector('.ambient-seedgrid-chords');
      const ky = dk && dk.querySelector('.ambient-seedgrid-dockhost');
      const rp = pop.querySelector('.v2-pop-pane').getBoundingClientRect();
      const row0 = ch && ch.querySelector('.sglane-row');
      // THE GRID LEADS, THEN THE SEQUENCE. The strip was put above the keyboard
      // when the dock lived in a ~230px sheet pane, where anything under it was
      // off screen; embedded, the editor is in the page flow and the panel
      // scrolls, so the order is the one Make uses ("why is the sequencer above
      // the grid").
      o.stripLeads = !!ch && !!ky && ky.getBoundingClientRect().top < ch.getBoundingClientRect().top;
      o.stripInView = !!row0 && row0.getBoundingClientRect().top >= rp.top - 1 &&
        row0.getBoundingClientRect().bottom <= rp.bottom + 1;
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const svProg = E.getCfg().prog ? JSON.parse(JSON.stringify(E.getCfg().prog)) : null;
    const svPart = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const open = async () => {
      const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
      window._v2.render(E); await wait(260);
      card().classList.remove('collapsed');
      const gt = card().querySelector('.v2-gototab[data-goto="Content"]');
      if (gt && !gt.classList.contains('on')) { gt.click(); await wait(220); }
      card().querySelector('.v2-compose').click(); await wait(800);
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
  // A DERIVED PART NAME IS RECOMPUTED, NEVER REMEMBERED. A part picked from
  // the catalogue is named by its numerals, which is a DESCRIPTION of chords —
  // so the moment one is added or removed the stored string lies (reported: a
  // 5-chord part named with 4 numerals). An AUTHORED name is never touched.
  const nameRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    o.matches = o.p0.split(' — ').length === o.c0 && o.p1.split(' — ').length === o.c1;
    // an AUTHORED name is returned verbatim
    E.getCfg().prog.parts[0].name = 'Verse'; E.getCfg();
    o.authored = nm(0) === 'Verse';
    // …and a derived one FOLLOWS an edit
    E.getCfg().prog.parts[0].name = 'I — II — III — I';
    const c2 = E.getCfg(); c2.prog.chords.splice(5, 0, mk(9, [0, 3, 7])); c2.prog.parts[0].len = 6;
    E.getCfg();
    o.after = nm(0);
    o.grew = o.after.split(' — ').length === cnt(0);
    if (svProg) E.getCfg().prog = svProg; else delete E.getCfg().prog;
    const c3 = E.getCfg(); c3.keyOn = svKey.on; c3.keyRoot = svKey.root; c3.keyScale = svKey.scale;
    E.getCfg();
    return o;
  });
  ok('a derived part name is recomputed from its CURRENT chords; an authored one is left alone',
    nameRun.matches && /I — ii — iii — IV — V/.test(nameRun.p0) && nameRun.authored && nameRun.grew,
    JSON.stringify(nameRun));
  // ✨ TRANSFORM — commands over the notes you already have. A registry, so
  // the set grows by one entry; scoped by the bar selection when there is one.
  const tfRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    o.liveRefuses = !!t1 && /Lock this take/.test(t1.textContent) && !document.querySelector('.ctx-menu');
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
    // …and a transformed take counts as WORK: replacing it asks first
    let asked = null; window.confirm = (m) => { asked = m; return false; };
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    card().classList.remove('collapsed');
    card().querySelector('.v2-newtake').click(); await wait(300);
    o.replaceAsks = !!asked;
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    card.querySelector('.v2-gototab[data-goto="Content"]').click(); await wait(320);
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const o = { door: !!card().querySelector('.v2-gwbtn') };
    // OPENING IS CHOOSING — there is no "Use Groundwork" button to press, and
    // ✕ Cancel is what makes that safe
    const wasRhythm = L().part.rhythm.kind;
    card().querySelector('.v2-gwbtn').click(); await wait(450);
    const r = card().querySelector('.v2-gwpop').getBoundingClientRect();
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
    const pop = card().querySelector('.v2-gwpop');
    const pr2 = pop.getBoundingClientRect();
    o.popH = Math.round(pr2.height);
    o.popFits = pr2.top >= 0 && pr2.bottom <= innerHeight + 1 &&
                pop.scrollHeight <= pop.clientHeight + 2;
    o.cellOneLine = cells().every((c) => {
      const cr = c.getBoundingClientRect(); if (cr.height > 60) return false;
      const n = c.querySelector('.v2-gwcn'), b = c.querySelector('.ambient-step-btn');
      if (!n || !b) return false;
      const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect();
      // side by side: they overlap vertically and the button is to the right
      return br.left >= nr.right - 1 && br.top < nr.bottom && nr.top < br.bottom;
    });
    o.cellH = Math.round(cells()[0].getBoundingClientRect().height);
    // the grid takes the row, with its label ABOVE it — it was stranded in the
    // 60px label gutter beside the cells
    const gl = card().querySelector('.v2-gwper > label');
    const gg = card().querySelector('.v2-gwpergrid');
    o.gridFullWidth = !!(gl && gg) &&
      gl.getBoundingClientRect().bottom <= gg.getBoundingClientRect().top + 1 &&
      gg.getBoundingClientRect().width > pr2.width * 0.8;
    // ONE line of prose, not two paragraphs saying the same thing
    o.onePara = pop.querySelectorAll('.v2-genmodel').length === 0 &&
                pop.querySelectorAll('.v2-gwsays').length === 1;
    o.saysNames = /Plays the changes/.test((pop.querySelector('.v2-gwsays') || {}).textContent || '');
    // CAPTURE THE BUTTON ONCE and press it twice — which is what a finger
    // does. Re-querying between presses hides the real bug: the panel's own
    // sync rewrote the grid on every commit, so the second press landed on a
    // detached node and two taps moved the number by one. A probe that
    // re-queries passes either way (the poison proved it).
    const up = cells()[1].querySelector('.ambient-step-up');
    up.click(); await wait(150); up.click(); await wait(250);
    o.afterUp = JSON.stringify((L().part.ground || {}).per || null);
    o.buttonSurvives = document.contains(up);
    const dn = cells()[1].querySelector('.ambient-step-dn');
    dn.click(); await wait(250);
    o.stored = JSON.stringify((L().part.ground || {}).per || null);
    // …and it can come DOWN, which is the whole complaint
    o.goesDown = o.afterUp === '{"1":5}' && o.stored === '{"1":4}';
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
    // ✓ DONE KEEPS IT…
    card().querySelector('.v2-gwdone').click(); await wait(300);
    o.closed = !card().classList.contains('v2-gwopen');
    o.doneKeeps = L().part.rhythm.kind === 'ground';
    o.face = (document.querySelector('.v2-gwface') || {}).textContent || '';
    // …and ✕ CANCEL puts back exactly what was there
    const beforeOpen = JSON.stringify(L().part);
    card().querySelector('.v2-gwbtn').click(); await wait(400);
    const up2 = document.querySelector('.v2-layer .v2-gwcell .ambient-step-up');
    if (up2) up2.click();
    await wait(250);
    o.draftMoved = JSON.stringify(L().part) !== beforeOpen;
    card().querySelector('.v2-gwcancel').click(); await wait(350);
    o.cancelRestores = JSON.stringify(L().part) === beforeOpen &&
      !card().classList.contains('v2-gwopen');
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
    gwRun.door && gwRun.onScreen && gwRun.rhythm === 'ground' && gwRun.mat === 'ground' &&
    gwRun.holds && gwRun.onsets === 4 && gwRun.onTheChanges && gwRun.inChord &&
    gwRun.threeEach && gwRun.cells === 4 && gwRun.stored === '{"1":4}' &&
    gwRun.onlyThatChange && gwRun.cellMarked && gwRun.slipSpreads && gwRun.slipPruned &&
    gwRun.noUseButton && gwRun.adoptedOnOpen && gwRun.hasSteppers && gwRun.goesDown &&
    gwRun.stableAcrossPreviews && gwRun.buttonSurvives && gwRun.doneKeeps &&
    gwRun.draftMoved && gwRun.cancelRestores &&
    gwRun.closed && /in use/.test(gwRun.face),
    JSON.stringify(gwRun));

  ok('⛰ the Groundwork panel is legible — one-line cells, no inner scroll, one line of prose',
    gwRun.cellOneLine && gwRun.popFits && gwRun.gridFullWidth && gwRun.onePara &&
    gwRun.saysNames && gwRun.cellH <= 60,
    JSON.stringify({ popH: gwRun.popH, cellH: gwRun.cellH, popFits: gwRun.popFits,
      cellOneLine: gwRun.cellOneLine, gridFullWidth: gwRun.gridFullWidth,
      onePara: gwRun.onePara, saysNames: gwRun.saysNames }));

  // ⚙ SHAPE… — the four Generated shapes and the knobs that decide what each
  // one produces, in ONE panel. Four buttons in the row put every choice on
  // screen and left nowhere for the parameters, which sat three tabs away in
  // Rhythm, Pattern and Pitch.
  const genRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    card().querySelector('.v2-genbtn').click(); await wait(320);
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
    // …and the OTHER copy of that field agrees, or the two drift
    o.copies = [...document.querySelectorAll('.v2-layer .v2-f[data-f="part.pitch.span"]')]
      .map((x) => x.value).join(',');
    o.noDrift = new Set(o.copies.split(',')).size === 1;
    // the card still says which shape is in force WITHOUT opening the panel
    card().querySelector('.v2-shapepop .v2-genclose').click(); await wait(240);
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
    return o;
  });
  ok('⚙ Shape… holds the four shapes AND the knobs that shape them, in one panel',
    genRun.rowShapes === 0 && genRun.onScreen && genRun.shapes === 4 &&
    genRun.openAfterChoice && genRun.kindAfter === 'walk' && genRun.knobsFollow &&
    genRun.committed && genRun.stillOpen && genRun.noDrift && genRun.closed &&
    /Roll/.test(genRun.doorNames) && genRun.oneNewTake === 1 && genRun.onePopPrev === 1,
    JSON.stringify(genRun));

  // ⚇ MIXED — the fourth Generated door: chords AND single notes from one
  // part. The other three each commit to one texture (Sustained is always a
  // chord, Arpeggio and Roll always one note at a time), so "both" could only
  // be hand-built on the knobs.
  const mixRun = await page.evaluate(async () => { try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    card.querySelector('.v2-genbtn').click(); await wait(300);
    const btn = document.querySelector('.v2-layer .v2-shapepop .v2-mkpart[data-mk="mixed"]');
    o.door = !!btn;
    o.sub = btn ? (btn.querySelector('.v2-matsub') || {}).textContent : '';
    if (btn) btn.click();
    await wait(450);
    const gcM = document.querySelector('.v2-layer .v2-shapepop .v2-genclose');
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
    return o;
  } catch (e) { return { err: String(e && e.message) }; }
  });
  ok('⚇ Mixed makes chords AND single notes, and the balance moves them',
    mixRun.door && /chords and single/.test(mixRun.sub) && mixRun.kind === 'mixed' &&
    mixRun.mat === 'mixed' && mixRun.both && mixRun.allSingle && mixRun.allChords &&
    mixRun.deterministic && mixRun.hasTab && mixRun.hasControl && mixRun.gatedOff,
    JSON.stringify(mixRun));

  // WHAT IT WILL GENERATE, IN WORDS. The hint read `euclid 5 of 8 · walk ·
  // take 15` — every term correct, and no answer to "what is this going to
  // generate", reported as the whole thing being opaque.
  const saysRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    o.locked = await say("L().part.kind='recorded';L().part.made='take';" +
      "L().part.notes=[{t:0,midi:60,dur:0.2},{t:0.5,midi:64,dur:0.2}]");
    // NO JARGON: the shapes' internal names must not reach the reader. `walk`
    // and `euclid` are field values, not English.
    const jargon = /\b(euclid|walk|series|stack|anchor|chance|pulse ×|lenRatio)\b/;
    o.noJargon = !jargon.test(o.roll) && !jargon.test(o.pad) && !jargon.test(o.arp);
    // it says the two things a single drawing cannot show
    o.saysReRolled = /Re-rolled every cycle/.test(o.roll) && /take \d/.test(o.roll);
    o.saysExact = /plays these notes|Plays exactly these notes/.test(o.locked);
    // …and never both at once
    o.notBoth = !(/Re-rolled/.test(o.locked) && /Plays exactly/.test(o.locked));
    o.saysCounts = /5 hits/.test(o.roll) && /over 8 steps/.test(o.roll) &&
      /over 4 bars/.test(o.roll);
    o.saysPitch = /wandering up to 3 notes/.test(o.roll) && /3 notes of the chord/.test(o.pad) &&
      /sweeping the chord up/.test(o.arp);
    // THE SHAPE PHRASE — what KIND of content this is, which is the question
    // ("is Roll a run of notes? a sustained chord? several chords?"). The
    // parameter text above passes with or without it, which is why both
    // poisons went green until this was added.
    o.shapes = /a run of single notes/.test(o.roll) && /one held chord of 3 notes/.test(o.pad) &&
      /the chord, one note at a time/.test(o.arp);
    // the long form must WRAP inside the sheet, never clip (UI rule 2)
    const card = document.querySelector('.v2-layer');
    card.querySelector('.v2-gototab[data-goto="Content"]').click(); await wait(320);
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
    const gb = cardS.querySelector('.v2-genbtn'); if (gb) gb.click();
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
    o.everyDoorExplains = o.subs.length >= 7 &&
      o.subs.every((x) => x.sub.length > 3 && x.vis && !x.clipped);
    const gc3 = document.querySelector('.v2-layer .v2-shapepop .v2-genclose'); if (gc3) gc3.click();
    await wait(200);
    const ml = document.querySelector('.v2-matmodel');
    o.modelStated = !!ml && /RHYTHM/.test(ml.textContent) && /PITCH RULE/.test(ml.textContent) &&
      ml.getBoundingClientRect().height > 0;
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
    saysRun.saysCounts && saysRun.saysPitch && saysRun.shapes &&
    saysRun.everyDoorExplains && saysRun.modelStated && saysRun.wraps,
    JSON.stringify(saysRun));

  // 🎲 ROLL MIRRORS THE PART, AND A PRESS ON THE LIT CHIP BUILDS NOTHING.
  // It rolled its own length, so a record filed under a 5-bar part came back
  // 1 bar and then repeated five times under it; and the already-in-this-mode
  // guard keyed on the STAMP, so a chip lit by INFERENCE (a walked line IS a
  // roll) still rebuilt and threw the content away.
  const rollRun2 = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const gt = card.querySelector('.v2-gototab[data-goto="Content"]');
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
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
        tab: x.getAttribute('data-ftab') }));
    };
    const ghost = await type('ghost');
    o.exact = ghost.length === 1 && ghost[0].lab === 'Ghosts' &&
      ghost[0].grp === 'Shape' && ghost[0].tab === 'Variance';
    // THE CATEGORY WORD reaches the whole family across sheets — the question
    // this exists for. Asserted as SHEET COVERAGE, not a count: a number would
    // pin today's roster and break the next time a control is added.
    const fam = await type('variance');
    const sheets = new Set(fam.map((x) => x.grp));
    o.famSheets = [...sheets].sort().join(',');
    o.famSpans = sheets.has('Content') && sheets.has('Pitch') && sheets.has('Shape');
    o.famHasVariance = fam.some((x) => x.tab === 'Variance');
    // a miss says so rather than showing an empty box
    await type('zzzqq');
    o.saysNone = /Nothing matches/.test((card.querySelector('.v2-findnone') || {}).textContent || '');
    // TYPING MUST NOT RE-RENDER THE CARD — that replaces the input under the
    // finger and takes the caret with it (the documented Humanize-drag bug)
    await type('vary');
    o.inputSurvives = document.contains(inp) && inp.value === 'vary';
    // a hit NAVIGATES to the one home, and marks the row it sent you to
    const hit = [...card.querySelectorAll('.v2-findhit')].find((x) => x.getAttribute('data-flab') === 'Vary');
    o.hitFound = !!hit;
    if (hit) hit.click();
    await wait(500);
    const pop = document.querySelector('.v2-pop');
    o.opened = pop ? pop.getAttribute('aria-label') : null;
    const on = document.querySelector('.v2-pop-tabs [data-tab].on');
    o.tab = on ? on.getAttribute('data-tab') : null;
    o.marked = document.querySelectorAll('.v2-findmark').length === 1;
    o.cleared = card.querySelector('.v2-findin').value === '' &&
      !card.querySelector('.v2-findres').classList.contains('on');
    await wait(200);
    // ONE wrap — the card's own embedded editor. It was "none", back when the
    // sheet was a modal you could close; the finder must still never mint a
    // second one.
    o.clean = document.querySelectorAll('.v2-pop-wrap').length === 1;
    return o;
  });
  ok('🔍 Find a control indexes the whole card and navigates to the one home',
    findRun.present && findRun.fontPx >= 16 && findRun.fits && findRun.exact &&
    findRun.famSpans && findRun.famHasVariance && findRun.saysNone &&
    findRun.inputSurvives && findRun.hitFound && findRun.opened === 'Content' &&
    findRun.tab === 'Pattern' && findRun.marked && findRun.cleared && findRun.clean,
    JSON.stringify(findRun));

  // ▶ PREVIEW AUDITIONS THE RECORD ON THE CARD. With per-part content on, the
  // emitter swaps in whichever part is SOUNDING — right for playback, wrong
  // for an audition, because the stopped clock resolves to part 0 while the
  // card is editing the part the strip selected. Before the edit pin, seeding
  // changed the stored rules every press and left the preview byte-identical.
  const ppEditRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const svPart = JSON.stringify(L().part);
    const h = document.getElementById('bloom-v2-layers');
    L().part.kind = 'recorded';
    L().part.notes = [{ t: 0, midi: 60, dur: 0.1 }, { t: 0.5, midi: 64, dur: 0.1 }];
    E.getCfg();
    if (h) h._sig = ''; window._v2.render(E); await wait(250);
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    card.querySelector('.v2-gototab[data-goto="Content"]').click(); await wait(300);
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
    /Roll/.test(inferRun.legacy.on) && /Roll · WRITTEN DOWN/.test(inferRun.legacy.hint) &&
    /Arpeggio/.test(inferRun.hand.on) && /one note at a time|sweeping the chord/.test(inferRun.hand.hint) &&
    inferRun.lockMark === 'none' && inferRun.liveMark === 'none' &&
    /Unlock/.test(inferRun.lockCap) && /Lock this take/.test(inferRun.liveCap),
    JSON.stringify(inferRun).slice(0, 240));

  // ONE AXIS, ONE PAIR OF WORDS, ONE CONTROL. The card said the same thing
  // three ways — `kind: live/recorded` inside, a Source select offering
  // "Generated / Fixed", and "Written / Generated" over the Material clusters
  // — so "Generated" named both a cluster and a state and "Fixed"/"Written"
  // named one state twice ("the nature of the Material still feels opaque").
  // A part is GENERATED or WRITTEN; 🔒 Lock is the transition; the Source
  // select is gone (it was the destructive door — it wrote the field and
  // captured nothing, so a generating part became an EMPTY written one).
  const vocab = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    // WRITTEN, from a rolled take
    window._v2.capture(E, L()); E.getCfg(); await show();
    o.lockHint = hint(); o.lockCap = cap();
    // WRITTEN, by hand — the button names the way back in ITS words
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
    try { L().part = JSON.parse(svPart); E.getCfg(); await show(); } catch (e) {}
    return o;
  });
  ok('a part is GENERATED or WRITTEN — one pair of words, and 🔒 Lock is the only door between them',
    vocab.selects === 0 && vocab.saysFixed === 0 &&
    /GENERATED/.test(vocab.liveHint) && /WRITTEN/.test(vocab.lockHint) &&
    /WRITTEN/.test(vocab.handHint) &&
    /Lock this take/.test(vocab.liveCap) && /Unlock/.test(vocab.lockCap) &&
    /Generate instead/.test(vocab.handCap),
    JSON.stringify(vocab).slice(0, 300));

  // 🎲 NEW TAKE REACHES THE EAR. Reported as "it's playing the old take after
  // pressing New take": the press rolls the take and redraws, but audio for
  // this layer was already SCHEDULED — a running preview had a whole cycle in
  // flight, and while the transport runs there is a lookahead — so the old
  // take kept sounding against a drawing that had moved. The press still never
  // STARTS audio; it retracts the audio it superseded, and a preview that is
  // already playing follows it.
  const takeEarRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
      card().querySelector('.v2-newtake').click(); await wait(700);
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

  // THE ROLL LIGHTS UP AS IT PLAYS, and RING OUT is the door for the chord
  // choke. "It sounds like some notes may be getting cut off" — measured, with
  // a progression on: 3 of 4 notes clamped, 1200ms → 738 / 238 / 738. That is
  // `_ambNoteChoke` and it is deliberate (a note is released by the next change
  // so a pad does not ring three chords later), but its opt-out is a v1 field
  // with a v1 control, so on this card the behaviour had no door — and the
  // drawing showed the FULL length while the ear heard the cut one.
  const playRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
                  drawnMs: Math.round((hits[i].w / geo.w) * geo.cyc * 1000) };
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
  ok('Ring out is the door for the chord choke — off cuts the note, on lets it ring',
    playRun.door && /released by the next change/.test(playRun.faceOff) &&
    playRun.ring === 1 && /through the changes/.test(playRun.faceOn) &&
    playRun.chokeOff && playRun.chokeOff.got < playRun.chokeOff.req - 1 &&
    playRun.chokeOn && playRun.chokeOn.got === playRun.chokeOn.req &&
    // …AND THE PICTURE SAYS SO: the widest drawn note is the CHOKED length,
    // not the requested one (the poison that draws the full length passes
    // every other clause).
    playRun.drawn && playRun.drawn.cut < playRun.drawn.raw - 30 &&
    Math.abs(playRun.drawn.drawnMs - playRun.drawn.cut) < 90,
    JSON.stringify({ off: playRun.chokeOff, on: playRun.chokeOn, door: playRun.door,
                     drawn: playRun.drawn }));

  // THE DRAWING HAS A PITCH AXIS — a keyboard down the left and one SEMITONE
  // per row ("the content visualization needs a Y axis, use piano graphic, so
  // it's clear what note each event is"). It was a continuous squeeze of
  // whatever range the take happened to span: you could see that one note was
  // higher than another and not which note either of them was.
  const rollRun3 = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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

  // EXACTLY ONE MATERIAL DOOR IS LIT, AND IT TRACKS THE MATERIAL. Reported as
  // "clicking through the Written/Generated modes is buggy; options stay
  // highlighted, Composed gets stuck on". Two causes, both measured: the lit
  // map still named the four shape buttons, which MOVED INTO the Shape panel,
  // so a generated part lit NOTHING in the row (mat 'ground', lit []); and an
  // open compose session wrote `.on` — the class that means "this material
  // made the notes" — onto ✎ Composed, so it stayed lit on a part Groundwork
  // had made. One class, one meaning: the session has its own mark.
  const doorRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const svPart = JSON.stringify(L().part);
    const card = () => document.querySelector('.v2-layer');
    const show = async () => { const h = document.getElementById('bloom-v2-layers');
      if (h) h._sig = ''; window._v2.render(E); await wait(240);
      card().classList.remove('collapsed'); };
    const lit = () => ['v2-compose', 'v2-adopt', 'v2-genbtn', 'v2-gwbtn']
      .filter((c) => { const e = card().querySelector('.' + c);
        return e && e.classList.contains('on'); });
    const o = {};
    // a default generated card: the shape door owns hand-built shapes too
    L().part.kind = 'live'; delete L().part.mat; delete L().part.made;
    L().part.rhythm = { kind: 'euclid', steps: 16, n: 3 };
    L().part.pitch = { kind: 'chord', voices: 3 };
    E.getCfg(); await show();
    o.dflt = lit();
    // …Groundwork, through its own door
    card().querySelector('.v2-gwbtn').click(); await wait(500);
    o.ground = lit(); o.mat = L().part.mat;
    const dn = card().querySelector('.v2-gwdone'); if (dn) dn.click(); await wait(350);
    o.groundAfter = lit();
    // …and a compose session must not claim the material
    card().querySelector('.v2-compose').click(); await wait(800);
    o.composing = card().classList.contains('v2-composing');
    o.whileComposing = lit();
    o.sessMark = card().querySelector('.v2-compose').classList.contains('v2-sess');
    const gc = card().querySelector('.v2-gacts .v2-gcancel'); if (gc) gc.click(); await wait(600);
    o.afterCancel = lit();
    try { L().part = JSON.parse(svPart); E.getCfg(); await show(); } catch (e) {}
    return o;
  });
  ok('exactly one Material door is lit, and it names the material — a compose session is not one',
    doorRun.dflt.join() === 'v2-genbtn' && doorRun.mat === 'ground' &&
    doorRun.ground.join() === 'v2-gwbtn' && doorRun.groundAfter.join() === 'v2-gwbtn' &&
    doorRun.composing && doorRun.sessMark &&
    doorRun.whileComposing.join() === 'v2-gwbtn' &&
    doorRun.afterCancel.join() === 'v2-gwbtn',
    JSON.stringify(doorRun));

  // ---- THE INSTRUMENT SHEET IS TWO TABS AND TWO FOLDS ---------------------
  // It was five tabs — Tone type, Tone, Register, Tone cycle, Envelope — which
  // is five presses to find out what the sheet holds. The type belongs WITH the
  // tone (it is the question above it, not a peer), the envelope is how that
  // voice behaves rather than a peer of it, and Register is the one control you
  // reach for while listening, so it sits in the head.
  const instShape = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const head = document.querySelector('.v2-pop-head');
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
  await new Promise((r) => setTimeout(r, 200));

  // ---- REGISTER MOVES THE PART, RECORDED OR NOT ---------------------------
  // It is read by the LIVE pitch path only, so on a fixed part it was a control
  // on screen that moved nothing — reported as "register should shift the part
  // up or down an octave". Measured at playNote, because a config value that
  // nothing plays is exactly the failure being tested for.
  const regRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
    const card = () => document.querySelector('.v2-layer');
    // THE SUMMARY MOVED WITH THE GRID: it was on each group's button, and the
    // buttons came down with the sheet — it is the head's own `.v2-grpsum`
    // for the section you are in (and each tab's tooltip).
    const sum = () => {
      const t2 = [...card().querySelectorAll('.v2-gototab')]
        .find((x) => x.getAttribute('data-goto') === 'Instrument');
      if (t2 && !t2.classList.contains('on')) t2.click();
      const el = card().querySelector('.v2-pop-head .v2-grpsum[data-grp="Instrument"]');
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
  await new Promise((r) => setTimeout(r, 250));
  const takeRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, L = () => (E.getCfg().layers || [])[0];
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
    document.querySelector('.v2-layer .v2-newtake').click();
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, o = {};
    const L = () => (E.getCfg().layers || [])[0];
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
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
      /v2-vizlab/.test(ov.previousElementSibling.className);
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
  ok('the note editor offers length, position, volume, envelope and portamento',
    noteEdit.modal && ['Note', 'Position', 'Length', 'Volume', 'Attack', 'Decay', 'Sustain', 'Release', 'Portamento']
      .every((r2) => (noteEdit.rows || []).indexOf(r2) >= 0), JSON.stringify(noteEdit.rows));
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
  // This is the first: the euclid generator's output, made editable — the same
  // relationship v1's `euclidPattern` override has to its own formula.
  //
  // IT MUST BE THE EUCLID OPTION'S OWN SURFACE, not a separate dropdown entry.
  // Shipped as a fourth entry ("Drawn"), the grid was invisible on a default
  // card AND on a Euclid card — reported immediately as "where is the layer
  // grid". A door you have to already know about is not a door.
  await page.evaluate(() => {
    const L0 = (_masterEng.getCfg().layers || [])[0];
    L0.part.kind = 'live'; _masterEng.getCfg(); window._v2.render(_masterEng);
    const r = document.querySelector('.v2-layer [data-f="part.rhythm.kind"]');
    r.value = 'euclid'; r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const gridOf = () => page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const g0 = card.querySelector('.v2-cells');
    const grp0 = g0 && g0.closest('.ambient-grp');
    if (grp0) grp0.classList.add('open');
    const g = card.querySelector('.v2-cells');
    const p = (_masterEng.getCfg().layers || [])[0].part;
    const row = card.querySelector('.v2-cellrow');
    if (!g) return { missing: true };
    const c = g.children[0].getBoundingClientRect();
    return {
      shown: !!row && getComputedStyle(row).display !== 'none',
      dom: [...g.children].map((x) => (x.classList.contains('on') ? 1 : 0)).join(''),
      // What the ENGINE will play. A cell tap toggles one cell's class in place
      // (a rebuild would detach the cell under the finger), so the DOM alone
      // cannot tell a correct edit from one that silently rewrote the rest of
      // the row — the two have to be compared.
      model: (p.rhythm.kind === 'drawn' ? (p.rhythm.cells || [])
              : window._v2.euclidCells(p.rhythm.pulses, p.rhythm.steps, p.rhythm.rotate)).join(''),
      kind: p.rhythm.kind,
      selValue: (card.querySelector('[data-f="part.rhythm.kind"]') || {}).value,
      opts: [...card.querySelectorAll('[data-f="part.rhythm.kind"] option')].map((o) => o.value).join(','),
      cells: g.children.length, steps: p.rhythm.steps,
      cellH: Math.round(c.height), cellW: Math.round(c.width),
      regen: !!card.querySelector('.v2-regen') && getComputedStyle(card.querySelector('.v2-regen')).display !== 'none',
      hint: (card.querySelector('.v2-cellhint') || {}).textContent || '',
    };
  });
  let g = await gridOf();
  ok('the grid is visible on EUCLID, with no extra mode to find',
    g.shown && g.opts === 'pulse,euclid,chance', JSON.stringify(g));
  // Generated, not blank: the knobs ARE the pattern until you touch a cell.
  ok('euclid draws its generated pattern (not blank)', /1/.test(g.dom) && g.kind === 'euclid', JSON.stringify(g));
  ok('the grid meets the touch floor', g.cellH >= 28, 'cell ' + g.cellW + 'x' + g.cellH);
  ok('↻ is hidden until there is an edit to undo', !g.regen, JSON.stringify(g));
  ok('the grid says the knobs own it', /tap a cell to edit/.test(g.hint), g.hint);

  // THE FIRST TAP SNAPSHOTS the generated pattern and becomes the override —
  // without the snapshot the tap would start from an empty grid and read as
  // erasing the pattern.
  const before = g.dom;
  e = await tap('.v2-layer .v2-cell:nth-child(2)');
  g = await gridOf();
  const flipped = before.split('').filter((c, i) => c !== g.model[i]).length;
  // Compared against the MODEL, not the DOM: an in-place toggle only restyles
  // the cell it touched, so a snapshot that started from an empty grid would
  // look right on screen while the engine plays one lone note.
  ok('tapping a cell edits exactly it, keeping the generated pattern',
    !e && flipped === 1 && g.dom === g.model, e || (before + ' -> model ' + g.model + ' dom ' + g.dom));
  ok('the first edit becomes an override, select still reads euclid',
    g.kind === 'drawn' && g.selValue === 'euclid', JSON.stringify(g));
  ok('↻ appears once edited, and the hint says the knobs will redraw it',
    g.regen && /edited/.test(g.hint), JSON.stringify(g));

  // A STRUCTURAL REBUILD must not lose the edit or mislabel the rhythm. This is
  // where 'drawn' having no option bites: the rebuilt markup falls back to the
  // FIRST option, so the card would claim "Pulse" over an edited euclid grid.
  await tap('.v2-layer .ambient-toggle');
  await tap('.v2-layer .ambient-toggle');
  g = await gridOf();
  ok('an edited pattern survives a card rebuild, still labelled Pattern',
    g.kind === 'drawn' && g.selValue === 'euclid' && g.shown && g.dom === g.model, JSON.stringify(g));

  // ↻ is the way BACK — the only one, which is why it is a control and not a mode.
  e = await tap('.v2-layer .v2-regen');
  g = await gridOf();
  ok('↻ restores the generated pattern', !e && g.kind === 'euclid' && g.dom === before, e || JSON.stringify(g));

  await page.evaluate(() => {
    const el = document.querySelector('.v2-layer [data-f="part.rhythm.pulses"]');
    el.value = '5'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  g = await gridOf();
  ok('Pulses redraws the grid live', g.dom.split('1').length - 1 === 5, JSON.stringify(g));

  await page.evaluate(() => {
    const el = document.querySelector('.v2-layer [data-f="part.rhythm.steps"]');
    el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  g = await gridOf();
  ok('Steps resizes the grid (model and DOM agree)',
    g.steps === 12 && g.cells === 12 && g.dom.length === 12, JSON.stringify(g));

  // An edit then a knob nudge: the knob wins and says so (v1's contract).
  await tap('.v2-layer .v2-cell:nth-child(1)');
  await page.evaluate(() => {
    const el = document.querySelector('.v2-layer [data-f="part.rhythm.rotate"]');
    el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  g = await gridOf();
  ok('a knob nudge takes an edited grid back to the formula',
    g.kind === 'euclid' && !g.regen, JSON.stringify(g));

  // ---- DOOR 3: A PHRASE FROM THE COMPOSE GRID ------------------------------
  // The second surface the user named. Phrases are composed in a layer's ✎ Grid
  // and saved to `savedSequences`; v2 needs a reader, not an editor of its own.
  // RESTATED with the merge: ♪ Phrase used to open a PICKER over the same bank
  // the Phrases tab draws — two surfaces for one list, called two different
  // things ("don't think we need both Saved and Phrases"). The door NAVIGATES
  // now, exactly as 🔍 Find a control does, and the tab is the one home.
  const bankTab = () => page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const row = c && c.querySelector('.v2-pop-pane .v2-bankrow');
    if (!row || !row.getBoundingClientRect().height) return null;
    return { tab: (c.querySelector('.v2-pop-tab.on') || {}).getAttribute('data-tab'),
             items: [...row.querySelectorAll('.v2-bankit .v2-bkload')].map((b) => b.textContent.trim()),
             empty: (row.querySelector('.ambient-hint') || {}).textContent || '',
             pickers: document.querySelectorAll('.ambient-addpop-ov').length };
  });
  e = await tap('.v2-layer .v2-adopt');
  await new Promise((r) => setTimeout(r, 400));
  let pop = await bankTab();
  // An empty bank is not an error — it is a "here is where these come from".
  ok('the Phrase door opens the one phrase list — no second picker',
    !e && !!pop && pop.tab === 'Phrases' && pop.pickers === 0, e || JSON.stringify(pop));
  ok('an empty bank says where phrases come from',
    pop && !pop.items.length && /Save this take|compose/.test(pop.empty), JSON.stringify(pop));

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
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => { document.querySelector('.v2-layer').classList.remove('collapsed'); });
  await tap('.v2-layer .v2-adopt');
  await new Promise((r) => setTimeout(r, 400));
  pop = await bankTab();
  ok('the bank lists the phrase with its length',
    pop && pop.items.some((b) => /gateRiff/.test(b)), JSON.stringify(pop));
  const chosen = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.v2-layer .v2-pop-pane .v2-bankit .v2-bkload')]
      .find((x) => /gateRiff/.test(x.textContent));
    if (!b) return null; b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (chosen) { await page.touchscreen.tap(chosen.x, chosen.y); await new Promise((r) => setTimeout(r, 500)); }
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
  await new Promise((r) => setTimeout(r, 300));
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
  // BACK TO THE MATERIAL TAB FIRST — the Phrase door above navigated to
  // Phrases, and a tab shows only its own rows, so ✎ Composed is off screen
  // until we come back (it measured `zero-size`, which is the tell).
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.v2-layer .v2-pop-tab')]
      .find((x) => x.getAttribute('data-tab') === 'Material');
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  e = await tap('.v2-layer .v2-compose');
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
  await new Promise((r) => setTimeout(r, 250));
  await tap('.v2-layer .v2-compose');
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
    await new Promise((r) => setTimeout(r, 300));
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
    await new Promise((r) => setTimeout(r, 200));
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
    await new Promise((r) => setTimeout(r, 250)); open();
    out.on = rows();
    out.flag = E.getCfg().layers[0].tg.on;
    out.cells = card().querySelectorAll('.v2-tgcell').length;
    card().querySelector('.v2-tgcell[data-ci="1"]').click();
    out.pattern = E.getCfg().layers[0].tg.pattern.join('');
    const ss = card().querySelector('[data-f="tg.steps"]');
    ss.value = 8; ss.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250)); open();
    const tg = E.getCfg().layers[0].tg;
    out.resized = tg.steps + ':' + tg.pattern.length + ':' + card().querySelectorAll('.v2-tgcell').length;
    card().querySelector('.v2-tgtoggle').click();
    await new Promise((r) => setTimeout(r, 250)); open();
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
    await new Promise((r) => setTimeout(r, 250)); open();
    out.on = pans();
    const ms = card().querySelector('[data-f="spat.mode"]');
    ms.value = 'sweep'; ms.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
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
    document.querySelector('.v2-note[data-ci="' + k + '"]').click();
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
  ok('tapping raises the degree and the label follows',
    drawn.degrees === '1,3,1,1' && drawn.label === 'G4', JSON.stringify(drawn));
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
    await new Promise((r) => setTimeout(r, 250));
    out.wetOn = E.getCfg().layers[0].wetOnly;
    card().querySelector('.v2-wettoggle').click();
    await new Promise((r) => setTimeout(r, 250));
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
    _ambStartGenerator(E); await new Promise((r) => setTimeout(r, 2400));
    let pk = 0;
    for (let i = 0; i < 30; i++) { const v = an.getValue();
      for (let j = 0; j < v.length; j++) pk = Math.max(pk, Math.abs(v[j]));
      await new Promise((r) => setTimeout(r, 25)); }
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
    await new Promise((r) => setTimeout(r, 120));
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
    await new Promise((r) => setTimeout(r, 160));
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
    await new Promise((r) => setTimeout(r, 150));
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
    await new Promise((r) => setTimeout(r, 160));
    const c = document.querySelector('.v2-layer');
    c.classList.remove('collapsed');
    c.querySelectorAll('.ambient-grp').forEach((g) => g.classList.add('open'));
    try { _ambSyncControls(E); } catch (e) {}
    try { _ambSyncSynthKit(E); } catch (e) { out0err = e.message; }
    await new Promise((r) => setTimeout(r, 120));
    const ed = c.querySelector('.ambient-synthkit');
    const out = { present: !!ed, cardKey: (typeof _ambCardKey === 'function') ? _ambCardKey(c) : null,
                  syncErr: typeof out0err === 'undefined' ? null : out0err };
    if (!ed) return out;
    out.visible = ed.getBoundingClientRect().height > 0;
    out.tabs = ed.querySelectorAll('.ambient-sk-role').length;
    // driven through V1's OWN delegated handlers
    const tab = ed.querySelectorAll('.ambient-sk-role')[2];
    if (tab) { tab.click(); await new Promise((r) => setTimeout(r, 120)); }
    out.active = ed.getAttribute('data-active');
    const kitOf = () => { const k = E.getCfg().layers[0].synthKit; return (k && k.voices) ? JSON.stringify(k.voices[2]) : null; };
    const before = kitOf();
    const roll = ed.querySelector('.ambient-sk-roll');
    if (roll) { roll.click(); await new Promise((r) => setTimeout(r, 160)); }
    out.rolled = before !== kitOf() && kitOf() !== null;
    // a SAMPLE kit must hide it — the editor is for the generated kit only
    E.getCfg().layers[0].instrument.kit = 'tr808';
    E.getCfg(); window._v2.render(E);
    await new Promise((r) => setTimeout(r, 120));
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
  ok('twist bursts the line into packed runs',
    twm.plainN === 4 && twm.plainAt === '0,0.5,1,1.5' &&
    twm.twistN > twm.plainN && /^0,0\.12/.test(twm.twistAt), JSON.stringify(twm));
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
    if (add) { add.click(); await new Promise((r) => setTimeout(r, 150)); }
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

  // ---- the sweep's pool, Hold, and Max events ------------------------------
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
    L2.part.shape.maxEvents = 3; E.getCfg(); E._cfg = E.getCfg();
    out.capped = n();
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
  ok('Max events caps a cycle, keeping the earliest',
    pool.uncapped === 8 && pool.capped === 3, JSON.stringify(pool));

  // ---- rhythm vary ---------------------------------------------------------
  // v1's rule verbatim, from all four of its euclid renderers: a seed hit is
  // dropped at 0.40× the setting, a silent slot added at 0.22×. Asymmetric on
  // purpose — it thins harder than it thickens, which is what keeps a varied
  // pattern recognisable instead of filling in.
  const vary = await page.evaluate(async () => {
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
    vary.steady === '1357|1357|1357|1357|1357|1357' && vary.afterPrune === vary.steady,
    JSON.stringify(vary));
  // Distinct per cycle, measured on the onset POSITIONS: the same count can hide
  // a pattern that never moved. (Counts alone misled once here — a 2,5,2,5
  // alternation over four cycles read as a seeding defect and was not.)
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
    await new Promise((r) => setTimeout(r, 140));
    out.afterMode = JSON.stringify(E.getCfg().layers[0].keyOv);
    const rt = card.querySelector('.amb-keyov-root[data-kokey="v2:' + id + '"]');
    if (rt) { rt.value = '9'; rt.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); }
    out.afterRoot = JSON.stringify(E.getCfg().layers[0].keyOv);
    E.getCfg(); E._cfg = E.getCfg();
    out.withOwnKey = cap();
    md.value = ''; md.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 140));
    E.getCfg(); E._cfg = E.getCfg();
    out.cleared = E.getCfg().layers[0].keyOv === undefined;
    out.backToInherit = cap();
    // …and v1's OWN card must still work — `_ambKeyOvHtml` was extracted FROM it.
    try {
      _ambAddExtra(E, 'motif'); _ambRebuildMaster();
      await new Promise((r) => setTimeout(r, 300));
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
        await new Promise((r) => setTimeout(r, 140));
        out.v1Stored = JSON.stringify((_ambLayerByKey(E, kk) || {}).keyOv);
        m1.value = ''; m1.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 140));
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
    await new Promise((r) => setTimeout(r, 150));
    const L = E.getCfg().layers[0];
    out.stored = JSON.stringify(L.mod && L.mod.vcf);
    try { _ambSyncMods(E); } catch (e) { out.err = e.message; }
    await new Promise((r) => setTimeout(r, 200));
    const e2 = E.mod && E.mod['v2:' + id];
    out.chainSrc = !!(e2 && e2.src);
    const sh = el('mod-vcf-shape');
    if (sh) { sh.value = 'triangle'; sh.dispatchEvent(new Event('change', { bubbles: true })); }
    out.shape = ((E.getCfg().layers[0].mod || {}).vcf || {}).shape;
    E.getCfg().layers[0].name = 'Rebuilt' + Math.floor(E.getCfg().layers[0].part.bars);
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 120));
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
    await new Promise((r) => setTimeout(r, 120));
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
    const wait = () => new Promise((r) => setTimeout(r, 120));
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
      // the pane is what a tab can grow; it is capped and scrolls, which is
      // what stops the card growing without limit
      paneH: (() => { const pn = c.querySelector('.v2-pop-pane');
        return pn ? Math.round(pn.getBoundingClientRect().height) : -1; })(),
      vh: window.innerHeight,
      // the card at rest must still SAY what is engaged — the summaries live
      // on the buttons now (the drum-solo rule: state that can vanish while
      // its widget keeps state gets reported as a bug)
      folded: btns.map((b2) => b2.getAttribute('data-v2grp') + '=' +
        (b2.querySelector('.v2-grpsum') || {}).textContent),
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
  ok('expanding shows the editor — six section tabs at a real touch size, no rows left behind',
    shape.gridBtns === shape.groups.length && shape.rowsShowing === 0,
    JSON.stringify({ btns: shape.gridBtns, rows: shape.rowsShowing }));
  // RESTATED with the embed: the card WAS a grid of buttons at rest, so half a
  // screen was the right bar for it; it is the editor itself now. The accretion
  // this catches is the same one — the pane is capped and SCROLLS rather than
  // growing without limit, so the card stays about one screen whatever a tab
  // holds.
  ok('an expanded card is about one screen, and the pane is capped (was 2873px)',
    shape.height <= shape.vh * 1.25 && shape.paneH <= shape.vh * 0.45,
    shape.height + 'px, pane ' + shape.paneH + 'px of ' + shape.vh);
  // THE ACCRETION CHECK, restated in the unit that now matters. It counted ROWS
  // because rows used to be what you saw; a group's rows live in a TABBED sheet
  // now and only one tab shows at a time, so the wall this catches is a wall of
  // TABS. Kept deliberately tight — 16 is about three wrapped rows of chips at
  // 390px, past which a chooser stops being scannable.
  ok('no group is a dump — no sheet exceeds 16 tabs',
    shape.widestTabs <= 16, shape.widestTabsName + ' of ' + JSON.stringify(shape.tabCounts));
  ok('every group button says what is engaged inside it',
    shape.folded.length === shape.groups.length && shape.folded.every((f) => f.split('=')[1].length > 0),
    JSON.stringify(shape.folded));
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
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    const d = document.querySelector('.v2-pop-pane .v2-discbtn[data-disc="env"]');
    if (d && !document.querySelector('.v2-layer').classList.contains('v2-so-env')) d.click();
  });
  await new Promise((r) => setTimeout(r, 200));
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
  await new Promise((r) => setTimeout(r, 150));
  let kn = await page.evaluate(() => {
    const L = _masterEng.getCfg().layers[0];
    const k = document.querySelector('.v2-pop-pane .ambient-ctrl:not(.v2-rowoff) .v2-knob');
    return { attack: L.instrument.attack, face: (k.querySelector('.v2-knob-val') || {}).textContent };
  });
  ok('a knob drag writes the config and the face follows',
    kn.attack > knob.v0 && String(kn.attack) === kn.face, JSON.stringify({ from: knob.v0, to: kn }));
  const kv1 = kn.attack;
  await page.touchscreen.tap(knob.x, knob.y);
  await new Promise((r) => setTimeout(r, 150));
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
  await new Promise((r) => setTimeout(r, 150));
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const hd0 = document.querySelector('.v2-pop-head');
    const cs0 = getComputedStyle(hd0);
    const inner = hd0.clientWidth - parseFloat(cs0.paddingLeft) - parseFloat(cs0.paddingRight);
    const r1 = rects.filter((r) => Math.round(r.top) === rowKeys[0]);
    o.row1Fill = +((Math.max(...r1.map((r) => r.right)) - Math.min(...r1.map((r) => r.left))) / inner).toFixed(2);
    o.fills = o.tabRows === 1 || o.row1Fill >= 0.9;
    o.clipped = tbs.filter((t) => t.scrollWidth > t.clientWidth + 1).length;
    o.tall = Math.min(...rects.map((r) => Math.round(r.height)));
    o.allSix = tbs.length === 6 && rects.every((r) => r.width > 0 && r.height > 0);
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
    const WANT = { Content: 'part.rhythm.steps', Pitch: 'part.pitch.kind',
                   Shape: 'part.shape.holdSteps', Mix: 'level', FX: 'delay.mix',
                   Instrument: 'instrument.voice' };
    let prev = document.querySelector('.v2-pop-wrap');
    for (const g of ['Content', 'Pitch', 'Shape', 'Mix', 'FX', 'Instrument']) {
      const bt = tabOf(g); if (bt) bt.click();
      await wait(240);
      const w = document.querySelector('.v2-pop-wrap');
      const pop = w && w.querySelector('.v2-pop');
      o.hops.push({ g, ok: !!w && w !== prev &&                       // a NEW sheet, not the old one
        !!pop && pop.getAttribute('aria-label') === g &&              // built by popOpen for THIS group
        !!w.querySelector('.v2-pop-pane [data-f="' + WANT[g] + '"]') && // and holding that group's rows
        w.querySelectorAll('.v2-pop-tab').length > 0 &&
        // …and the tab you pressed is the one now LIT
        ((w.querySelector('.v2-gototab.on') || {}).getAttribute('data-goto')) === g });
      prev = w;
    }
    o.oneSheet = document.querySelectorAll('.v2-pop-wrap').length;
    await wait(220);
    const card = document.querySelector('.v2-layer');
    o.groups = card.querySelectorAll('.ambient-grp[data-v2grp]').length;
    const hd = document.querySelector('.v2-pop-head');
    o.headOverflow = hd ? hd.scrollWidth - hd.clientWidth : 0;
    return o;
  });
  ok('the sheet header goes to any other section, without closing',
    nav.opts.join(',') === 'Instrument,Content,Pitch,Shape,Mix,FX' &&
    nav.start === 'Instrument' && nav.hops.every((x) => x.ok) && nav.oneSheet === 1,
    JSON.stringify(nav.hops.filter((x) => !x.ok)) + ' opts=' + nav.opts.length);
  ok('…and all six sections are visible at once — one or two rows they fill outright',
    nav.allSix && nav.tabRows >= 1 && nav.tabRows <= 2 && nav.equal && nav.fills &&
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
  await new Promise((r) => setTimeout(r, 300));
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
  await new Promise((r) => setTimeout(r, 300));
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const card = document.querySelector('.v2-layer');
    card.classList.remove('collapsed');
    // the button is in EVERY sheet, at a real size
    out.sized = [];
    for (const g of ['Instrument', 'Content', 'FX']) {
      [...card.querySelectorAll('.v2-gototab')].find((x) => x.getAttribute('data-goto') === g).click();
      await wait(150);
      const b2 = document.querySelector('.v2-pop-preview');
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
    await wait(250);
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

  await browser.close();
  console.log('\nUI LIFECYCLE: ' + (fail ? ('✗ ' + fail + ' failed, ' + pass + ' passed') : ('✓ all ' + pass + ' checks pass')) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('UI LIFECYCLE: harness error —', e.message); process.exit(1); });
