#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// VIZ DRAG SCENARIO — the fast feedback loop for the v2 piano-roll gesture.
//
// The full UI gate is ~4 minutes and monolithic; three separate field reports
// about this one gesture each cost a dozen gate runs to verify. This is the
// user's own 4-step scenario as a 60-second probe:
//   1 click a note        → the grid must not resize, scroll or shift
//   2 grab another note   → nothing may move, the gutter mark tracks the grab
//   3 drag it vertically  → one half-step per row, no flicker under wobble,
//                           block under the cursor, geometry frozen
//   4 release             → geometry byte-identical (the sticky window)
//
//   node test/viz-drag.js          (needs `npm start` on :3001)
//
// This is a PROBE, not a gate — the gate's poison-verified checks own the
// contracts; this exists so a drag report can be verified in a minute.
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
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: false });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2200));

  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.body.classList.add('view-mix');
    _ambInitMaster();
    await wait(400);
    const E = _masterEng, h = document.getElementById('bloom-v2-layers');
    window._v2.addDefault(E);
    const L = (E.getCfg().layers || [])[0];
    L.on = true; L.present = true;
    L.part.kind = 'recorded'; L.part.bars = 2;
    L.part.notes = [{ t: 0, midi: 60, dur: 0.125 }, { t: 0.25, midi: 65, dur: 0.125 },
                    { t: 0.5, midi: 70, dur: 0.125 }];
    E.getCfg();
    const c0 = document.querySelector('.v2-layer'); if (c0) c0.classList.remove('collapsed');
    h._sig = ''; window._v2.render(E); await wait(380);
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const g = [...c.querySelectorAll('.v2-gototab')]
      .find((x) => x.getAttribute('data-goto') === 'Content');
    if (g) { g.click(); await wait(300); }
    c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
    await wait(150);
  });

  const snap = () => page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect();
    const pg = cv._pitchGeo;
    const L = (_masterEng.getCfg().layers || [])[0];
    const notes = (L.part.notes || []).slice().sort((a, b) => a.t - b.t);
    const yOf = (m) => Math.round(r.top + pg.top + (pg.hiM - m) * pg.rowH + pg.rowH / 2);
    const g2 = cv.getContext('2d');
    const dpr = cv.width / Math.max(1, r.width);
    let litRow = null;
    try {
      const img = g2.getImageData(Math.round(8 * dpr), 0, 1, cv.height).data;
      let best = -1, bd = 1e9;
      for (let y = 0; y < cv.height; y++) {
        const d = Math.abs(img[y * 4] - 123) + Math.abs(img[y * 4 + 1] - 79) +
                  Math.abs(img[y * 4 + 2] - 214);
        if (d < bd) { bd = d; best = y; }
      }
      if (bd < 150) litRow = pg.hiM - Math.floor((best / dpr - pg.top) / pg.rowH);
    } catch (e) { litRow = 'err'; }
    return { h: Math.round(r.height), top: Math.round(r.top),
             scroll: Math.round((document.scrollingElement || document.documentElement).scrollTop),
             rowH: pg.rowH, win: pg.loM + '..' + pg.hiM,
             midis: notes.map((n) => n.midi),
             ys: notes.map((n) => yOf(n.midi)), litRow,
             ed: !!document.querySelector('.v2-layer .v2-neinline:not([hidden])') };
  });
  const noteXY = (i) => page.evaluate((i) => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect();
    const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[i];
    return { x: r.left + hb.x + hb.w / 2, y: r.top + hb.y + hb.h / 2 };
  }, i);

  // 1 · CLICK
  const s0 = await snap();
  const p0 = await noteXY(0);
  await page.mouse.click(p0.x, p0.y);
  await new Promise((r) => setTimeout(r, 450));
  const s1 = await snap();
  ok('click a note: grid does not resize, scroll does not move, editor opens',
    s0.h === s1.h && s0.top === s1.top && s0.scroll === s1.scroll && s1.ed,
    JSON.stringify({ before: s0, after: s1 }));

  // 2 · GRAB a different note
  const p1 = await noteXY(1);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 120));
  const sHold = await snap();
  ok('grab: nothing shifts — every note position byte-identical',
    sHold.h === s1.h && sHold.ys.join() === s1.ys.join() && sHold.scroll === s1.scroll,
    JSON.stringify(sHold));

  // 3 · DRAG — one row per detent, gutter mark tracking. The detent engages
  // 0.85 rows past a boundary, so k = ceil(raw − 0.85): a target of
  // (i + 0.35) rows sits mid-band for k = i with half a row of margin.
  const rowH = sHold.rowH;
  await page.mouse.move(p1.x, p1.y - 7);   // arm
  await new Promise((r) => setTimeout(r, 60));
  const track = [];
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(p1.x, p1.y - (i + 0.35) * rowH, { steps: 2 });
    await new Promise((r) => setTimeout(r, 60));
    const s = await snap();
    track.push({ i, midi: s.midis[1], y1: s.ys[1],
                 cursorY: Math.round(p1.y - (i + 0.35) * rowH),
                 lit: s.litRow, h: s.h, scroll: s.scroll });
  }
  const ms = track.map((t) => t.midi);
  ok('drag: one half-step per row of travel',
    ms.slice(1).every((v, i) => v - ms[i] === 1),
    JSON.stringify(track));
  ok('drag: the lit gutter key IS the dragged note, every step',
    track.every((t) => t.lit === t.midi), JSON.stringify(track.map((t) => [t.lit, t.midi])));
  ok('drag: geometry and scroll frozen throughout',
    track.every((t) => t.h === s1.h && t.scroll === s1.scroll),
    JSON.stringify(track));
  ok('drag: the block stays under the cursor (within 4px)',
    track.every((t) => Math.abs(t.y1 - t.cursorY) <= 4),
    JSON.stringify(track.map((t) => t.y1 - t.cursorY)));

  // 3b · WOBBLE — hold near a row boundary and jitter ±2px: the note must
  // NOT flicker (this is the "still skips around vertically" report: plain
  // round() flipped at every half-row boundary under hand wobble)
  const baseY = p1.y - 5.5 * rowH;            // parked mid-band for k=5
  await page.mouse.move(p1.x, baseY);
  await new Promise((r) => setTimeout(r, 60));
  const wob = [];
  for (let j = 0; j < 8; j++) {
    await page.mouse.move(p1.x, baseY + (j % 2 ? 2 : -2));
    await new Promise((r) => setTimeout(r, 40));
    wob.push(await page.evaluate(() =>
      (_masterEng.getCfg().layers || [])[0].part.notes
        .slice().sort((a, b) => a.t - b.t)[1].midi));
  }
  ok('wobble: ±2px of hand jitter at a row boundary moves NOTHING',
    new Set(wob).size === 1, JSON.stringify(wob));

  // 4 · RELEASE
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 450));
  const sEnd = await snap();
  ok('release: geometry byte-identical — no resize, no scroll, same window',
    sEnd.h === s1.h && sEnd.scroll === s1.scroll && sEnd.win === s1.win &&
    Math.abs(sEnd.rowH - s1.rowH) < 1e-9,
    JSON.stringify({ before: { h: s1.h, win: s1.win }, after: sEnd }));

  // …and again after a second grab-release cycle on the moved note (the
  // float-noise case: an integer pitch out of log2(freq) lands at 71.0000…01
  // and ceil() bumped the sticky window's fits-test)
  const p2 = await noteXY(1);
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  await page.mouse.move(p2.x, p2.y - 7);
  await page.mouse.move(p2.x, p2.y - 1.35 * rowH, { steps: 2 });
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 450));
  const sEnd2 = await snap();
  ok('second drag + release: still byte-identical geometry',
    sEnd2.h === s1.h && sEnd2.win === s1.win,
    JSON.stringify(sEnd2));

  // ── 5 · THE CHORDLOCKED PART — the field case from the screenshot ───────
  // A take locked under a progression DEFAULTS to harmony 'chordlock', which
  // remaps every stored pitch into the sounding chord: stored ≠ drawn, so the
  // gutter mark (stored) sat rows away from the block (drawn) and a semitone
  // drag stuck-then-jumped between chord tones. Hand placement wins now: the
  // gutter mark resolves from the DRAWN note (nidx), and dragging PINS the
  // note (n.hx) to exactly the pitch under the hand.
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, h = document.getElementById('bloom-v2-layers');
    const cfg = E.getCfg();
    cfg.prog = { on: true, chords: [
      { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
      { root: 7, intervals: [0, 4, 7] }, { root: 9, intervals: [0, 3, 7] }] };
    const L = (cfg.layers || [])[0];
    L.part.kind = 'recorded'; L.part.bars = 2;
    L.harmony = 'chordlock';
    L.part.key = { root: 0, scale: 'major' };
    // stored pitches deliberately OFF the chord tones, so the remap moves them
    L.part.notes = [{ t: 0, midi: 62, dur: 0.125 }, { t: 0.25, midi: 65, dur: 0.125 },
                    { t: 0.5, midi: 69, dur: 0.125 }];
    E.getCfg();
    h._sig = ''; window._v2.render(E); await wait(380);
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const g = [...c.querySelectorAll('.v2-gototab')]
      .find((x) => x.getAttribute('data-goto') === 'Content');
    if (g) { g.click(); await wait(300); }
    c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
    await wait(150);
  });
  const clStored = await page.evaluate(() =>
    (_masterEng.getCfg().layers || [])[0].part.notes
      .slice().sort((a, b) => a.t - b.t).map((n) => n.midi));
  const clDrawn = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    return (cv._hits || []).slice().sort((a, b) => a.t - b.t)
      .map((hb) => Math.round(hb.midi));
  });
  ok('chordlock fixture really remaps (stored ≠ drawn for at least one note)',
    clStored.join() !== clDrawn.join(),
    JSON.stringify({ stored: clStored, drawn: clDrawn }));

  // tap-select: the lit key must be the DRAWN row, not the stored one
  const cp0 = await noteXY(0);
  await page.mouse.click(cp0.x, cp0.y);
  await new Promise((r) => setTimeout(r, 450));
  const cs1 = await snap();
  ok('chordlock: the lit gutter key IS the drawn note, not the stored pitch',
    cs1.litRow === clDrawn[0],
    JSON.stringify({ lit: cs1.litRow, drawn: clDrawn[0], stored: clStored[0] }));

  // drag: pins the note; one row per detent, block moves EVERY detent
  const cp1 = await noteXY(1);
  await page.mouse.move(cp1.x, cp1.y);
  await page.mouse.down();
  await page.mouse.move(cp1.x, cp1.y - 7);   // arm (pins + rebases, no jump)
  await new Promise((r) => setTimeout(r, 60));
  const pinned = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[1];
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[1];
    return { hx: !!n.hx, stored: n.midi, drawn: Math.round(hb.midi) };
  });
  // ±1: the 7px arm move is itself one detent of legitimate travel
  ok('chordlock: the grab pins the note — stored rebased to the drawn pitch, no remap jump',
    pinned.hx && pinned.stored === pinned.drawn &&
    Math.abs(pinned.stored - clDrawn[1]) <= 1,
    JSON.stringify({ pinned, wasDrawn: clDrawn[1] }));
  const clTrack = [];
  const rowH2 = cs1.rowH;
  for (let i = 1; i <= 3; i++) {
    await page.mouse.move(cp1.x, cp1.y - (i + 0.35) * rowH2, { steps: 2 });
    await new Promise((r) => setTimeout(r, 60));
    clTrack.push(await page.evaluate(() => {
      const L = (_masterEng.getCfg().layers || [])[0];
      const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[1];
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[1];
      const pg = cv._pitchGeo;
      const g2 = cv.getContext('2d');
      const r = cv.getBoundingClientRect();
      const dpr = cv.width / Math.max(1, r.width);
      let lit = null;
      try {
        const img = g2.getImageData(Math.round(8 * dpr), 0, 1, cv.height).data;
        let best = -1, bd = 1e9;
        for (let y = 0; y < cv.height; y++) {
          const d = Math.abs(img[y * 4] - 123) + Math.abs(img[y * 4 + 1] - 79) +
                    Math.abs(img[y * 4 + 2] - 214);
          if (d < bd) { bd = d; best = y; }
        }
        if (bd < 150) lit = pg.hiM - Math.floor((best / dpr - pg.top) / pg.rowH);
      } catch (e) { lit = 'err'; }
      return { stored: n.midi, drawn: Math.round(hb.midi), lit };
    }));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 450));
  const clm = clTrack.map((t) => t.drawn);
  ok('chordlock drag: the BLOCK moves one row per detent — no stick-and-jump',
    clm.slice(1).every((v, i) => v - clm[i] === 1) &&
    clTrack.every((t) => t.stored === t.drawn),
    JSON.stringify(clTrack));
  ok('chordlock drag: the lit key tracks the block every step',
    clTrack.every((t) => t.lit === t.drawn), JSON.stringify(clTrack));
  const clEnd = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[1];
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[1];
    return { hx: !!n.hx, stored: n.midi, drawn: Math.round(hb.midi) };
  });
  ok('chordlock release: the note STAYS exactly where it was dropped',
    clEnd.hx && clEnd.stored === clEnd.drawn && clEnd.drawn === clm[clm.length - 1],
    JSON.stringify(clEnd));

  // ── 6 · THE ± NOTE STEPPER on a remapped note — linear, no craziness ─────
  // The chordlock map is NON-MONOTONIC (octave-hugging clamp), so a stepper
  // over the STORED pitch moved the drawn block up, down and sideways per
  // press ("jumps around like crazy"). The Note field shows and edits the
  // SOUNDING pitch now; the first press pins, every press is +1 row.
  const sp = await noteXY(2);                    // the third note — never touched
  await page.mouse.click(sp.x, sp.y);            // open its editor
  await new Promise((r) => setTimeout(r, 450));
  const st0 = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[2];
    const inp = document.querySelector('.v2-layer .v2-neinline .ambient-step-inp[data-sf="midi"]');
    const L = (_masterEng.getCfg().layers || [])[0];
    const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[2];
    return { drawn: Math.round(hb.midi), input: inp ? parseInt(inp.value, 10) : null,
             stored: n.midi, hx: !!n.hx };
  });
  ok('stepper: the Note field SHOWS the sounding pitch (not the stored one)',
    st0.input === st0.drawn && !st0.hx && st0.stored !== st0.drawn,
    JSON.stringify(st0));
  const stTrack = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const b = document.querySelector('.v2-layer .v2-neinline .ambient-step-up');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 250));
    stTrack.push(await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const hb = (cv._hits || []).slice().sort((a, b) => a.t - b.t)[2];
      const L = (_masterEng.getCfg().layers || [])[0];
      const n = L.part.notes.slice().sort((a, b) => a.t - b.t)[2];
      return { drawn: Math.round(hb.midi), stored: n.midi, hx: !!n.hx };
    }));
  }
  const stm = [st0.drawn].concat(stTrack.map((t) => t.drawn));
  ok('stepper: each + press moves the block EXACTLY one row up — linear',
    stm.slice(1).every((v, i) => v - stm[i] === 1),
    JSON.stringify(stm));
  ok('stepper: the first press pins the note (hx) and stored tracks sounding',
    stTrack.every((t) => t.hx && t.stored === t.drawn),
    JSON.stringify(stTrack));
  // close the editor
  await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  // ── 7 · THE PENCIL — press places, drag sizes, release commits ───────────
  // Direct drawing on the hardest fixture: a chordlocked part, where an
  // unpinned added note would be remapped to a different row than the one
  // clicked. The pencil pins, so the note lands and stays EXACTLY where the
  // hand put it, and dragging right sizes it by whole cells.
  await page.evaluate(() => {
    // RESTATED: the mode is one select now (view/edit/draw/multi)
    const b = document.querySelector('.v2-layer .v2-modepick');
    if (b) { b.value = 'draw'; b.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await new Promise((r) => setTimeout(r, 450));
  const pens = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect();
    const pg = cv._pitchGeo, pl = cv._plotGeo;
    const L = (_masterEng.getCfg().layers || [])[0];
    const g = window._v2.gridCells(L);
    const usedRows = new Set((cv._hits || []).map((x) => Math.round(x.midi)));
    let row = pg.loM + 2;
    while (usedRows.has(row) && row < pg.hiM) row++;
    return { x: r.left + pl.x0 + pl.w * 0.72,
             y: r.top + pg.top + (pg.hiM - row) * pg.rowH + pg.rowH / 2,
             row, cellPx: pl.w / g, cells: g,
             n0: L.part.notes.length, h: Math.round(r.height) };
  });
  await page.mouse.move(pens.x, pens.y);
  await page.mouse.down();
  await page.mouse.move(pens.x + 3 * pens.cellPx + 4, pens.y, { steps: 3 });
  await new Promise((r) => setTimeout(r, 80));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 450));
  const penOut = await page.evaluate((want) => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const L = (_masterEng.getCfg().layers || [])[0];
    const notes = L.part.notes;
    // the new note is the one nearest the drawn row at the pressed cell
    let best = null, bd = 1e9;
    notes.forEach((n) => {
      const d = Math.abs(n.midi - want.row) + Math.abs(n.t - 0.72);
      if (d < bd) { bd = d; best = n; }
    });
    const hb = best ? (cv._hits || []).find((x) => x.i === notes.indexOf(best)) : null;
    return { count: notes.length,
             note: best ? { t: best.t, midi: best.midi, dur: best.dur, hx: !!best.hx } : null,
             drawnRow: hb ? Math.round(hb.midi) : null,
             edOpen: !!document.querySelector('.v2-layer .v2-neinline:not([hidden])'),
             h: Math.round(cv.getBoundingClientRect().height) };
  }, pens);
  ok('pencil: press-drag adds ONE note sized by the drag (4 cells)',
    penOut.count === pens.n0 + 1 && penOut.note &&
    Math.abs(penOut.note.dur * pens.cells - 4) < 0.01,
    JSON.stringify({ pens, penOut }));
  ok('pencil: the note lands EXACTLY on the clicked row — pinned through the remap',
    penOut.note && penOut.note.hx && penOut.note.midi === pens.row &&
    penOut.drawnRow === pens.row,
    JSON.stringify({ want: pens.row, got: penOut.note, drawn: penOut.drawnRow }));
  ok('pencil: a drag-draw does not pop the editor, and the grid does not resize',
    !penOut.edOpen && penOut.h === pens.h,
    JSON.stringify({ edOpen: penOut.edOpen, h: penOut.h, was: pens.h }));

  // …and a pencil TAP adds exactly ONE note (the trailing click must not add
  // a second) and opens the editor on it
  const pent = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect();
    const pg = cv._pitchGeo, pl = cv._plotGeo;
    const L = (_masterEng.getCfg().layers || [])[0];
    const usedRows = new Set((cv._hits || []).map((x) => Math.round(x.midi)));
    let row = pg.hiM - 2;
    while (usedRows.has(row) && row > pg.loM) row--;
    return { x: r.left + pl.x0 + pl.w * 0.9,
             y: r.top + pg.top + (pg.hiM - row) * pg.rowH + pg.rowH / 2,
             row, n0: L.part.notes.length };
  });
  await page.mouse.click(pent.x, pent.y);
  await new Promise((r) => setTimeout(r, 500));
  const pentOut = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    return { count: L.part.notes.length,
             edOpen: !!document.querySelector('.v2-layer .v2-neinline:not([hidden])') };
  });
  ok('pencil tap: exactly ONE note added (no double-add from the trailing click), editor opens',
    pentOut.count === pent.n0 + 1 && pentOut.edOpen,
    JSON.stringify({ before: pent.n0, after: pentOut.count, edOpen: pentOut.edOpen }));
  // leave draw mode
  await page.evaluate(() => {
    // RESTATED: the mode is one select now (view/edit/draw/multi)
    const b = document.querySelector('.v2-layer .v2-modepick');
    if (b) { b.value = 'view'; b.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await new Promise((r) => setTimeout(r, 350));

  // ── 8 · KEYBOARD: ⌃ arrows move, ⌥ ←/→ resize — the editor is open on the
  // note the pencil tap just added (chordlocked fixture, so the pitch moves
  // must be linear in SOUNDING space too)
  const kb0 = await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const g = window._v2.gridCells(L);
    // the editor's note — resolved through the same store the editor uses
    const idx = (() => {
      const o = document.querySelector('.v2-layer .v2-neinline');
      return o && !o.hidden ? o._idx : -1;
    })();
    const n = L.part.notes[idx];
    const hb = (cv._hits || []).find((x) => x.i === idx);
    return { idx, t: n ? n.t : null, dur: n ? n.dur : null, cells: g,
             drawn: hb ? Math.round(hb.midi) : null,
             edOpen: idx >= 0, h: Math.round(cv.getBoundingClientRect().height) };
  });
  const kbNote = () => page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const o = document.querySelector('.v2-layer .v2-neinline');
    const idx = o && !o.hidden ? o._idx : -1;
    const n = L.part.notes[idx];
    const hb = (cv._hits || []).find((x) => x.i === idx);
    return { t: n ? n.t : null, dur: n ? n.dur : null,
             drawn: hb ? Math.round(hb.midi) : null,
             h: Math.round(cv.getBoundingClientRect().height) };
  });
  const chord = async (mod, key) => {
    await page.keyboard.down(mod);
    await page.keyboard.press(key);
    await page.keyboard.up(mod);
    await new Promise((r) => setTimeout(r, 250));
  };
  // ⇧ is the primary move chord now (⌃←/→ is the macOS Spaces shortcut, so
  // half the pairs never reached the browser — "the arrow keys are not
  // working"); the return path drives ⌃ to pin that the alias survives.
  await chord('Shift', 'ArrowUp');
  const kUp = await kbNote();
  await chord('Shift', 'ArrowRight');
  const kRight = await kbNote();
  await chord('Alt', 'ArrowRight');
  const kGrow = await kbNote();
  await chord('Alt', 'ArrowLeft');
  const kShrink = await kbNote();
  await chord('Control', 'ArrowDown');
  await chord('Control', 'ArrowLeft');
  const kBack = await kbNote();
  const cell = 1 / kb0.cells;
  ok('⇧↑ moves the note one half-step up (sounding space)',
    kb0.edOpen && kUp.drawn === kb0.drawn + 1,
    JSON.stringify({ before: kb0.drawn, after: kUp.drawn }));
  ok('⇧→ moves it one grid cell right',
    Math.abs(kRight.t - (kb0.t + cell)) < 1e-9,
    JSON.stringify({ before: kb0.t, after: kRight.t, cell }));
  ok('⌥→ grows it a cell, ⌥← shrinks it back',
    Math.abs(kGrow.dur - (kb0.dur + cell)) < 1e-9 &&
    Math.abs(kShrink.dur - kb0.dur) < 1e-9,
    JSON.stringify({ dur0: kb0.dur, grown: kGrow.dur, back: kShrink.dur }));
  ok('⌃↓ and ⌃← (the alias) return it exactly, and the grid never resized',
    kBack.drawn === kb0.drawn && Math.abs(kBack.t - kb0.t) < 1e-9 &&
    kBack.h === kb0.h,
    JSON.stringify({ back: kBack, was: { drawn: kb0.drawn, t: kb0.t, h: kb0.h } }));

  // ── 9 · A DRAG TOUCHES EXACTLY ONE NOTE — the one the hit box names ─────
  // Under chordlock, `nearestNote(stored)` could resolve a grab to a
  // NEIGHBOUR whose stored pitch equals the grabbed note's drawn pitch —
  // which was then dragged and rebased: "dragging a note changes notes it
  // comes close to". The fixture manufactures exactly that collision.
  const oneRun = await (async () => {
    await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const E = _masterEng, h = document.getElementById('bloom-v2-layers');
      const L = (E.getCfg().layers || [])[0];
      L.part.kind = 'recorded'; L.part.bars = 2;
      L.harmony = 'chordlock'; L.part.key = { root: 0, scale: 'major' };
      // A stored 62 draws at 64 (chord tone); B stored 64 == A's DRAWN pitch
      L.part.notes = [{ t: 0.25, midi: 62, dur: 0.125 }, { t: 0.25, midi: 64, dur: 0.125 }];
      E.getCfg();
      const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
      h._sig = ''; window._v2.render(E); await wait(380);
      const g = [...c.querySelectorAll('.v2-gototab')]
        .find((x) => x.getAttribute('data-goto') === 'Content');
      if (g) { g.click(); await wait(300); }
      c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 250));
    const st9 = await page.evaluate(() => {
      const cv = document.querySelector('.v2-layer .v2-vizcv');
      const r = cv.getBoundingClientRect();
      const hb = (cv._hits || [])[0];      // the FIRST box at that spot — its .i names the note
      const L = (_masterEng.getCfg().layers || [])[0];
      return { i: hb.i, x: r.left + hb.x + hb.w / 2, y: r.top + hb.y + 3,
               all: L.part.notes.map((n) => [n.t, n.midi]) };
    });
    await page.mouse.move(st9.x, st9.y);
    await page.mouse.down();
    await page.mouse.move(st9.x, st9.y - 7);
    await page.mouse.move(st9.x, st9.y - 2.35 * 6.31, { steps: 2 });
    await new Promise((r) => setTimeout(r, 80));
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 400));
    return await page.evaluate((st) => {
      const L = (_masterEng.getCfg().layers || [])[0];
      const now = L.part.notes.map((n) => [n.t, n.midi]);
      const changed = [];
      st.all.forEach((a, k) => { if (JSON.stringify(a) !== JSON.stringify(now[k])) changed.push(k); });
      return { grabbedIdx: st.i, changed, before: st.all, after: now };
    }, st9);
  })();
  ok('a drag changes EXACTLY the note the hit box names — neighbours untouched',
    oneRun.changed.length === 1 && oneRun.changed[0] === oneRun.grabbedIdx,
    JSON.stringify(oneRun));

  // ── 10 · BAR SELECT LIVES IN THE RULER ───────────────────────────────────
  const labTxt = () => page.evaluate(() =>
    (document.querySelector('.v2-layer .v2-vizlab') || {}).textContent || '');
  const bs0 = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect();
    const pl = cv._plotGeo, pg = cv._pitchGeo;
    return { plotX: r.left + pl.x0 + pl.w * 0.6,
             midY: r.top + pg.top + 60, rulerY: r.top + 8 };
  });
  await page.mouse.click(bs0.plotX, bs0.midY);
  await new Promise((r) => setTimeout(r, 350));
  const afterPlot = await labTxt();
  ok('a tap in the open plot does NOT select a bar',
    !/re-rolling|retaking/.test(afterPlot), afterPlot.slice(0, 120));
  await page.mouse.click(bs0.plotX, bs0.rulerY);
  await new Promise((r) => setTimeout(r, 350));
  const afterRuler = await labTxt();
  ok('a tap on the RULER selects the bar',
    /re-rolling|retaking/.test(afterRuler), afterRuler.slice(0, 120));
  await page.mouse.click(bs0.plotX, bs0.rulerY);   // deselect again
  await new Promise((r) => setTimeout(r, 300));

  // ── 11 · POSITION AND LENGTH ARE ± STEPPERS ──────────────────────────────
  const sp2 = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect();
    const hb = (cv._hits || [])[0];
    return { x: r.left + hb.x + hb.w / 2, y: r.top + hb.y + 3 };
  });
  await page.mouse.click(sp2.x, sp2.y);            // open the editor
  await new Promise((r) => setTimeout(r, 450));
  const stepRun = await page.evaluate(async () => {
    const o = document.querySelector('.v2-layer .v2-neinline');
    if (!o || o.hidden) return { open: false };
    const pos = o.querySelector('.ambient-step-inp[data-sf="pos"]');
    const len = o.querySelector('.ambient-step-inp[data-sf="len"]');
    const L = (_masterEng.getCfg().layers || [])[0];
    const idx = o._idx, t0 = L.part.notes[idx].t;
    const up = pos && pos.closest('.ambient-ctrl').querySelector('.ambient-step-up');
    if (up) up.click();
    await new Promise((r) => setTimeout(r, 350));
    const L2 = (_masterEng.getCfg().layers || [])[0];
    const o2 = document.querySelector('.v2-layer .v2-neinline');
    return { open: true, hasPos: !!pos, hasLen: !!len, t0,
             t1: o2 && o2._idx >= 0 ? L2.part.notes[o2._idx].t : null,
             cells: window._v2.gridCells(L2) };
  });
  ok('Position and Length are ± steppers, and one press moves one grid cell',
    stepRun.open && stepRun.hasPos && stepRun.hasLen &&
    Math.abs(stepRun.t1 - (stepRun.t0 + 1 / stepRun.cells)) < 1e-9,
    JSON.stringify(stepRun));
  await page.mouse.click(sp2.x, sp2.y);            // close (same spot ≈ same note)
  await new Promise((r) => setTimeout(r, 300));

  // ── 12 · THE GENERATED PANEL KNOWS ITS PART ──────────────────────────────
  const genRun = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, h = document.getElementById('bloom-v2-layers');
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.bars = 5;
    L.part.rhythm = { kind: 'euclid', steps: 16, pulses: 9, rotate: 5 };
    L.part.pitch = { kind: 'walk', span: 3 };
    E.getCfg();
    h._sig = ''; window._v2.render(E); await wait(380);
    const bad = (document.querySelector('.v2-layer .v2-gensays') || {}).textContent || '';
    L.part.rhythm.steps = 20; E.getCfg();
    h._sig = ''; window._v2.render(E); await wait(380);
    const good = (document.querySelector('.v2-layer .v2-gensays') || {}).textContent || '';
    // …and the ROLL itself picks a bar-commensurate grid for the part — a
    // FIVE-bar part, because 16 divides 4 and a 4-bar fixture cannot tell
    // the commensurate pick from the old fixed 16 (the poison passed there)
    const cfg5 = E.getCfg();
    cfg5.prog.chords.push({ root: 2, intervals: [0, 3, 7] });
    E.getCfg();
    window.confirm = () => true;
    // FROM A NON-ROLL SHAPE: a walk infers as Roll and a lit-by-inference
    // press ADOPTS (stamps the mode, keeps the content) — the dice only run
    // on a genuine build, which is what this check is about
    const Lp = (E.getCfg().layers || [])[0];
    Lp.part.pitch = { kind: 'chord', voices: 3 };
    Lp.part.rhythm = { kind: 'pulse', n: 1 };
    delete Lp.part.mat; E.getCfg();
    h._sig = ''; window._v2.render(E); await wait(380);
    const roll = document.querySelector('.v2-layer .v2-rollrun');
    if (roll) roll.click();
    await wait(450);
    const L2 = (E.getCfg().layers || [])[0];
    const rolled = { steps: (L2.part.rhythm || {}).steps, bars: L2.part.bars,
                     mat: L2.part.mat || null, kind: L2.part.kind };
    E.getCfg().prog.chords.pop(); E.getCfg();
    return { bad, good, rolled };
  });
  ok('the Generated panel names the part, does the notes/bar math, and flags a grid the bars cannot divide',
    // the fixture's part is genuinely 4 bars while the cycle is 5 — the
    // panel names the part's OWN length and calls out the mismatch
    /For .+\(4 bars\)/.test(genRun.bad) &&
    /This cycle is 5 of its 4 bars/.test(genRun.bad) &&
    /9 over 5 bars/.test(genRun.bad) &&
    /\u26a0 Grid 16 over 5 bars/.test(genRun.bad) &&
    !/\u26a0 Grid/.test(genRun.good),
    JSON.stringify({ bad: genRun.bad.slice(0, 220), good: genRun.good.slice(0, 160) }));
  ok('a roll picks a grid the part\'s bars divide — notes CAN land on bar lines',
    genRun.rolled.steps > 0 && genRun.rolled.bars > 0 &&
    genRun.rolled.steps % Math.round(genRun.rolled.bars) === 0,
    JSON.stringify(genRun.rolled));

  // ── 13 · ONE GESTURE, ONE AXIS — and ± never resizes (2026-09-08) ───────
  // The report: "moving a note vertically and horizontally should be totally
  // independent; past a bar boundary the note shifts up or down towards the
  // nearest note; the +/- buttons should not resize". Three contracts on one
  // chordlocked fixture: a horizontal drag moves TIME only (vertical drift
  // and the chord change at the bar line both move nothing), a vertical drag
  // moves PITCH only, and ± walks a note past the window's edge with the
  // canvas height byte-identical (the window SHIFTS, it never grows).
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng, h = document.getElementById('bloom-v2-layers');
    const cfg = E.getCfg();
    cfg.prog = { on: true, chords: [
      { root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] }] };
    const L = (cfg.layers || [])[0];
    L.part.kind = 'recorded'; L.part.bars = 2; L.part.take = 78;
    L.harmony = 'chordlock'; L.part.key = { root: 0, scale: 'major' };
    delete L.part.mat;
    L.part.notes = [{ t: 15 / 32, midi: 62, dur: 0.03125 },
                    { t: 18 / 32, midi: 64, dur: 0.03125 },
                    { t: 26 / 32, midi: 65, dur: 0.03125 }];
    E.getCfg();
    h._sig = ''; window._v2.render(E); await wait(380);
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const g = [...c.querySelectorAll('.v2-gototab')]
      .find((x) => x.getAttribute('data-goto') === 'Content');
    if (g) { g.click(); await wait(300); }
    c.querySelector('.v2-vizcv').scrollIntoView({ block: 'center' });
    await wait(150);
  });
  const axGeo = await page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const L = (_masterEng.getCfg().layers || [])[0];
    return { rowH: cv._pitchGeo.rowH,
             cellPx: cv._plotGeo.w / window._v2.gridCells(L),
             drawn: (cv._hits || []).slice().sort((a, b) => a.t - b.t)
               .map((hb) => Math.round(hb.midi)) };
  });
  const axNotes = () => page.evaluate(() => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const L = (_masterEng.getCfg().layers || [])[0];
    const stored = L.part.notes.slice().sort((a, b) => a.t - b.t);
    const drawn = (cv._hits || []).slice().sort((a, b) => a.t - b.t);
    return { t: stored.map((n) => n.t), midi: stored.map((n) => n.midi),
             drawn: drawn.map((hb) => Math.round(hb.midi)),
             h: Math.round(cv.getBoundingClientRect().height) };
  });
  // a · HORIZONTAL drag on note 1, across the drift AND with 1.35 rows of
  // vertical wobble — without the axis lock the 0.85-row detent flips a row
  const ax1 = await noteXY(1);
  await page.mouse.move(ax1.x, ax1.y);
  await page.mouse.down();
  await page.mouse.move(ax1.x + 8, ax1.y);              // arm horizontally
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.move(ax1.x + 2.4 * axGeo.cellPx, ax1.y - 1.35 * axGeo.rowH, { steps: 4 });
  await new Promise((r) => setTimeout(r, 80));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));
  const axA = await axNotes();
  ok('axis lock: a horizontal drag moves TIME only — vertical drift and the remap move nothing',
    Math.abs(axA.t[1] - 20 / 32) < 1e-9 && axA.drawn[1] === axGeo.drawn[1] &&
    axA.drawn[0] === axGeo.drawn[0] && axA.drawn[2] === axGeo.drawn[2],
    JSON.stringify({ before: axGeo, after: axA }));
  // b · VERTICAL drag on note 2 with 0.7 cells of horizontal drift — without
  // the lock that snaps a whole cell
  const ax2 = await noteXY(2);
  await page.mouse.move(ax2.x, ax2.y);
  await page.mouse.down();
  await page.mouse.move(ax2.x, ax2.y - 8);              // arm vertically
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.move(ax2.x + 0.7 * axGeo.cellPx, ax2.y - 3.35 * axGeo.rowH, { steps: 4 });
  await new Promise((r) => setTimeout(r, 80));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));
  const axB = await axNotes();
  ok('axis lock: a vertical drag moves PITCH only — horizontal drift moves nothing',
    Math.abs(axB.t[2] - axA.t[2]) < 1e-9 && axB.drawn[2] === axA.drawn[2] + 3,
    JSON.stringify({ before: axA, after: axB }));
  // c · ± Position across the bar line: the chord changes, the pitch may not
  const ax0 = await noteXY(0);
  await page.mouse.click(ax0.x, ax0.y);                  // open the editor
  await new Promise((r) => setTimeout(r, 450));
  const axPress = (sf) => page.evaluate((sf) => {
    const inp = document.querySelector('.v2-layer .v2-neinline .ambient-step-inp[data-sf="' + sf + '"]');
    const b = inp && inp.closest('.ambient-ctrl').querySelector('.ambient-step-up');
    if (b) b.click(); return !!b;
  }, sf);
  await axPress('pos');
  await new Promise((r) => setTimeout(r, 350));
  const axC = await axNotes();
  ok('± Position across a chord change moves TIME only — the pin holds the drawn pitch',
    Math.abs(axC.t[0] - 0.5) < 1e-9 && axC.drawn[0] === axGeo.drawn[0],
    JSON.stringify({ before: { t: 15 / 32, drawn: axGeo.drawn[0] }, after: axC }));
  // d · ± Note ×6 past the window's edge: the canvas height never changes.
  // SIX presses, not more: the window SHIFTS at a constant row count only
  // while the material still fits it — press 8 on this fixture would push
  // the range past the held size, where growing is legitimate.
  const axHts = [];
  for (let i = 0; i < 6; i++) {
    await axPress('midi');
    await new Promise((r) => setTimeout(r, 220));
    const s = await axNotes();
    axHts.push({ h: s.h, stored: s.midi[0] });
  }
  ok('± Note past the window edge NEVER resizes the canvas — the axis scrolls',
    axHts.every((s) => s.h === axHts[0].h) &&
    axHts.every((s, i) => i === 0 || s.stored - axHts[i - 1].stored === 1),
    JSON.stringify(axHts));
  await page.evaluate(() => {
    const b = document.querySelector('.v2-layer .v2-neinline [data-na="done"]');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 250));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nVIZ DRAG: ' + (fail ? '✗ ' + fail + ' failed, ' : '✓ all ') + pass + ' checks pass');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
