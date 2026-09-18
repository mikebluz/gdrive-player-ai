// PROBE — Hold's row says what a STEP IS WORTH, and the number is true.
//
// Asked outright: "what does hold do? what does a unit of value for that
// parameter mean". The hint said "grid steps" and nothing on the card said
// what a step was worth — and the divisor (`part.rhythm.steps`) is only SHOWN
// on the Euclid and Drawn rhythms though every kind has one.
//
// The load-bearing check is the LAST one: the resolved time must equal the
// duration the EMITTER actually gives a note. A readout that disagrees with
// what plays is worse than no readout. The rest guard the second writer —
// tempo, Bars, Rate and Steps all move this number and none of them rebuilds
// the row, which is exactly how a computed face freezes at a wrong answer.
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
    const repaint = async () => {
      const h = document.getElementById('bloom-v2-layers');
      if (h) h._sig = ''; window._v2.render(E); await wait(320);
      const c = document.querySelector('.v2-layer'); if (c) c.classList.remove('collapsed');
      await wait(120);
    };
    // A KNOWN CYCLE: euclid, 16 steps, 2 bars. The hint's divisor is Steps.
    L().on = true; L().present = true; L().part.kind = 'live';
    L().part.bars = 2;
    L().part.rhythm = { kind: 'euclid', steps: 16, pulses: 16 };
    L().part.pitch = { kind: 'fixed', degree: 1 };
    delete L().part.shape.holdSteps;
    E.getCfg();
    await repaint();
    // the row, wherever it is on the card — the sheet's copy and the panel's
    const hintOf = () => {
      const el = document.querySelector('.v2-layer .v2-f[data-f="part.shape.holdSteps"]');
      const row = el && el.closest('.ambient-ctrl');
      const hn = row && row.querySelector('.ambient-hint');
      return hn ? hn.textContent.trim() : null;
    };
    const o = {};
    o.off = hintOf();
    // HOLD ON — the model, then the gate pass the card takes on every commit
    L().part.shape.holdSteps = 3; E.getCfg();
    await repaint();
    o.on = hintOf();
    o.cyc = window._v2.cycleSec(L(), E.getCfg());
    // WHAT THE EMITTER ACTUALLY GIVES A NOTE
    const emitted = () => {
      const cyc = window._v2.cycleSec(L(), E.getCfg());
      const ns = window._v2.withEdit(() => window._v2.notesFor(L(),
        { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: cyc })) || [];
      return ns.length ? Math.round(ns[0].durMs) : 0;
    };
    o.emitted = emitted();
    // ── THE SECOND WRITER: move what the number is made of ───────────
    L().part.rhythm.steps = 8; L().part.rhythm.pulses = 8; E.getCfg();
    await repaint();
    o.steps8 = hintOf(); o.emitted8 = emitted();
    L().part.rhythm.steps = 16; L().part.rhythm.pulses = 16;
    L().part.bars = 4; E.getCfg();
    await repaint();
    o.bars4 = hintOf(); o.emitted4 = emitted();
    L().part.bars = 2; E.getCfg();
    // …AND WITHOUT A REBUILD. Tempo moves it and nothing rebuilds the row: the
    // gate pass is the only thing standing between this and a frozen readout.
    await repaint();
    const before = hintOf();
    // THE REAL LEVER: `barSec` reads `cfg.bpm` when it has one and falls back
    // to `_ambBpm()`, which is the tempo FIELD — so this is the tempo change a
    // user makes, and nothing about it rebuilds a layer card.
    try { const t = document.getElementById('tempo-input'); if (t) { t.value = '60'; t.dispatchEvent(new Event('input', { bubbles: true })); } } catch (e) {}
    try { const c = E.getCfg(); if (Number.isFinite(c.bpm)) c.bpm = 60; } catch (e) {}
    await wait(200);
    // a commit on ANY field takes a gate pass — that is the chokepoint
    const anyEl = document.querySelector('.v2-layer .v2-f[data-f="part.shape.lenRatio"]');
    if (anyEl) { anyEl.value = String((+anyEl.value || 90)); anyEl.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(320);
    o.beforeTempo = before; o.afterTempo = hintOf();
    o.tempoCyc = window._v2.cycleSec(L(), E.getCfg());
    o.tempoEmitted = emitted();
    try { const t = document.getElementById('tempo-input'); if (t) { t.value = '120'; t.dispatchEvent(new Event('input', { bubbles: true })); } } catch (e) {}
    try { const c = E.getCfg(); if (Number.isFinite(c.bpm)) c.bpm = 120; } catch (e) {}
    // ── EVERY COPY, AND IT FITS ──────────────────────────────────────
    // A field can have TWO controls on this card (the sheet's Shape group and
    // the Deep panel's), and the documented bug is the copy you are not
    // touching going stale. The repaint is a querySelectorAll for that reason.
    L().part.shape.holdSteps = 3; E.getCfg();
    await repaint();
    { const gb = document.querySelector('.v2-layer .v2-genbtn'); if (gb) gb.click(); }
    await wait(340);
    const all = [...document.querySelectorAll('.v2-layer .v2-f[data-f="part.shape.holdSteps"]')]
      .map((el) => {
        const row = el.closest('.ambient-ctrl');
        const hn = row && row.querySelector('.ambient-hint');
        return hn ? hn.textContent.trim() : null;
      });
    o.copies = all;
    // NO OVERFLOW at 390px — the hint wraps by default and this one got longer.
    o.overflow = [...document.querySelectorAll('.v2-layer .ambient-hint')]
      .filter((n) => /per cycle = /.test(n.textContent || ''))
      .map((n) => ({ sw: n.scrollWidth, cw: n.clientWidth,
                     over: n.scrollWidth > n.clientWidth + 1 ||
                           (n.parentElement && n.getBoundingClientRect().right >
                            n.parentElement.getBoundingClientRect().right + 1) }));
    // THE i WHY LINE says it too — same fact, the explain surface
    try {
      const wb = document.querySelector('.v2-layer .v2-whybtn');
      o.whyDoor = !!wb;
      if (wb) { wb.click(); await wait(400); }
    } catch (e) {}
    const wbody = document.querySelector('.v2-layer .v2-whybody');
    o.why = ((wbody && wbody.textContent) || '').replace(/\s+/g, ' ')
      .match(/Hold\s*(\d+ steps?) · ([\d.]+ (?:ms|s))/);
    o.why = o.why ? o.why[0] : null;
    // back off
    L().part.shape.holdSteps = 0; E.getCfg();
    await repaint();
    o.backOff = hintOf();
    return o;
  });

  const ms = (s) => { const m = /= ([\d.]+) (ms|s) a note/.exec(s || ''); return m ? (m[2] === 's' ? Math.round(+m[1] * 1000) : +m[1]) : null; };

  ok('at 0 the hint still teaches — which knob is in charge, no phantom time',
    /0 = use Length instead/.test(run.off) && !/a note/.test(run.off), JSON.stringify(run.off));
  ok('Hold 3 of 16 on a 2-bar cycle resolves a TIME in the hint',
    /3 of 16 per cycle = /.test(run.on) && ms(run.on) > 0, JSON.stringify(run.on));
  // 2 bars at the default tempo ÷ 16 steps × 3
  ok('…and the number is the arithmetic it claims — cycle ÷ Steps × Hold',
    Math.abs(ms(run.on) - Math.round(run.cyc / 16 * 3 * 1000)) <= 1,
    JSON.stringify({ hint: run.on, cyc: run.cyc, want: Math.round(run.cyc / 16 * 3 * 1000) }));
  ok('HALVING Steps DOUBLES a step, and the row says so',
    ms(run.steps8) === ms(run.on) * 2, JSON.stringify({ was: run.on, now: run.steps8 }));
  ok('DOUBLING Bars doubles it too — the cycle is the numerator',
    ms(run.bars4) === ms(run.on) * 2, JSON.stringify({ was: run.on, now: run.bars4 }));
  // Nothing here rebuilt the row — the gate pass a commit takes is the only
  // thing between this and a readout frozen at the old tempo.
  ok('a TEMPO change with no rebuild still moves the number — it is not frozen',
    ms(run.afterTempo) !== null && ms(run.afterTempo) === ms(run.beforeTempo) * 2,
    JSON.stringify({ before: run.beforeTempo, after: run.afterTempo }));
  ok('…and it still agrees with the emitter at the new tempo',
    run.tempoEmitted === ms(run.afterTempo),
    JSON.stringify({ emitted: run.tempoEmitted, hint: run.afterTempo }));
  ok('switching Hold off restores the teaching line',
    /0 = use Length instead/.test(run.backOff), JSON.stringify(run.backOff));
  // THE ONE THAT MATTERS
  ok('THE READOUT AGREES WITH WHAT PLAYS — the emitter gives exactly that duration',
    run.emitted === ms(run.on) && run.emitted8 === ms(run.steps8) && run.emitted4 === ms(run.bars4),
    JSON.stringify({ emitted: run.emitted, hint: ms(run.on),
                     emitted8: run.emitted8, hint8: ms(run.steps8),
                     emitted4: run.emitted4, hint4: ms(run.bars4) }));

  ok('BOTH copies of the row carry it — the one you are not touching too',
    run.copies.length >= 2 && run.copies.every((t) => /per cycle = /.test(t || '')),
    JSON.stringify(run.copies));
  ok('…and the longer hint still fits at 390px — it wraps, nothing scrolls',
    run.overflow.length > 0 && run.overflow.every((x) => !x.over), JSON.stringify(run.overflow));

  // ℹ Why? IS THE EXPLAIN SURFACE — "3 steps" is half an answer there too.
  ok('ℹ Why? states the Hold time as well as the step count',
    run.whyDoor && run.why != null && /· [\d.]+ (ms|s)/.test(run.why), JSON.stringify(run.why));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  if (run.why) console.log('  (ℹ Why? says: ' + run.why + ')');
  console.log('\n  ' + run.off + '\n  ' + run.on);
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
