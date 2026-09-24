// PROBE — ↔ Answer: one layer plays off another.
//
// user, 2026-09-23: "need a way to chain layer content events in successive
// ways" — and, of the readings offered, this one: "layer B fires only where
// layer A rests".
//
// This is the first control on the card that describes a RELATION rather than
// a layer, so it crosses a boundary the file drew deliberately: `notesFor` is
// a pure function of one layer and `vRnd` is isolated per layer. The checks
// below are about that crossing being safe — the right notes survive, a cycle
// cannot hang the draw, and muting the source cannot rewrite the answer.
//
//   node test/probe-answer.js        (needs `npm start`; BLOOPS_URL to retarget)
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

  // TWO layers — the whole feature is about the second one seeing the first.
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
    await zz(500);
    await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
      .find((x) => x.textContent.trim() === 'Layer').click(); });
    await zz(1300);
  }
  const ids = await page.evaluate(() => (_masterEng.getCfg().layers || []).map((l) => l.id | 0));
  console.log('\n  layers: ' + JSON.stringify(ids));
  ok('two layers exist to relate', ids.length >= 2, JSON.stringify(ids));

  // A is sparse and long-ish, B is dense — so "in the gaps" has something to
  // say and the two answers cannot coincide by accident.
  const setup = async () => page.evaluate((ids) => {
    const E = _masterEng;
    const ls = E.getCfg().layers || [];
    const A = ls.find((l) => (l.id | 0) === ids[0]);
    const B = ls.find((l) => (l.id | 0) === ids[1]);
    [A, B].forEach((L) => {
      delete L.part.form; L.part.kind = 'euclid'; L.part.notes = [];
      L.part.bars = 2; L.lenVary = 0; L.accent = 0;
      L.part.shape = Object.assign({}, L.part.shape, { lenShape: '', lenRatio: 40 });
    });
    A.part.rhythm = { kind: 'euclid', steps: 16, pulses: 4, rotate: 0 };
    B.part.rhythm = { kind: 'euclid', steps: 16, pulses: 16, rotate: 0 };
    E.getCfg();
  }, ids);
  await setup();
  await zz(400);

  // ── THE DOOR ────────────────────────────────────────────────────────────
  // A querySelector hit proves nothing; a 0×0 rect is the tell. A CARD OPENS
  // COLLAPSED, and a row inside a collapsed card has no `offsetParent` — which
  // is exactly how this probe first reported the control as unreachable.
  await page.evaluate(() => {
    [...document.querySelectorAll('.v2-layer')].forEach((c) => {
      if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
    });
  });
  await zz(900);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[1]); });
  await zz(1400);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.v2-layer')][1];
    const x = c && c.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !c.classList.contains('v2-gz-2')) x.click();
  });
  await zz(900);
  const door = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.v2-layer')][1];
    const sel = c && c.querySelector('.v2-f[data-f="part.answer.src"]');
    if (!sel) return { there: false };
    const row = sel.closest('.ambient-ctrl');
    const r = row.getBoundingClientRect();
    return { there: true, tag: sel.tagName,
             reachable: r.width > 0 && r.height > 0 && !!sel.offsetParent,
             inView: r.right <= document.documentElement.clientWidth + 1,
             primary: row.classList.contains('v2-primary'),
             opts: [...sel.options].map((o) => o.value), value: sel.value,
             modeRow: !!c.querySelector('.v2-f[data-f="part.answer.mode"]') };
  });
  console.log('  ↔ door: ' + JSON.stringify(door));
  ok('↔ Answer is on screen, sized, and fits 390px',
    door.there && door.reachable && door.inView && door.primary, JSON.stringify(door));
  ok('…off by default, offering the OTHER layer and not itself',
    door.value === '' && door.opts.length === 2 && door.opts.indexOf('') >= 0,
    JSON.stringify(door.opts));
  ok('…and the mode row stays away until there is something to answer',
    door.modeRow === false, JSON.stringify({ modeRow: door.modeRow }));

  // ── DRIVEN BY A REAL EVENT, AND READ BACK FROM THE CONFIG ───────────────
  const picked = await page.evaluate(async (ids) => {
    const c = [...document.querySelectorAll('.v2-layer')][1];
    const sel = c.querySelector('.v2-f[data-f="part.answer.src"]');
    sel.value = String(ids[0]);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    // THE CARD WRITES THE STAGED RECORD, not the committed one — `stagedOf` is
    // the idiom every other v2 probe uses, and reading `getCfg().layers[i]`
    // here answers for a record the card has not touched.
    const V = window._v2;
    const L = V.stagedOf(ids[1]) || (_masterEng.getCfg().layers || [])[1];
    const c2 = [...document.querySelectorAll('.v2-layer')][1];
    return { stored: JSON.parse(JSON.stringify(L.part.answer || null)),
             modeRow: !!c2.querySelector('.v2-f[data-f="part.answer.mode"]') };
  }, ids);
  console.log('  after picking: ' + JSON.stringify(picked));
  ok('picking a source writes it, with gaps implied',
    picked.stored && (picked.stored.src | 0) === ids[0] && picked.stored.mode === undefined,
    JSON.stringify(picked.stored));
  ok('…and the mode row appears on the same tap',
    picked.modeRow === true, JSON.stringify(picked));

  // ── WHAT PLAYS ──────────────────────────────────────────────────────────
  const run = async (mode) => page.evaluate(async (ids, mode) => {
    const E = _masterEng, V = window._v2;
    const ls = E.getCfg().layers || [];
    const A = ls.find((l) => (l.id | 0) === ids[0]);
    const B = ls.find((l) => (l.id | 0) === ids[1]);
    if (mode === null) delete B.part.answer;
    else B.part.answer = { src: ids[0], mode: mode };
    E.getCfg();
    await new Promise((r) => setTimeout(r, 250));
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const ask = (L) => {
      const cyc = V.cycleSec(L, E.getCfg());
      return (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || [])
        .slice().sort((a, b) => a.at - b.at);
    };
    const an = ask(A), bn = ask(B);
    const spans = an.map((n) => [n.at, n.at + Math.max(0, (n.durMs || 0) / 1000)]);
    const inA = (t) => spans.some((sp) => t >= sp[0] && t < sp[1]);
    return { aN: an.length, bN: bn.length,
             overlapping: bn.filter((n) => inA(n.at)).length,
             clear: bn.filter((n) => !inA(n.at)).length };
  }, ids, mode);

  const plain = await run(null);
  const gaps = await run('gaps');
  const hits = await run('hits');
  console.log('  off:  ' + JSON.stringify(plain));
  console.log('  gaps: ' + JSON.stringify(gaps));
  console.log('  hits: ' + JSON.stringify(hits) + '\n');

  ok('with Answer off the layer plays its whole part',
    plain.bN > 0 && plain.overlapping > 0 && plain.clear > 0, JSON.stringify(plain));
  // THE ACTUAL REQUEST: "layer B fires only where layer A rests".
  ok('In the gaps — every surviving note falls where the other is silent',
    gaps.bN > 0 && gaps.overlapping === 0 && gaps.clear === gaps.bN,
    JSON.stringify(gaps));
  ok('…and it really removed something, rather than passing everything',
    gaps.bN < plain.bN, JSON.stringify({ off: plain.bN, gaps: gaps.bN }));
  // THE MIRROR, which is the same predicate the other way up.
  ok('On the hits — every surviving note falls where the other sounds',
    hits.bN > 0 && hits.clear === 0 && hits.overlapping === hits.bN,
    JSON.stringify(hits));
  ok('…and the two modes partition the part between them',
    gaps.bN + hits.bN === plain.bN,
    JSON.stringify({ off: plain.bN, gaps: gaps.bN, hits: hits.bN }));

  // ── A CYCLE MUST NOT HANG THE DRAW ──────────────────────────────────────
  // A answers B while B answers A is two taps away, and unguarded it recurses
  // until the stack gives out — inside a try/catch, which would read as the
  // layer silently going quiet rather than as a crash.
  const cyc = await page.evaluate(async (ids) => {
    const E = _masterEng, V = window._v2;
    const ls = E.getCfg().layers || [];
    const A = ls.find((l) => (l.id | 0) === ids[0]);
    const B = ls.find((l) => (l.id | 0) === ids[1]);
    A.part.answer = { src: ids[1], mode: 'gaps' };
    B.part.answer = { src: ids[0], mode: 'gaps' };
    E.getCfg();
    await new Promise((r) => setTimeout(r, 250));
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const t0 = Date.now();
    let n = -1;
    try {
      const cy = V.cycleSec(A, E.getCfg());
      n = (V.withEdit(() => V.withTake(0, () => V.notesFor(A,
        { E, cfg: E.getCfg(), key: 'v2:' + A.id, cycleStart: 0, cycleSec: cy }))) || []).length;
    } catch (e) { return { err: String(e && e.message || e) }; }
    return { ms: Date.now() - t0, n };
  }, ids);
  console.log('  A↔B cycle: ' + JSON.stringify(cyc));
  ok('a mutual answer resolves instead of recursing',
    !cyc.err && cyc.n >= 0 && cyc.ms < 2000, JSON.stringify(cyc));

  // ── MUTING THE SOURCE IS NOT A COMPOSITIONAL CHANGE ─────────────────────
  // Soloing one layer to listen to it must not silently rewrite another.
  const muted = await page.evaluate(async (ids) => {
    const E = _masterEng, V = window._v2;
    const ls = E.getCfg().layers || [];
    const A = ls.find((l) => (l.id | 0) === ids[0]);
    const B = ls.find((l) => (l.id | 0) === ids[1]);
    delete A.part.answer;
    B.part.answer = { src: ids[0], mode: 'gaps' };
    E.getCfg();
    const ask = () => {
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const L = (E.getCfg().layers || []).find((l) => (l.id | 0) === ids[1]);
      const cy = V.cycleSec(L, E.getCfg());
      return (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: cy }))) || []).length;
    };
    const before = ask();
    A.on = false; E.getCfg();
    await new Promise((r) => setTimeout(r, 200));
    const after = ask();
    A.on = true; E.getCfg();
    return { before, after };
  }, ids);
  console.log('  source muted: ' + JSON.stringify(muted));
  ok('muting the source does not rewrite the answer',
    muted.before > 0 && muted.before === muted.after, JSON.stringify(muted));

  // ── ADDITIVE AND ABSENT BY DEFAULT ──────────────────────────────────────
  const pruned = await page.evaluate(async (ids) => {
    const E = _masterEng;
    const B = (E.getCfg().layers || []).find((l) => (l.id | 0) === ids[1]);
    B.part.answer = { src: 0, mode: 'gaps' };
    E.getCfg();
    const b2 = (E.getCfg().layers || []).find((l) => (l.id | 0) === ids[1]);
    const offStored = ('answer' in b2.part);
    b2.part.answer = { src: ids[0], mode: 'hits', bogus: 7 };
    E.getCfg();
    const b3 = (E.getCfg().layers || []).find((l) => (l.id | 0) === ids[1]);
    return { offStored, kept: JSON.parse(JSON.stringify(b3.part.answer || null)) };
  }, ids);
  console.log('  pruning: ' + JSON.stringify(pruned) + '\n');
  ok('Answer off stores no field at all',
    pruned.offStored === false, JSON.stringify(pruned));
  ok('…and an unknown key never survives normalize',
    pruned.kept && pruned.kept.src === ids[0] && pruned.kept.mode === 'hits' &&
    !('bogus' in pruned.kept), JSON.stringify(pruned.kept));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
