// PROBE \u2014 \u25c7 TONE SET: choosing a voice, and doubling it.
//
// user, 2026-09-26: "use a Tone Set to stochastically choose which instrument is
// playing (or even at the same time, same content) \u2026 one param for which Tone to
// play, and one param for how many to play at once, as first param increases it
// chooses more Tones from the Tone Set, and second param as it increases, more
// often playing more than 1 voice at once, have user set a maximum voices at once
// (cap at 3 for now)".
//
// The primitive already existed and was already called Tone set: `L.toneSeq =
// { on, steps: [{ tone, bars }] }`, resolved per note onset by `_ambToneAt` off the
// bar clock. What it could not do was CHOOSE (position decided) or return more than
// one voice. So:
//   \u25c7 Palette (`pal`) \u2014 how much of the set is eligible. 0 = the positional cycle,
//     unchanged and byte-identical. Higher opens the list from the top, and a hash
//     picks per cycle lap. The set is therefore ordered by priority.
//   \u25c7 Doubling (`dub`) \u2014 how OFTEN more than one voice sounds on a note, capped by
//     `maxV` (2\u20133; 1 prunes, because "never" is what dub 0 already says).
// Both deterministic through `_ambChordHash01` \u2014 zero shared-RNG draws, so a layer
// that sets neither is bit-identical and golden stays honest.
//
//   node test/probe-toneset.js        (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '\n      ' + detail : '')); }
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
  await zz(500);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    b.scrollIntoView({ block: 'center' }); b.click(); });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click(); });
  await zz(600);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(700);

  // ---- 1. THE RESOLVER IS PURE, so assert on it directly ----------------------
  console.log('\n  1. \u25c7 Palette — the cycle becomes a choice');
  const res = await page.evaluate(() => {
    // a four-voice set, one bar each, so bar N is step N
    const mk = (extra) => Object.assign({ on: 1, steps: [
      { tone: 'a', bars: 1 }, { tone: 'b', bars: 1 }, { tone: 'c', bars: 1 }, { tone: 'd', bars: 1 }] }, extra || {});
    const barSec = (60 / 120) * 4;
    // the resolver reads the engine's bar anchor; pin it so the probe owns the clock
    _masterEng._barGridAnchor = 0;
    window._E = _masterEng;
    const walk = (q, n) => { const out = [];
      for (let i = 0; i < n; i++) out.push(_ambToneAt({ toneSeq: q, tone: 'z', id: 'v2:1' }, i * barSec + 0.01));
      return out.join(''); };
    return {
      cycle: walk(mk(), 8),
      palOff: walk(mk({ pal: 0 }), 8),
      palLow: walk(mk({ pal: 1 }), 8),
      palMid: walk(mk({ pal: 50 }), 16),
      palFull: walk(mk({ pal: 100 }), 16),
      eligible1: _ambTonePalN(mk({ pal: 1 })),
      eligible50: _ambTonePalN(mk({ pal: 50 })),
      eligible100: _ambTonePalN(mk({ pal: 100 })),
      eligibleOff: _ambTonePalN(mk()),
      onePal: _ambTonePalN({ on: 1, pal: 100, steps: [{ tone: 'a', bars: 1 }] }),
    };
  });
  ok('with no Palette it is the plain bar cycle, step by step',
    res.cycle === 'abcdabcd' && res.palOff === res.cycle, JSON.stringify(res));
  ok('0 eligible means "not choosing at all" — one representation of the old behaviour',
    res.eligibleOff === 0, String(res.eligibleOff));
  ok('the dial opens the list from the top: 1 of 4, then 3, then all 4',
    res.eligible1 === 1 && res.eligible50 === 3 && res.eligible100 === 4,
    JSON.stringify([res.eligible1, res.eligible50, res.eligible100]));
  ok('at the lowest setting only the FIRST voice is eligible, so the set stops moving',
    /^a+$/.test(res.palLow), JSON.stringify(res.palLow));
  ok('mid-dial draws from the top three and never the fourth',
    !/d/.test(res.palMid) && /a/.test(res.palMid) && /b|c/.test(res.palMid), JSON.stringify(res.palMid));
  ok('full uses every voice, and is not the positional walk',
    /a/.test(res.palFull) && /d/.test(res.palFull) && res.palFull.slice(0, 8) !== 'abcdabcd',
    JSON.stringify(res.palFull));
  ok('a one-entry set is not a palette — nothing to choose from',
    res.onePal === 0, String(res.onePal));

  // ---- 2. DOUBLING -----------------------------------------------------------
  console.log('\n  2. \u25c7 Doubling — how often more than one sounds at once');
  const dub = await page.evaluate(() => {
    const mk = (extra) => Object.assign({ on: 1, steps: [
      { tone: 'a', bars: 1 }, { tone: 'b', bars: 1 }, { tone: 'c', bars: 1 }, { tone: 'd', bars: 1 }] }, extra || {});
    const barSec = (60 / 120) * 4;
    _masterEng._barGridAnchor = 0; window._E = _masterEng;
    // 240 onsets spread over the cycle, a sixteenth apart
    const hist = (q) => { const h = {};
      for (let i = 0; i < 240; i++) {
        const x = _ambToneStackAt({ toneSeq: q, tone: 'z', id: 'v2:1' }, i * (barSec / 16) + 0.001);
        const n = 1 + x.length; h[n] = (h[n] | 0) + 1;
      }
      return h; };
    const lead = (q, at) => _ambToneAt({ toneSeq: q, tone: 'z', id: 'v2:1' }, at);
    const dupes = (() => { // an extra must never repeat the lead
      const q = mk({ pal: 100, dub: 100, maxV: 3 }); let bad = 0;
      for (let i = 0; i < 240; i++) { const at = i * (barSec / 16) + 0.001;
        const x = _ambToneStackAt({ toneSeq: q, tone: 'z', id: 'v2:1' }, at);
        const l = lead(q, at);
        if (x.indexOf(l) >= 0) bad++;
        if (new Set(x).size !== x.length) bad++;
      }
      return bad; })();
    return { off: hist(mk()), zero: hist(mk({ dub: 0 })), half: hist(mk({ dub: 50, maxV: 3 })),
             full: hist(mk({ dub: 100, maxV: 3 })), cap2: hist(mk({ dub: 100, maxV: 2 })),
             oneStep: _ambToneStackAt({ toneSeq: { on: 1, dub: 100, steps: [{ tone: 'a', bars: 1 }] }, tone: 'z', id: 'v2:1' }, 0.01).length,
             dupes };
  });
  ok('absent or 0 is always ONE voice — the default path is untouched',
    JSON.stringify(dub.off) === '{"1":240}' && JSON.stringify(dub.zero) === '{"1":240}',
    JSON.stringify([dub.off, dub.zero]));
  ok('mid-dial doubles SOME notes and not others', (dub.half['1'] | 0) > 20 && (dub.half['2'] | 0) > 20,
    JSON.stringify(dub.half));
  ok('…and full doubles every note, up to the cap', (dub.full['3'] | 0) === 240, JSON.stringify(dub.full));
  ok('the cap is the ceiling: at 2 no note ever gets a third voice',
    (dub.cap2['2'] | 0) === 240 && !dub.cap2['3'], JSON.stringify(dub.cap2));
  ok('a one-entry set cannot be doubled — a second copy of one voice is a level change',
    dub.oneStep === 0, String(dub.oneStep));
  ok('an extra voice is never the lead, and never a repeat of another extra',
    dub.dupes === 0, String(dub.dupes));

  // ---- 3. DETERMINISM AND ISOLATION ------------------------------------------
  console.log('\n  3. deterministic, and per layer');
  const det = await page.evaluate(() => {
    const q = { on: 1, pal: 100, dub: 60, maxV: 3, steps: [
      { tone: 'a', bars: 1 }, { tone: 'b', bars: 1 }, { tone: 'c', bars: 1 }] };
    const barSec = (60 / 120) * 4;
    _masterEng._barGridAnchor = 0; window._E = _masterEng;
    const run = (id) => { const o = [];
      for (let i = 0; i < 64; i++) { const at = i * (barSec / 8) + 0.001;
        o.push(_ambToneAt({ toneSeq: q, tone: 'z', id }, at) + _ambToneStackAt({ toneSeq: q, tone: 'z', id }, at).join('')); }
      return o.join('|'); };
    return { a1: run('v2:1'), a2: run('v2:1'), b: run('v2:2') };
  });
  ok('the same layer at the same time always draws the same', det.a1 === det.a2);
  ok('…and two layers sharing one set do NOT pick in lockstep', det.a1 !== det.b);

  // ---- 4. THE STORE ----------------------------------------------------------
  console.log('\n  4. the store — additive, and absent by default');
  const store = await page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 4 }, { tone: 'square', bars: 4 }], pal: 0, dub: 0, maxV: 1 };
    const a = JSON.parse(JSON.stringify((E.getCfg().layers || [])[0].toneSeq));
    const L2 = (E.getCfg().layers || [])[0];
    L2.toneSeq.pal = 999; L2.toneSeq.dub = -5; L2.toneSeq.maxV = 9;
    const b = JSON.parse(JSON.stringify((E.getCfg().layers || [])[0].toneSeq));
    return { a, b };
  });
  ok('0 / 0 / cap 1 prune to ABSENT — "not choosing" and "never doubling" have one form',
    store.a.pal === undefined && store.a.dub === undefined && store.a.maxV === undefined,
    JSON.stringify(store.a));
  ok('…and out-of-range values are clamped, not stored raw',
    store.b.pal === 100 && store.b.dub === undefined && store.b.maxV === 3, JSON.stringify(store.b));
  // THE BOX MUST NOT LIE ABOUT THE CAP. A typed 1 prunes to absent and the resolver
  // reads absent as 2, so a control offering 1 displayed one number while the engine
  // played another — caught by asking the ENGINE, not the store.
  const cap = await page.evaluate(async () => {
    // the dials only exist once the SET does, and the card has to have been rendered
    // since — this section sets the store directly, so rebuild before measuring.
    const L9 = (_masterEng.getCfg().layers || [])[0];
    L9.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 4 }, { tone: 'square', bars: 4 }] };
    _masterEng.getCfg();
    try { _ambRebuildMaster(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 700));
    const q = { on: 1, pal: 100, dub: 100, steps: [
      { tone: 'a', bars: 1 }, { tone: 'b', bars: 1 }, { tone: 'c', bars: 1 }] };
    const barSec = (60 / 120) * 4;
    _masterEng._barGridAnchor = 0; window._E = _masterEng;
    const most = (mv) => { const qq = Object.assign({}, q); if (mv != null) qq.maxV = mv;
      let m = 0; for (let i = 0; i < 200; i++)
        m = Math.max(m, 1 + _ambToneStackAt({ toneSeq: qq, tone: 'z', id: 'v2:1' }, i * (barSec / 16) + 0.001).length);
      return m; };
    const box = document.querySelector('.v2-layer .ambient-toneseq-box');
    const inp = box && box.querySelector('[data-tsq="maxv"]');
    const out9 = { absent: most(null), two: most(2), three: most(3),
             shown: inp ? { value: inp.value, min: inp.min, max: inp.max } : null };
    // PUT THE LAYER BACK. §5 below asserts the dials are ABSENT until a set exists, so
    // a fixture left behind here makes the next section fail on state this one created.
    delete (_masterEng.getCfg().layers || [])[0].toneSeq;
    _masterEng.getCfg();
    try { _ambRebuildMaster(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 700));
    return out9;
  });
  ok('the cap offered is 2\u20133 \u2014 "never double" is ◇ Doubling 0, not a cap of 1',
    !!(cap.shown && cap.shown.min === '2' && cap.shown.max === '3'), JSON.stringify(cap.shown));
  ok('…and what the box shows is what the engine plays',
    cap.absent === 2 && Number(cap.shown.value) === cap.absent, JSON.stringify(cap));
  ok('…with 3 reaching three', cap.three === 3 && cap.two === 2, JSON.stringify(cap));

  // ---- 5. REACHABLE ----------------------------------------------------------
  console.log('\n  5. reachable — measured on the card the user has open');
  const ui = await page.evaluate(async () => {
    const c = document.querySelector('.v2-layer');
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-layer-head').click();
    await new Promise((r) => setTimeout(r, 600));
    const b = c.querySelector('.v2-gototab[data-goto="Instrument"]');
    if (!b) return { err: 'no Instrument door' };
    b.click();
    await new Promise((r) => setTimeout(r, 500));
    const tabs = [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')];
    const t = tabs.find((x) => /Tone set/i.test(x.getAttribute('data-tab') || ''));
    if (t) t.click();
    await new Promise((r) => setTimeout(r, 400));
    const box = document.querySelector('.v2-layer .ambient-toneseq-box');
    if (!box) return { err: 'no Tone set box', tabs: tabs.map((x) => x.getAttribute('data-tab')) };
    const add = box.querySelector('.ambient-toneseq-add');
    const dialsBefore = !!box.querySelector('.ambient-toneseq-dials');
    if (add) { add.click(); await new Promise((r) => setTimeout(r, 300)); }
    const box2 = document.querySelector('.v2-layer .ambient-toneseq-box');
    const add2 = box2.querySelector('.ambient-toneseq-add');
    if (add2) { add2.click(); await new Promise((r) => setTimeout(r, 300)); }
    const box3 = document.querySelector('.v2-layer .ambient-toneseq-box');
    const dials = box3.querySelector('.ambient-toneseq-dials');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), on: !!el.offsetParent }; };
    const pal = box3.querySelector('[data-tsq="pal"]');
    const out = { dialsBefore, dials: !!dials, palRect: rect(pal),
      dubDisabled: !!(box3.querySelector('[data-tsq="dub"]') || {}).disabled,
      names: [...box3.querySelectorAll('.ambient-toneseq-dials > label')].map((l) => l.textContent.replace(/[0-9]/g, '').trim()) };
    // drive it for real and read the store back
    if (pal) { pal.value = '100'; pal.dispatchEvent(new Event('input', { bubbles: true })); }
    const dub = box3.querySelector('[data-tsq="dub"]');
    if (dub) { dub.value = '70'; dub.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 350));
    const L = (_masterEng.getCfg().layers || [])[0];
    out.stored = L.toneSeq ? { pal: L.toneSeq.pal, dub: L.toneSeq.dub } : null;
    return out;
  });
  ok('the dials are absent while there is nothing to choose from', ui.dialsBefore === false, JSON.stringify(ui));
  ok('…and appear once the set has two entries', ui.dials === true, JSON.stringify(ui));
  ok('…measuring a real box on the card, not 0×0',
    !!(ui.palRect && ui.palRect.w > 20 && ui.palRect.h > 10 && ui.palRect.on), JSON.stringify(ui.palRect));
  ok('…named so they can be found', JSON.stringify(ui.names || []).indexOf('Palette') >= 0 &&
    JSON.stringify(ui.names || []).indexOf('Doubling') >= 0 &&
    JSON.stringify(ui.names || []).indexOf('Max voices') >= 0, JSON.stringify(ui.names));
  ok('…◇ Doubling is LIVE on a v2 layer, which is where the fan-out is',
    ui.dubDisabled === false, String(ui.dubDisabled));
  ok('…and a real edit reaches the store',
    !!(ui.stored && ui.stored.pal === 100 && ui.stored.dub === 70), JSON.stringify(ui.stored));

  // ---- 6. THE LAYOUT ---------------------------------------------------------
  // (2026-09-27, user: "this Tone Set UI is awful, clean it up and make more user
  // friendly and symmetrical".) It was ONE wrap-flex holding the switch, every voice and
  // the three dials — so the On button sat inline with voice 1 (indenting it differently
  // from 2 and 3), and each row wrapped at whatever width its own select text needed.
  // ALIGNMENT IS THE ASSERTION, not "it looks nicer": every row's select, Bars box and
  // ✕ must start at the SAME x, which is what a flex row with one flexing child buys.
  console.log('\n  6. the layout — rows that line up');
  const lay = await page.evaluate(async () => {
    // a third voice, so a ragged wrap would show
    const add = document.querySelector('.v2-layer .ambient-toneseq-add');
    if (add) { add.click(); await new Promise((r) => setTimeout(r, 350)); }
    // VOICES WITH DIFFERENT-LENGTH NAMES, or this check cannot fail: three selects all
    // reading "— layer default —" line up at their natural width too, so the fixture
    // would pass with the flexing select removed (measured — that is exactly what the
    // first version of this check did).
    {
      const b0 = document.querySelector('.v2-layer .ambient-toneseq-box');
      const sels = [...b0.querySelectorAll('select.ambient-toneseq-tone')];
      const opts = sels[0] ? [...sels[0].options].map((o) => o.value).filter(Boolean) : [];
      // longest and shortest labels we can actually pick, so the widths really differ
      const byLen = [...sels[0].options].filter((o) => o.value)
        .sort((a, b) => b.textContent.length - a.textContent.length).map((o) => o.value);
      sels.forEach((sl, i) => {
        const v = byLen[i === 0 ? 0 : (byLen.length - i)] || opts[i] || '';
        if (!v) return;
        sl.value = v; sl.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 400));
    }
    const box = document.querySelector('.v2-layer .ambient-toneseq-box');
    if (!box) return { err: 'no box' };
    const xs = (sel) => [...box.querySelectorAll('.ambient-toneseq-step')]
      .map((st) => { const n = st.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().x) : -1; });
    const uniq = (a) => a.filter((v, i, z) => z.indexOf(v) === i);
    // the box owns the full row: the switch is a HEADER control, not voice 1's neighbour
    const headY = Math.round((box.querySelector('.tsq-head') || {}).getBoundingClientRect
      ? box.querySelector('.tsq-head').getBoundingClientRect().bottom : 0);
    const firstY = Math.round(((box.querySelector('.ambient-toneseq-step') || {}).getBoundingClientRect
      ? box.querySelector('.ambient-toneseq-step').getBoundingClientRect().top : 0));
    // OVERFLOW: walk the leaves and compare against the PARENT's right edge — never
    // documentElement.scrollWidth, which html/body's overflow-x:hidden makes useless.
    const over = [];
    box.querySelectorAll('*').forEach((n) => {
      if (n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0) over.push('scroll:' + (n.className || n.tagName));
      const p2 = n.parentElement && n.parentElement.getBoundingClientRect();
      const r2 = n.getBoundingClientRect();
      if (p2 && r2.width && r2.right > p2.right + 1) over.push('spill:' + (n.className || n.tagName));
    });
    return { n: box.querySelectorAll('.ambient-toneseq-step').length,
             sel: uniq(xs('select')), bars: uniq(xs('.ambient-toneseq-bars')), del: uniq(xs('.ambient-toneseq-del')),
             dials: [...box.querySelectorAll('.tsq-dial')].map((d) => Math.round(d.getBoundingClientRect().width)),
             ordinals: [...box.querySelectorAll('.tsq-n')].map((n) => n.textContent.trim()),
             sum: (box.querySelector('.tsq-sum') || {}).textContent || '',
             headAboveRows: firstY >= headY - 1, over: over.slice(0, 6) };
  });
  ok('every voice is a row, and the rows LINE UP — one x for the select, Bars and ✕',
    lay.n >= 3 && lay.sel.length === 1 && lay.bars.length === 1 && lay.del.length === 1,
    JSON.stringify([lay.n, lay.sel, lay.bars, lay.del]));
  ok('…the On switch is a HEADER control, on its own line above them',
    lay.headAboveRows === true, JSON.stringify(lay.headAboveRows));
  ok('…the three dials are exactly equal width, and never a ragged last row of one',
    lay.dials.length === 3 && new Set(lay.dials).size === 1, JSON.stringify(lay.dials));
  // 1..n IN ORDER, however many the checks above left behind — the count is not the
  // point, the ORDER is: ◇ Palette opens the list from the top.
  ok('…the voices are NUMBERED 1..n in order, because ◇ Palette opens the list from the top',
    lay.ordinals.length === lay.n &&
    lay.ordinals.every((v, i) => v === String(i + 1)), JSON.stringify(lay.ordinals));
  ok('…the header says what the set is doing, live', /voices/.test(lay.sum) && /cycling|choosing/.test(lay.sum),
    JSON.stringify(lay.sum));
  ok('…and nothing overflows its parent at 390px', JSON.stringify(lay.over) === '[]', JSON.stringify(lay.over));

  // THE SELECTS MUST HAVE OPTIONS IN THEM after a card re-render with no
  // `_ambSyncControls` behind it — they are built EMPTY, and the only sweep that fills
  // them on that path is `_ambRefreshAllToneSelects`, which matches `select[id$="-tone"]`.
  // Dropping that id shipped a Tone set of three BLANK dropdowns.
  const filled = await page.evaluate(async () => {
    // the path with no sync behind it: re-render the card directly
    const h = document.getElementById('bloom-v2-layers');
    if (h) h._sig = '';
    try { window._v2.render(_masterEng); } catch (e) {}
    await new Promise((r) => setTimeout(r, 600));
    const box = document.querySelector('.v2-layer .ambient-toneseq-box');
    if (!box) return { err: 'no box' };
    const sels = [...box.querySelectorAll('select.ambient-toneseq-tone')];
    return { n: sels.length, opts: sels.map((s2) => s2.options.length),
             ids: sels.map((s2) => /-tone$/.test(s2.id || '')) };
  });
  ok('every voice dropdown carries the `-tone` id the catalog sweep matches',
    filled.n > 0 && filled.ids.every(Boolean), JSON.stringify(filled));
  ok('…so they come back FILLED after a render with no sync behind it',
    filled.n > 0 && filled.opts.every((n2) => n2 > 3), JSON.stringify(filled.opts));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
