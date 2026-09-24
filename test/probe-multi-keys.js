// PROBE — ⬚ Multi takes the note keys too.
//
// user, 2026-09-23: "keyboard shortcuts to move note events should work in
// Multi too".
//
// The claim is that the SAME three gestures mean the same things on a
// gathering as on one note — ⇧←/→ a grid cell, ⇧↑/↓ a half-step, ⌥←/→ a cell
// of length — and that they go through `multiApply`, the one writer, so the
// uniform clamp, the pin and the re-find by identity come with them rather
// than being re-implemented behind a hotkey.
//
//   node test/probe-multi-keys.js    (needs `npm start`; BLOOPS_URL to retarget)
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
  page.on('dialog', async (d) => { await d.accept(); });
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1300);

  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.form;
    L.part.kind = 'recorded';
    L.part.bars = 2;
    // ON THE GRID. A grid move SNAPS — that is the contract, not a rounding
    // bug — so an off-grid fixture cannot round-trip and would test the snap
    // rather than the move. 1/32 of the cycle is one cell over two bars at 16.
    L.part.notes = [
      { t: 2 / 32, midi: 60, dur: 2 / 32 },
      { t: 10 / 32, midi: 64, dur: 2 / 32 },
      { t: 18 / 32, midi: 67, dur: 2 / 32 },
      { t: 26 / 32, midi: 71, dur: 2 / 32 },
    ];
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await zz(900);
  await page.evaluate(() => {
    [...document.querySelectorAll('.v2-layer')].forEach((c) => {
      if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
    });
  });
  await zz(900);
  await page.evaluate(() => {
    const sel = document.querySelector('.v2-modepick');
    sel.value = 'multi';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await zz(1100);

  // GATHER BAR 2 through the ruler — the door the last change added.
  const at = async (bar) => page.evaluate((bar) => {
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const r = cv.getBoundingClientRect(), g = cv._barsGeo, pg = cv._pitchGeo, cg = cv._chordGeo;
    const vsc = (g.vsc > 0) ? g.vsc : 1, f0 = g.f0 || 0;
    const fr = (bar + 0.5) / g.barsF;
    return { x: r.left + (g.x0 || 0) + ((fr - f0) / vsc) * g.w,
             y: r.top + (cg && cg.top ? (cg.top + pg.top) / 2 : Math.max(4, pg.top / 2)) };
  }, bar);
  const b2 = await at(1);
  await page.mouse.click(b2.x, b2.y);
  await zz(500);

  const snap = () => page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    return { sel: (window._v2.multiSel(L) || []).slice().sort((a, b) => a - b),
             notes: (L.part.notes || []).map((n) => ({ t: +n.t.toFixed(5), m: n.midi | 0, d: +n.dur.toFixed(5) })),
             hint: (document.querySelector('.v2-layer .v2-multin') || {}).textContent || '' };
  });
  const s0 = await snap();
  console.log('\n  gathered: ' + JSON.stringify(s0.sel));
  ok('two notes gathered to move', s0.sel.join(',') === '2,3', JSON.stringify(s0.sel));
  // A HOTKEY NOBODY IS TOLD ABOUT IS A HOTKEY NOBODY PRESSES.
  ok('…and the card says the keyboard moves them',
    /arrows move them/.test(s0.hint) && /resize/.test(s0.hint), s0.hint);

  // FOCUS ON THE BODY — the handler refuses while a field has focus, which is
  // the point (⇧+arrow extends a text selection).
  await page.evaluate(() => { try { document.activeElement.blur(); } catch (e) {} document.body.focus(); });

  const key = async (k, mod) => {
    if (mod) await page.keyboard.down(mod);
    await page.keyboard.press(k);
    if (mod) await page.keyboard.up(mod);
    await zz(320);
    return snap();
  };

  const up = await key('ArrowUp', 'Shift');
  ok('⇧↑ moves EVERY gathered note up a half-step — and only those',
    up.notes[2].m === s0.notes[2].m + 1 && up.notes[3].m === s0.notes[3].m + 1 &&
    up.notes[0].m === s0.notes[0].m && up.notes[1].m === s0.notes[1].m,
    JSON.stringify({ before: s0.notes.map((n) => n.m), after: up.notes.map((n) => n.m) }));
  const dn = await key('ArrowDown', 'Shift');
  ok('…and ⇧↓ puts them back exactly',
    JSON.stringify(dn.notes.map((n) => n.m)) === JSON.stringify(s0.notes.map((n) => n.m)),
    JSON.stringify(dn.notes.map((n) => n.m)));

  const rt = await key('ArrowRight', 'Shift');
  const moved = rt.notes.map((n, i) => +(n.t - s0.notes[i].t).toFixed(5));
  ok('⇧→ moves them ONE grid cell later, by the same step, leaving the rest',
    moved[0] === 0 && moved[1] === 0 && moved[2] > 0 && moved[2] === moved[3],
    JSON.stringify({ deltas: moved }));
  const lf = await key('ArrowLeft', 'Shift');
  ok('…and ⇧← returns them',
    JSON.stringify(lf.notes.map((n) => n.t)) === JSON.stringify(s0.notes.map((n) => n.t)),
    JSON.stringify({ before: s0.notes.map((n) => n.t), after: lf.notes.map((n) => n.t) }));

  const gr = await key('ArrowRight', 'Alt');
  const grew = gr.notes.map((n, i) => +(n.d - s0.notes[i].d).toFixed(5));
  ok('⌥→ lengthens every gathered note by a cell, and nothing else',
    grew[0] === 0 && grew[1] === 0 && grew[2] > 0 && grew[2] === grew[3],
    JSON.stringify({ deltas: grew }));
  const sh = await key('ArrowLeft', 'Alt');
  ok('…and ⌥← shortens them back',
    JSON.stringify(sh.notes.map((n) => n.d)) === JSON.stringify(s0.notes.map((n) => n.d)),
    JSON.stringify({ before: s0.notes.map((n) => n.d), after: sh.notes.map((n) => n.d) }));

  // THE GATHERING SURVIVES THE MOVE — `multiApply` re-finds by identity after
  // normalize replaces every note object. Without that the second press acts
  // on nothing, which is the bug this check exists for.
  const still = await snap();
  ok('the gathering survives every move — the notes are re-found, not lost',
    still.sel.join(',') === '2,3', JSON.stringify(still.sel));

  // …AND IT STOPS WHEN THE GATHERING DOES.
  await page.evaluate(() => { document.querySelector('.v2-layer .v2-mclear').click(); });
  await zz(400);
  const beforeIdle = await snap();
  await key('ArrowUp', 'Shift');
  const afterIdle = await snap();
  ok('with nothing gathered the keys move nothing',
    JSON.stringify(afterIdle.notes) === JSON.stringify(beforeIdle.notes),
    JSON.stringify({ before: beforeIdle.notes.map((n) => n.m), after: afterIdle.notes.map((n) => n.m) }));

  // A FIELD KEEPS ITS OWN ⇧+ARROW — it extends a text selection, and a
  // gathering must not steal that.
  await page.mouse.click(b2.x, b2.y);
  await zz(450);
  const typed = await page.evaluate(async () => {
    // A VISIBLE, FOCUSABLE CONTROL — `focus()` on something inside a closed
    // panel silently does nothing, and `activeElement` then stays on the body,
    // which makes this check pass for the wrong reason. The grid picker sits on
    // the roll's own toolbar, beside the mode picker.
    const inp = document.querySelector('.v2-layer .v2-gridpick');
    if (!inp) return { skipped: true };
    inp.focus();
    const L = (_masterEng.getCfg().layers || [])[0];
    return { skipped: false, took: document.activeElement === inp,
             tag: document.activeElement && document.activeElement.tagName,
             before: (L.part.notes || []).map((n) => n.midi | 0) };
  });
  await key('ArrowUp', 'Shift');
  const afterField = await snap();
  ok('a focused field keeps its own ⇧ + arrow',
    !typed.skipped && typed.took &&
    JSON.stringify(afterField.notes.map((n) => n.m)) === JSON.stringify(typed.before),
    JSON.stringify({ took: typed.took, tag: typed.tag,
                     before: typed.before, after: afterField.notes.map((n) => n.m) }));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
