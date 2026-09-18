// PROBE — Shape ▸ Feel ▸ Tight actually cuts each note short of the next.
//
// Reported as "Tight doesn't seem to be doing its job", from a drawing full of
// overlapping bars. v1's Tight does TWO things — clamp the release AND size the
// note to the gap before the next onset; v2 only ever did the first, so notes
// kept their full length. The check measures OVERLAP, which is the thing the
// hint promises to remove.
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

  // A FIXED part with deliberately OVERLONG notes — the reported shape. Each
  // note is far longer than the gap to the next, so untightened it overlaps and
  // tightened it must not.
  const run = await page.evaluate(async () => {
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    L().part.kind = 'recorded'; L().part.bars = 2;
    L().part.notes = [
      { t: 0,     midi: 60, dur: 0.9 },
      { t: 0.25,  midi: 64, dur: 0.9 },
      { t: 0.5,   midi: 67, dur: 0.9 },
      { t: 0.5,   midi: 71, dur: 0.9 },   // a CHORD with the one above
      { t: 0.75,  midi: 72, dur: 0.9 },
    ];
    delete L().tight;
    E.getCfg();
    const ask = () => (window._v2.withEdit(() => window._v2.notesFor(L(),
      { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: 4 })) || [])
      .map((n) => ({ at: Math.round(n.at * 1000), end: Math.round(n.at * 1000 + n.durMs) }));
    // how many notes run past the NEXT LATER onset
    const overlaps = (ns) => {
      const s = ns.slice().sort((a, b) => a.at - b.at);
      let n = 0;
      for (let i = 0; i < s.length; i++) {
        const nxt = s.find((x) => x.at > s[i].at + 1);
        if (nxt && s[i].end > nxt.at + 1) n++;
      }
      return n;
    };
    const off = ask();
    L().tight = 1; E.getCfg();
    const on = ask();
    // CHORD CHECK, found by GROUPING rather than by a hardcoded time: `t` is a
    // cycle FRACTION, so t=0.5 of a 4 s cycle lands at 2000ms — the first
    // version looked at 500 and found nothing, then passed its own emptiness.
    const byAt = {};
    on.forEach((x) => { (byAt[x.at] = byAt[x.at] || []).push(x); });
    const chordOn = Object.values(byAt).find((g) => g.length > 1) || [];
    L().tight = 0; E.getCfg();
    return { off, on, offOverlaps: overlaps(off), onOverlaps: overlaps(on),
             chordOn: chordOn,
             chordSame: chordOn.length === 2 && chordOn[0].end === chordOn[1].end,
             shortened: on.some((x, i) => x.end < off[i].end) };
  });

  ok('untightened, the notes DO overlap — the fixture is the reported shape',
    run.offOverlaps >= 3, JSON.stringify(run.off));
  ok('Tight cuts every note short of the next',
    run.onOverlaps === 0 && run.shortened,
    JSON.stringify({ on: run.on, overlaps: run.onOverlaps }));
  ok('…and a CHORD is not clipped against itself — same onset, same length',
    run.chordSame, JSON.stringify(run.chordOn));

  // It must only ever SHORTEN: notes already inside their gap are untouched.
  const shortOnly = await page.evaluate(async () => {
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    L().part.notes = [
      { t: 0,    midi: 60, dur: 0.05 },
      { t: 0.5,  midi: 64, dur: 0.05 },
    ];
    delete L().tight; E.getCfg();
    const ask = () => (window._v2.withEdit(() => window._v2.notesFor(L(),
      { E, cfg: E.getCfg(), key: 'v2:' + L().id, cycleStart: 0, cycleSec: 4 })) || [])
      .map((n) => Math.round(n.durMs));
    const off = ask();
    L().tight = 1; E.getCfg();
    const on = ask();
    L().tight = 0; E.getCfg();
    return { off, on };
  });
  ok('…and a note already shorter than its gap is left exactly alone',
    JSON.stringify(shortOnly.off) === JSON.stringify(shortOnly.on),
    JSON.stringify(shortOnly));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
