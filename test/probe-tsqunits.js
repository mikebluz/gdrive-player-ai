// PROBE — ◇ TONE SET: a unit per row (bar · change · part), whole or fractional.
//
// user, 2026-09-27: "we need to have Tone in Tone Set to Part (and sub part) mapping;
// also Bar and Change both need to be schedulable (on/off)" — clarified as "wherever
// scheduling is happening, Bar and Change (whole or fractional) should be optional
// units to express scheduling in", with the unit on the ROW.
//
// The three things this has to get right:
//   · a set written before units resolves through the ORIGINAL arithmetic (golden);
//   · a CHANGE row is measured against the real chords — never a bar average, or a
//     "2 changes" row slides off the changes it is named after on an uneven cadence;
//   · a PART row is an ANSWER, not a turn in the queue: it wins while that part plays,
//     optionally narrowed to a window inside it stated in changes (fractions allowed).
//
//   node test/probe-tsqunits.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(800);

  // ---- THE CLOCKS, ON A FIXTURE THAT PROVES ITSELF ----------------------------
  console.log('\n  ◇ the row’s unit');
  const clocks = await page.evaluate(() => {
    const E = _masterEng; _E = E;
    const c = E.getCfg();
    const CH = (root, bars) => ({ root, intervals: [0, 4, 7], bars });
    c.prog.on = true;
    c.barsPerChord = 1;
    // TWO PARTS, and an UNEVEN cadence inside each: change 0 is one bar, change 1 is
    // three. An average would put the boundary in the wrong place on every lap.
    c.prog.chords = [CH(0, 1), CH(5, 3), CH(7, 1), CH(2, 3)];
    c.prog.parts = [{ name: 'A', len: 2 }, { name: 'B', len: 2 }];
    E.getCfg();
    const cfg = E.getCfg();
    const T0 = 1000;
    E._barGridAnchor = T0; E._progAnchor = T0; E._playStartAt = T0; E._t0 = T0;
    const barSec = (60 / Math.max(20, _ambBpm())) * 4;
    const atBar = (b) => T0 + b * barSec + barSec * 0.02;      // a hair inside the bar
    // PROVE THE FIXTURE: the chord clock must really walk 1·3·1·3 bars.
    const steps = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => _ambProgStepAt(E, atBar(b)) | 0);
    const mk = (arr) => ({ toneSeq: { on: 1, steps: arr }, tone: 'zz', id: 'v2:9' });
    const read = (inst, bars) => bars.map((b) => _ambToneAt(inst, atBar(b)));

    // 1 — PLAIN: no unit anywhere, whole bars. The original path.
    const plain = mk([{ tone: 'sine', bars: 1 }, { tone: 'square', bars: 1 }, { tone: 'sawtooth', bars: 1 }]);
    const plainOut = read(plain, [0, 1, 2, 3, 4]);
    const isPlain = _ambToneSeqPlain(plain.toneSeq);

    // 2 — CHANGES: one change per row, against the 1·3·1·3 cadence.
    const chg = mk([{ tone: 'sine', unit: 'chg', bars: 1 }, { tone: 'square', unit: 'chg', bars: 1 }]);
    const chgOut = read(chg, [0, 1, 2, 3, 4, 5, 6, 7]);

    // 3 — FRACTIONAL BARS: half a bar each, so the pair fills one bar.
    const half = mk([{ tone: 'sine', bars: 0.5 }, { tone: 'square', bars: 0.5 }]);
    const halfOut = [0, 0.25, 0.5, 0.75, 1, 1.5].map((b) => _ambToneAt(half, atBar(b)));

    // 4 — A PART ROW WINS while its part plays, and the cycle carries the rest.
    const part = mk([{ tone: 'sine', bars: 1 }, { tone: 'square', bars: 1 },
                     { tone: 'organ', unit: 'part', part: 1 }]);
    const partWhere = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({
      b, pi: (_ambPartChordAt(E, cfg, atBar(b)) || {}).pi, t: _ambToneAt(part, atBar(b)) }));

    // 5 — A WINDOW INSIDE THE PART, in changes, fractional: the SECOND HALF of
    //     change 0 of part B (part B's change 0 is one bar long).
    const win = mk([{ tone: 'sine', bars: 1 },
                    { tone: 'organ', unit: 'part', part: 1, at: 0.5, len: 0.5 }]);
    const winOut = [4, 4.25, 4.55, 4.75, 5, 5.5].map((b) => ({ b, t: _ambToneAt(win, atBar(b)) }));

    return { barSec, steps, isPlain, plainOut, chgOut, halfOut, partWhere, winOut };
  });

  ok('the fixture’s chord clock really walks an uneven cadence',
    JSON.stringify(clocks.steps) === '[0,1,1,1,2,3,3,3]', JSON.stringify(clocks.steps));
  ok('a set with no unit is still the ORIGINAL path',
    clocks.isPlain === true && JSON.stringify(clocks.plainOut) === '["sine","square","sawtooth","sine","square"]',
    JSON.stringify(clocks.plainOut));
  // 1 change = 1 bar, then 3 bars, then 1, then 3 — an average would flip every 2.
  ok('a CHANGE row lasts one change, however long that change is',
    JSON.stringify(clocks.chgOut) === '["sine","square","square","square","sine","square","square","square"]',
    JSON.stringify(clocks.chgOut));
  ok('a FRACTIONAL bar count is a real extent — half a bar each',
    JSON.stringify(clocks.halfOut) === '["sine","sine","square","square","sine","square"]',
    JSON.stringify(clocks.halfOut));
  const pw = clocks.partWhere || [];
  ok('the fixture really changes part', pw.some((x) => x.pi === 0) && pw.some((x) => x.pi === 1),
    JSON.stringify(pw));
  ok('a PART row plays wherever that part plays…',
    pw.filter((x) => x.pi === 1).every((x) => x.t === 'organ'), JSON.stringify(pw));
  ok('…and nowhere else — the cycle keeps the rest',
    pw.filter((x) => x.pi === 0).every((x) => x.t === 'sine' || x.t === 'square'), JSON.stringify(pw));
  const wo = clocks.winOut || [];
  ok('a FRACTIONAL window covers half a change and no more',
    wo.find((x) => x.b === 4.55).t === 'organ' && wo.find((x) => x.b === 4.75).t === 'organ' &&
    wo.find((x) => x.b === 4).t !== 'organ' && wo.find((x) => x.b === 4.25).t !== 'organ' &&
    wo.find((x) => x.b === 5).t !== 'organ',
    JSON.stringify(wo));

  // ---- THE STORE -------------------------------------------------------------
  // A LAYER FIRST — a v2 layer has its own normalizer, which is exactly where the
  // second copy of this coercion lived.
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click(); });
  await zz(900);
  console.log('\n  ◇ what the normalizer keeps');
  const norm = await page.evaluate(() => {
    const E = _masterEng; _E = E;
    const c = E.getCfg();
    if (!c.layers || !c.layers.length) return { err: 'no layer' };
    const L = c.layers[0];
    L.toneSeq = { on: 1, steps: [
      { tone: 'sine', bars: '0.5' },
      { tone: 'square', unit: 'chg', bars: 2 },
      { tone: 'organ', unit: 'part', part: 1, at: '0.5', len: '0.5', bars: 4 },
      { tone: 'pad', unit: 'part', part: 0 },
    ] };
    const c2 = E.getCfg();
    return { steps: c2.layers[0].toneSeq.steps };
  });
  ok('a layer exists to hold a set', !norm.err, JSON.stringify(norm));
  ok('a fractional count survives the normalizer',
    !norm.err && norm.steps[0].bars === 0.5 && norm.steps[0].unit === undefined, JSON.stringify(norm.steps));
  ok('a change row keeps its unit and its count',
    !norm.err && norm.steps[1].unit === 'chg' && norm.steps[1].bars === 2, JSON.stringify(norm.steps));
  ok('a part row keeps part/at/len and DROPS the count it cannot use',
    !norm.err && norm.steps[2].unit === 'part' && norm.steps[2].part === 1 &&
    norm.steps[2].at === 0.5 && norm.steps[2].len === 0.5 && norm.steps[2].bars === undefined,
    JSON.stringify(norm.steps));
  ok('…and an unwindowed part row stays ABSENT by default',
    !norm.err && norm.steps[3].at === undefined && norm.steps[3].len === undefined,
    JSON.stringify(norm.steps));

  // ---- THE CONTROLS, IN THE CARD THE USER HAS OPEN ---------------------------
  console.log('\n  ◇ the row in the card');
  const built = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    const c = E.getCfg(); const L = (c.layers || [])[0];
    L.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 1 }, { tone: 'square', unit: 'chg', bars: 2 }] };
    E.getCfg();
    try { _ambRebuildMaster(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 900));
    // the Tone set lives in the layer card's Instrument group — open the card and
    // the group, because a control inside something collapsed reads as missing.
    const card = document.querySelector('.v2-layer');
    if (!card) return { err: 'no card' };
    card.classList.remove('collapsed');
    [...card.querySelectorAll('.ambient-grp')].forEach((g) => g.classList.add('open'));
    await new Promise((r) => setTimeout(r, 300));
    const box = card.querySelector('.ambient-toneseq-box');
    if (!box) return { err: 'no tone set box' };
    const rows = [...box.querySelectorAll('.ambient-toneseq-step')];
    const u0 = rows[0] && rows[0].querySelector('select.tsq-unit');
    const r0 = u0 ? u0.getBoundingClientRect() : null;
    return {
      rows: rows.length,
      units: rows.map((r) => { const u = r.querySelector('select.tsq-unit'); return u ? u.value : null; }),
      opts: u0 ? [...u0.options].map((o) => o.value) : [],
      reach: !!(u0 && u0.offsetParent && r0.width > 40 && r0.height > 14),
      w: r0 ? Math.round(r0.width) : -1,
      // the row must not push the card sideways at 390 (the standing rule)
      overflow: Math.max(...rows.map((r) => r.scrollWidth - r.clientWidth)),
      sum: (box.querySelector('.tsq-sum') || {}).textContent || '',
    };
  });
  ok('every row carries its own unit', !built.err && built.rows === 2 &&
    JSON.stringify(built.units) === '["bar","chg"]', JSON.stringify(built));
  ok('…offering bar · change · part where parts exist',
    JSON.stringify(built.opts) === '["bar","chg","part"]', JSON.stringify(built.opts));
  ok('…measurable in the card the user has open, not just present in the DOM',
    built.reach === true, JSON.stringify([built.reach, built.w]));
  ok('…and the row does not overflow at 390px', built.overflow <= 0, String(built.overflow));
  ok('the header says which clocks are running', /bars and changes/.test(built.sum || ''),
    JSON.stringify(built.sum));

  // SWITCHING THE UNIT REWRITES THE ROW — a leftover count would be a store saying
  // two things at once.
  const switched = await page.evaluate(async () => {
    const E = _masterEng;
    const card = document.querySelector('.v2-layer');
    const sel = card.querySelector('.ambient-toneseq-step[data-tsi="0"] select.tsq-unit');
    if (!sel) return { err: 'no unit select' };
    sel.value = 'part';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const st = E.getCfg().layers[0].toneSeq.steps[0];
    const box = card.querySelector('.ambient-toneseq-box');
    const prow = box.querySelector('.ambient-toneseq-step[data-tsi="0"] .tsq-partrow');
    const psel = prow && prow.querySelector('select.tsq-partsel');
    const at = prow && prow.querySelector('input[data-tsw="at"]');
    const r = prow ? prow.getBoundingClientRect() : null;
    // …and the window writes through
    if (at) { at.value = '0.5'; at.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise((r2) => setTimeout(r2, 150));
    const st2 = E.getCfg().layers[0].toneSeq.steps[0];
    // …and blanking it puts the row back to "the whole part"
    if (at) { at.value = ''; at.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise((r2) => setTimeout(r2, 150));
    const st3 = E.getCfg().layers[0].toneSeq.steps[0];
    return { unit: st.unit, part: st.part, bars: st.bars,
             partRow: !!(prow && prow.offsetParent && r.width > 100),
             parts: psel ? psel.options.length : 0,
             at2: st2.at, at3: st3.at };
  });
  ok('switching a row to Part rewrites it — unit, a part, no leftover count',
    !switched.err && switched.unit === 'part' && Number.isFinite(switched.part) && switched.bars === undefined,
    JSON.stringify(switched));
  ok('…and its own line comes up with the parts in it',
    switched.partRow === true && switched.parts >= 2, JSON.stringify(switched));
  ok('…the window writes through as changes',
    switched.at2 === 0.5, JSON.stringify(switched));
  ok('…and blank means THE WHOLE PART, not zero',
    switched.at3 === undefined, JSON.stringify(switched));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
