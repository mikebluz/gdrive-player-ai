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

  // ---- GROUP FOLD ---------------------------------------------------------
  // Every group starts CLOSED now, so a head tap OPENS first and folds second.
  const openBefore = (await state()).grpsOpen;
  await page.evaluate(() => {
    const h = document.querySelector('.v2-layer .ambient-grp-head');
    const g = h && h.closest('.ambient-grp');
    if (g) g.classList.remove('open');            // tap() would open it for us
  });
  await tap('.v2-layer .ambient-grp-head');
  s = await state();
  ok('group head unfolds its group', s.grpsOpen === openBefore + 1, JSON.stringify(s));
  await tap('.v2-layer .ambient-grp-head');
  s = await state();
  ok('group head folds it again', s.grpsOpen === openBefore, JSON.stringify(s));

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
  const regBefore = (await state()).register;
  await tap('.v2-layer .ambient-ctrl:has([data-f="instrument.register"]) .ambient-step-up');
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
    const vis = [...c.querySelectorAll('.ambient-ctrl')].filter((r) => r.style.display !== 'none')
      .map((r) => (r.querySelector('label') || {}).textContent);
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
    const el = document.querySelector('.v2-layer [data-f="part.kind"]');
    el.value = 'recorded'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 350));
  const emptyState = await page.evaluate(() => ({
    notes: ((_masterEng.getCfg().layers || [])[0].part.notes || []).length,
    hint: [...document.querySelectorAll('.v2-layer .ambient-hint')].some((h) => /Nothing recorded yet/.test(h.textContent)),
  }));
  ok('an empty recorded part explains itself', emptyState.notes === 0 && emptyState.hint, JSON.stringify(emptyState));
  e = await tap('.v2-layer .v2-capture');
  ok('Capture is reachable ON THE CARD', !e, e);
  const escaped = await page.evaluate(() => ((_masterEng.getCfg().layers || [])[0].part.notes || []).length);
  ok('the card button fills an empty recorded part', escaped > 0, 'notes=' + escaped);

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
    const el = document.querySelector('.v2-layer [data-f="part.kind"]');
    el.value = 'live'; el.dispatchEvent(new Event('input', { bubbles: true }));
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
  const popText = () => page.evaluate(() => {
    const o = document.querySelector('.ambient-addpop-ov'); if (!o) return null;
    return { title: (o.querySelector('.sm-title') || {}).textContent || '',
             btns: [...o.querySelectorAll('.addpop-btn')].map((b) => b.textContent.trim()),
             heads: [...o.querySelectorAll('.addpop-head')].map((b) => b.textContent.trim()) };
  });
  e = await tap('.v2-layer .v2-adopt');
  await new Promise((r) => setTimeout(r, 350));
  let pop = await popText();
  // An empty bank is not an error — it is a "here is where these come from".
  // A picker that opens on nothing and says nothing is the dead end this whole
  // slice exists to remove.
  ok('the phrase picker is reachable', !e && !!pop, e || 'no popover');
  ok('an empty bank says where phrases come from',
    pop && !pop.btns.length && pop.heads.some((h) => /✎ Grid/.test(h)), JSON.stringify(pop));
  await page.evaluate(() => document.querySelectorAll('.ambient-addpop-ov').forEach((o) => o.remove()));

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
  });
  await tap('.v2-layer .v2-adopt');
  await new Promise((r) => setTimeout(r, 350));
  pop = await popText();
  ok('the bank lists the phrase with its length',
    pop && pop.btns.some((b) => /gateRiff/.test(b) && /3 notes/.test(b) && /0\.5 bars/.test(b)),
    JSON.stringify(pop));
  const chosen = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((x) => /gateRiff/.test(x.textContent));
    if (!b) return null; const r = b.getBoundingClientRect();
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
    const gMix = grpOf('Mix'), gFx = grpOf('FX'), gSp = grpOf('Space');
    const out = {
      group: !!gMix && !!gFx && !!gSp,
      rows: rowsOf(gMix) + ' || ' + rowsOf(gSp) + ' || ' + rowsOf(gFx),
      mix: rowsOf(gMix), fx: rowsOf(gFx), space: rowsOf(gSp),
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
  ok('Mix, Space and FX are separate groups, each answering one question',
    fxState.group &&
    /Level/.test(fxState.mix) && /Filter/.test(fxState.mix) && /Resonance/.test(fxState.mix) &&
    /Reverb/.test(fxState.space) && /Bus/.test(fxState.space) && /Width/.test(fxState.space) &&
    /Delay/.test(fxState.fx) && /Drive/.test(fxState.fx) && /Chop/.test(fxState.fx) &&
    !/Delay/.test(fxState.mix) && !/Level/.test(fxState.fx) && !/Reverb/.test(fxState.mix),
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
  ok('a layer with its own key plays in it, and reverts on Inherit',
    kov.inherited === '60,62,64' && kov.withOwnKey === '69,71,73' &&
    kov.cleared && kov.backToInherit === '60,62,64', JSON.stringify(kov));

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
  ok('with no strum a chord is STRUCK — every note at the same instant',
    strum.struckT === '0,0,0,0' && strum.struckM === '60,62,64,65', JSON.stringify(strum));
  ok('strum spreads the chord across a fraction of the span',
    strum.strumT === '0,0.333,0.667,1' && strum.strumM === '60,62,64,65', JSON.stringify(strum));
  // v1's own `_ambStrumOrder` — fidelity 0 is low→high every time, higher wanders.
  ok('strum order wanders with fidelity, and only then',
    strum.wanderM !== '60,62,64,65' && strum.pruned, JSON.stringify(strum));

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
  ok('with no source it follows the area key, and says so',
    /Scale/.test(src.scaleLabel) && src.scalePitches === '261.6,293.7,329.6', JSON.stringify(src));
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
    const out = {
      groups: grps.map((g) => g.getAttribute('data-v2grp')),
      openOnExpand: grps.filter((g) => g.classList.contains('open')).map((g) => g.getAttribute('data-v2grp')),
      height: Math.round(c.getBoundingClientRect().height),
      // a folded group must still SAY what is engaged inside it
      folded: grps.filter((g) => !g.classList.contains('open'))
        .map((g) => g.getAttribute('data-v2grp') + '=' + g.querySelector('.v2-grpsum').textContent),
      unnamed: grps.filter((g) => !g.getAttribute('data-v2grp')).length,
    };
    // widest group, with EVERY group open — the wall test
    grps.forEach((g) => g.classList.add('open'));
    await wait();
    out.widest = Math.max(...grps.map((g) => vis(g).length));
    out.widestName = grps.map((g) => [g.getAttribute('data-v2grp'), vis(g).length])
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
  ok('the card is grouped by what a control DOES, every group named',
    shape.groups.join(',') === 'Instrument,Envelope,Part,Rhythm,Pitch,Voicing,Shape,Motion,Mix,Mod,Space,FX' && shape.unnamed === 0,
    JSON.stringify(shape.groups));
  ok('expanding opens NO subsection — the card is a contents page',
    shape.openOnExpand.length === 0, JSON.stringify(shape.openOnExpand));
  ok('an expanded card fits in about one screen (was 2873px on a 780px viewport)',
    shape.height < 1400, shape.height + 'px');
  // Even with EVERY group opened at once, no single group may become the dump
  // "Mix & FX" was (18 rows). This is the check that catches accretion.
  ok('no group is a dump — widest is under 12 rows with all of them open',
    shape.widest < 12, shape.widestName + ' of ' + JSON.stringify(shape));
  ok('a folded group says what is engaged inside it',
    shape.folded.length === shape.groups.length && shape.folded.every((f) => f.split('=')[1].length > 0),
    JSON.stringify(shape.folded));
  ok('no two rows on the card carry the same label',
    shape.dups.length === 0, JSON.stringify(shape.dups));
  ok("an effect's own parameters appear only once the effect is engaged",
    shape.fxRest === 8 && /Delay time/.test(shape.fxEngaged) && /Drive amt/.test(shape.fxEngaged) &&
    shape.fxBack === 8, JSON.stringify(shape));
  ok('which groups are open survives a rebuild',
    shape.afterRebuild === 'FX', shape.afterRebuild);

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
