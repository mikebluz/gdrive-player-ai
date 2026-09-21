// PROBE — ♪ Lines are first-class: their own section, their own settings per
// change, and Evolve governs them like everything else.
//
// user: "these Lines needs to be promoted to first class items in the model,
// so should be editable and customizable, with stochastic generation hooked
// into evolve etc, also they don't feel right in Repeats they seem hidden
// there, they should be in like an Accompaniment section"
//
// Three claims, measured here:
//   1. the overlay lives under its own ♪ Lines tab, not at the bottom of
//      "Repeats" — and the tab is a real target, not a 0×0 one
//   2. a change that lights its own line can SHAPE it there: six knobs, each
//      inheriting the part's until it is moved, and ↺ Follow puts it back
//   3. Evolve reaches the line — narrowing a change to rhythm only HOLDS the
//      line's pitches, which before this read `seedBase` flat and re-rolled
//
//   node test/probe-lines.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 4, intervals: [0, 3, 7] },
                       { root: 5, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.notes = []; E.getCfg();
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'comp');
    E.getCfg(); window._v2.render(E);
  });
  await zz(900);
  await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    if (card.classList.contains('collapsed')) card.querySelector('.ambient-collapse').click();
  });
  await zz(1000);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  // ✦ GENERATE OPENS FOLDED — a control inside a shut zone lays out at 0×0,
  // which reads as missing. Open zone 3 before reaching for its tabs.
  await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const b = card.querySelector('.v2-gzbar[data-gz="3"]');
    if (b && !card.classList.contains('v2-gz-3')) { b.scrollIntoView({ block: 'center' }); b.click(); }
  });
  await zz(700);

  // ── 1. THE SECTION ──────────────────────────────────────────────────────
  const tabs = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    return [...card.querySelectorAll('.v2-fttab')].map((t) => {
      const r = t.getBoundingClientRect();
      return { k: t.getAttribute('data-ft'), lab: (t.querySelector('.v2-ftlab') || {}).textContent || '',
               w: Math.round(r.width), h: Math.round(r.height), off: !!t.offsetParent };
    });
  });
  console.log('\n  fine-tune tabs: ' + tabs.map((t) => t.k + ' ' + t.w + '×' + t.h).join(' · ') + '\n');
  const acc = tabs.find((t) => t.k === 'accomp');
  ok('Fine-tune carries a ♪ Lines tab', !!acc, JSON.stringify(tabs.map((t) => t.k)));
  ok('…and it is a real target, not a 0×0 one',
    !!acc && acc.off && acc.w >= 44 && acc.h >= 44, JSON.stringify(acc));

  // press it as a person would
  {
    const box = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-fttab[data-ft="accomp"]'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    if (box && box.w > 0) await page.touchscreen.tap(box.x, box.y);
    await zz(900);
  }

  const where = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const row = card.querySelector('.v2-gwparts');
    const r = row ? row.getBoundingClientRect() : null;
    return {
      cls: row ? [...row.classList] : null,
      w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
      off: !!(row && row.offsetParent),
      formRows: [...card.querySelectorAll('.ambient-ctrl.v2-ft-form')]
        .map((e) => ((e.querySelector('label') || {}).textContent || '').trim()),
    };
  });
  console.log('  Changes panel: ' + where.w + '×' + where.h + '   classes: ' + (where.cls || []).join(' '));
  console.log('  "Repeats" now holds: ' + where.formRows.join(' · ') + '\n');
  ok('the Changes overlay is filed under ♪ Lines', !!where.cls && where.cls.indexOf('v2-ft-accomp') >= 0,
    JSON.stringify(where.cls));
  ok('…and no longer under Repeats',
    !!where.cls && where.cls.indexOf('v2-ft-form') < 0 && where.formRows.indexOf('Changes') < 0,
    JSON.stringify({ cls: where.cls, formRows: where.formRows }));
  ok('…and it is on screen with the tab open', where.off && where.w > 100 && where.h > 40,
    JSON.stringify(where));

  // A TAB IS HIDDEN BY NAME in the stylesheet, one selector per tab, so a new
  // one that is not listed there shows under EVERY tab — silently, and only on
  // the tabs it does not belong to. Checked by opening a neighbour.
  const leak = await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const t = card.querySelector('.v2-fttab[data-ft="rhythm"]');
    if (t) t.click();
    const row = card.querySelector('.v2-gwparts');
    const r = row ? row.getBoundingClientRect() : null;
    return { w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0, off: !!(row && row.offsetParent) };
  });
  await zz(500);
  ok('…and it stays put when another tab is open', leak.off === false || (leak.w === 0 && leak.h === 0),
    JSON.stringify(leak));
  await page.evaluate(() => {
    const t = document.querySelector('.v2-layer .v2-fttab[data-ft="accomp"]'); if (t) t.click();
  });
  await zz(700);

  // ── 2. A CHANGE'S OWN LINE IS EDITABLE ──────────────────────────────────
  // Lit under a real finger: the press is what seeds the part's kind, and a
  // test that writes the store instead steps over the thing it is checking.
  {
    const box = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-gwcell[data-gwci="0"] .v2-gwmel'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    if (box && box.w > 0) await page.touchscreen.tap(box.x, box.y);
    await zz(1200);
  }

  const shape = () => page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const row = card.querySelector('.v2-gwclrow[data-gwci="0"]');
    const r = row ? row.getBoundingClientRect() : null;
    const V = window._v2, E = _masterEng;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const g = L.part.ground || {};
    return {
      row: !!row, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
      off: !!(row && row.offsetParent),
      fields: row ? [...row.querySelectorAll('[data-f]')].map((e) => e.getAttribute('data-f').split('.').pop()) : [],
      vals: row ? Object.fromEntries([...row.querySelectorAll('[data-f]')]
        .map((e) => [e.getAttribute('data-f').split('.').pop(), e.value])) : {},
      ownMel: ((g.chords || {})['0'] || {}).mel || null,
      partMel: ((g.parts || {})['0'] || {}).mel || null,
      follow: (() => { const b = row && row.querySelector('.v2-gwcfollow');
        return b ? { on: b.classList.contains('on'), dis: !!b.disabled } : null; })(),
    };
  });

  const s0 = await shape();
  console.log('  change 0’s line row: ' + s0.w + '×' + s0.h + '   fields: ' + s0.fields.join(' · '));
  console.log('  inherited values: ' + JSON.stringify(s0.vals));
  console.log('  stored at the change: ' + JSON.stringify(s0.ownMel) +
              '   at the part: ' + JSON.stringify(s0.partMel) + '\n');
  ok('a change that lights its own line gets its own settings row',
    s0.row && s0.off && s0.w > 100 && s0.h > 20, JSON.stringify({ row: s0.row, w: s0.w, h: s0.h, off: s0.off }));
  ok('…carrying all six of a line’s knobs',
    ['rate', 'kind', 'oct', 'len', 'vel', 'span'].every((f) => s0.fields.indexOf(f) >= 0),
    JSON.stringify(s0.fields));
  // ABSENT IS INHERIT. Opening the panel must not PIN the change to the
  // numbers it happens to be showing — that would silently cut it off from
  // the part's line the first time anyone looked at it.
  ok('…which store nothing until they are moved — the change still says only “on”',
    !!s0.ownMel && Object.keys(s0.ownMel).join(',') === 'on' && s0.ownMel.on === 1,
    JSON.stringify(s0.ownMel));
  ok('…and ↺ Follow is inert while there is nothing to put back',
    !!s0.follow && s0.follow.dis === true && s0.follow.on === false, JSON.stringify(s0.follow));

  // MOVE ONE KNOB, as a person would, and measure what SOUNDS.
  const melOver = () => page.evaluate(() => {
    const V = window._v2, E = _masterEng;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 6 }))) || [];
    const mel = ns.filter((n) => n && n.mel);
    const midi = (n) => Math.round(69 + 12 * Math.log2((n.freq || 440) / 440));
    // the first change occupies the first third of the cycle
    const first = mel.filter((n) => n.at < 2 - 1e-6);
    return { total: mel.length, first: first.length,
             spread: first.length ? Math.max(...first.map(midi)) - Math.min(...first.map(midi)) : 0 };
  });

  const m0 = await melOver();
  await page.evaluate(() => {
    const el = document.querySelector('.v2-layer .v2-gwclrow[data-gwci="0"] [data-f$="mel.rate"]');
    el.value = '9';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(900);
  const s1 = await shape();
  const m1 = await melOver();
  console.log('  line notes over change 0 — inherited ' + m0.first + ', after Notes→9 ' + m1.first + '\n');
  ok('moving the change’s Notes writes it at the CHANGE, not the part',
    !!s1.ownMel && s1.ownMel.rate === 9 && !(s1.partMel && s1.partMel.rate === 9),
    JSON.stringify({ own: s1.ownMel, part: s1.partMel }));
  ok('…and that many notes actually sound over that change',
    m1.first === 9 && m0.first === 4, JSON.stringify({ before: m0.first, after: m1.first }));
  ok('…and ↺ Follow lights up, with something to put back',
    !!s1.follow && s1.follow.on === true && s1.follow.dis === false, JSON.stringify(s1.follow));

  // RANGE — the field a line had no way to state at all before.
  await page.evaluate(() => {
    const row = document.querySelector('.v2-layer .v2-gwclrow[data-gwci="0"]');
    const k = row.querySelector('[data-f$="mel.kind"]');
    k.value = 'walk'; k.dispatchEvent(new Event('input', { bubbles: true })); k.dispatchEvent(new Event('change', { bubbles: true }));
    const el = row.querySelector('[data-f$="mel.span"]');
    el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(800);
  const narrow = await melOver();
  await page.evaluate(() => {
    const el = document.querySelector('.v2-layer .v2-gwclrow[data-gwci="0"] [data-f$="mel.span"]');
    el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(800);
  const wide = await melOver();
  console.log('  Range 1 → ' + narrow.spread + ' semitones of movement;  Range 12 → ' + wide.spread + '\n');
  ok('Range is a real knob — a wide line roams further than a narrow one',
    wide.spread > narrow.spread, JSON.stringify({ narrow: narrow.spread, wide: wide.spread }));

  // ↺ FOLLOW puts every one of them back, and leaves the line lit.
  {
    const box = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-gwclrow[data-gwci="0"] .v2-gwcfollow'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    if (box && box.w > 0) await page.touchscreen.tap(box.x, box.y);
    await zz(1100);
  }
  const s2 = await shape();
  const m2 = await melOver();
  ok('↺ Follow drops what the change said and keeps the line lit',
    !!s2.ownMel && Object.keys(s2.ownMel).join(',') === 'on' && s2.ownMel.on === 1,
    JSON.stringify(s2.ownMel));
  ok('…and the line goes back to the part’s shape',
    m2.first === m0.first, JSON.stringify({ back: m2.first, was: m0.first }));

  // ── 3. EVOLVE REACHES THE LINE ──────────────────────────────────────────
  // A line over EVERY change, so there is plenty to measure, then the same
  // four passes read at three Evolve settings.
  const evo = await page.evaluate(() => {
    const V = window._v2, E = _masterEng;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    {
      const L = Lat();
      const g = L.part.ground || (L.part.ground = {});
      (g.parts || (g.parts = {}))['0'] = { mel: { on: 1, kind: 'walk', rate: 6 } };
      if (g.chords) delete g.chords['0'];
      E.getCfg();
    }
    const midi = (n) => Math.round(69 + 12 * Math.log2((n.freq || 440) / 440));
    // THE LINE'S NOTE TIMES DO NOT MOVE with the roll — they come from the
    // chord spans and the line's own rate — so a pass can be compared to the
    // one before it slot for slot, which is what "kept" has to mean.
    const passLine = (p) => {
      const L = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: p * 6, cycleSec: 6 })) || [];
      const m = {};
      ns.filter((n) => n && n.mel).forEach((n) => { m[Math.round((n.at - p * 6) * 1000)] = midi(n); });
      return m;
    };
    const keptPc = (chg) => {
      const L = Lat();
      if (chg) L.chg = chg; else delete L.chg;
      E.getCfg();
      let same = 0, tot = 0;
      for (let p = 1; p <= 3; p++) {
        const a = passLine(p - 1), b = passLine(p);
        Object.keys(a).forEach((k) => { if (b[k] !== undefined) { tot++; if (a[k] === b[k]) same++; } });
      }
      return { pc: tot ? Math.round(same * 100 / tot) : -1, n: tot };
    };
    const out = {};
    out.all = keptPc({ ev: 1, am: 100 });
    out.rhyOnly = keptPc({ ev: 1, am: 100, what: { rhy: 1 } });
    out.half = keptPc({ ev: 1, am: 50 });
    try { delete Lat().chg; E.getCfg(); } catch (e) {}
    return out;
  });
  console.log('  line notes held from one pass to the next:');
  console.log('    Evolve every pass, all of it   → ' + evo.all.pc + '%  (' + evo.all.n + ' notes)');
  console.log('    …narrowed to RHYTHM only       → ' + evo.rhyOnly.pc + '%');
  console.log('    …How much 50%                  → ' + evo.half.pc + '%\n');

  ok('there were line notes to measure', evo.all.n > 12, JSON.stringify(evo.all));
  // THE POISON CHECK. Reading `seedBase` flat — what this did before — the
  // line re-rolls whatever the change is narrowed to, so this reads far
  // below 100 and the knob that says "rhythm only" is lying.
  ok('a change narrowed to RHYTHM holds the line’s pitches',
    evo.rhyOnly.pc === 100, evo.rhyOnly.pc + '% held');
  ok('…while a change that touches everything re-decides them',
    evo.all.pc < 60, evo.all.pc + '% held');
  ok('…and How much 50% keeps about half, not none',
    evo.half.pc > evo.all.pc + 10 && evo.half.pc < 95,
    JSON.stringify({ half: evo.half.pc, all: evo.all.pc }));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
