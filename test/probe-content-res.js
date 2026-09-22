// PROBE — ⊞ Resolution on every content, not just ♦ Beat.
//
// user, 2026-09-22: "all Contents should have Resolution like Beat that scales
// the part".
//
// It was "Steps", a bare 2–64 stepper hinted "per cycle". Same field
// (`rhythm.steps`), same axis — so this is a rename plus the two things that
// made the kit's version musical rather than arithmetic: values named by note
// value, and a grid that SCALES THE PATTERN instead of merely re-quantising it.
//
//   node test/probe-content-res.js     (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(1200);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c && c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);
  // ◢ BASS — a euclid with ◫ Fill, the content the question came from.
  await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'bass';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await zz(1700);
  // …on a part long enough that density is visible.
  await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    L.part.bars = 4; E.getCfg();
  });
  await zz(800);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const x = c.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !c.classList.contains('v2-gz-2')) x.click();
  });
  await zz(900);

  const door = await page.evaluate(() => {
    const sel = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.steps"]');
    if (!sel) return { there: false };
    const r = sel.getBoundingClientRect();
    const lab = sel.closest('.ambient-ctrl') &&
      sel.closest('.ambient-ctrl').querySelector('label');
    return { there: true, tag: sel.tagName,
             reachable: r.width > 0 && r.height > 0 && !!sel.offsetParent,
             inView: r.right <= document.documentElement.clientWidth + 1,
             label: lab ? lab.textContent.trim() : null,
             value: sel.value,
             opts: [...sel.options].map((o) => o.value),
             first: (sel.options[0] || {}).textContent || null };
  });
  console.log('\n  ⊞ on ◢ Bass: ' + JSON.stringify(door));
  ok('a pitched content has a Resolution control, and it is a real target',
    door.there && door.reachable && door.inView, JSON.stringify(door));
  ok('…named Resolution, like the kit’s — one word for one axis',
    door.label === 'Resolution', JSON.stringify(door.label));
  ok('…a picker of musical values, not a bare number stepper',
    door.tag === 'SELECT' &&
    JSON.stringify(door.opts) === JSON.stringify(['4', '8', '12', '16', '24', '32', '48', '64']),
    door.tag + ' ' + JSON.stringify(door.opts));
  ok('…naming the note value and the unit',
    /a bar/.test(door.first) && /quarters/.test(door.first), JSON.stringify(door.first));

  // ── IT SCALES THE PART ──────────────────────────────────────────────────
  const onsets = () => page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const L = V.stagedOf(id) || (E.getCfg().layers || [])[0];
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const cyc = V.cycleSec(L, E.getCfg());
    const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(L,
      { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || [];
    const perBar = cyc / Math.max(0.001, +L.part.bars || 1);
    const beats = ns.map((x) => Math.round((x.at / perBar) * 4 * 1000) / 1000);
    return { n: ns.length, steps: L.part.rhythm.steps | 0, pulses: L.part.rhythm.pulses | 0,
             beats: beats.slice(0, 12) };
  });
  const setRes = async (v) => {
    const p = await page.evaluate((v) => {
      const sel = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.steps"]');
      if (!sel) return false;
      sel.value = String(v);
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, v);
    await zz(1000);
    return p;
  };

  const at16 = await onsets();
  await setRes(32);
  const at32 = await onsets();
  await setRes(8);
  const at8 = await onsets();
  await setRes(16);
  const back = await onsets();
  console.log('  ⊞ 16: ' + at16.pulses + '/' + at16.steps + ' → ' + at16.n + ' onsets  ' + JSON.stringify(at16.beats.slice(0, 6)));
  console.log('  ⊞ 32: ' + at32.pulses + '/' + at32.steps + ' → ' + at32.n + ' onsets  ' + JSON.stringify(at32.beats.slice(0, 6)));
  console.log('  ⊞  8: ' + at8.pulses + '/' + at8.steps + ' → ' + at8.n + ' onsets  ' + JSON.stringify(at8.beats.slice(0, 6)) + '\n');

  ok('⊞ 32 scales the pattern with the grid, it does not just re-quantise',
    at32.pulses === at16.pulses * 2 && at32.steps === 32,
    JSON.stringify({ was: at16.pulses + '/' + at16.steps, now: at32.pulses + '/' + at32.steps }));
  ok('…so the content plays twice as many onsets', at32.n === at16.n * 2,
    at16.n + ' → ' + at32.n);
  ok('…and ⊞ 8 plays half as many', at8.n === at16.n / 2, at16.n + ' → ' + at8.n);
  ok('…and coming back to ⊞ 16 is the content you started with',
    back.n === at16.n && back.pulses === at16.pulses,
    JSON.stringify({ back: back.pulses + '/' + back.steps, was: at16.pulses + '/' + at16.steps }));
  // ON THE GRID IT STATES, at every resolution. NOT "on whole beats" — at
  // ⊞ 32 a bar is cut into thirty-seconds and eight pulses are EIGHTHS, so
  // beats 0, 0.5, 1, 1.5 are exactly right and an assertion about whole beats
  // would be asserting that the control does not work.
  const offGrid = (r) => {
    const unit = 4 / Math.max(1, r.steps);          // one step, in beats
    return r.beats.filter((b) => Math.abs(b / unit - Math.round(b / unit)) > 0.02).length;
  };
  ok('…and every resolution lands on the grid it states',
    offGrid(at16) === 0 && offGrid(at32) === 0 && offGrid(at8) === 0,
    JSON.stringify({ at16: at16.beats.slice(0, 4), at32: at32.beats.slice(0, 4),
                     at8: at8.beats.slice(0, 4) }));
  // …and the DEFAULT resolution is still whole beats, which is where the
  // filled-bass fix left it.
  ok('…with ⊞ 16 still four to the bar, on whole beats',
    at16.beats.slice(0, 6).every((b) => Math.abs(b - Math.round(b)) < 0.02),
    JSON.stringify(at16.beats.slice(0, 6)));

  // ── RESOLUTION AND HOW MANY SQUARE ──────────────────────────────────────
  // user, 2026-09-22: "Resolution and How many aren't really squaring". They
  // are one relationship — this many OF that grid — and three things hid it:
  // How many's ceiling was min(32, steps) while normalize clamps to steps and
  // ⊞ Resolution reaches 64, so at ⊞ 48 the stepper showed a value above its
  // own max; its hint named "the cycle" (wrong for a filled part since ◫ Fill
  // began tiling per bar) and "the Grid" (a control now called Resolution);
  // and nothing said the two move together, though ⊞ Resolution scales this
  // number by design.
  // PUSH LIVES IN FINE-TUNE, so open it — a row that is not on screen answers
  // `null` and would read as the ceiling never having been fixed.
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const z = c.querySelector('.v2-gzbar[data-gz="3"]');
    if (z && !c.classList.contains('v2-gz-3')) z.click();
  });
  await zz(700);
  await page.evaluate(() => {
    const t = document.querySelector('.v2-layer .v2-fttab[data-ft="rhythm"]');
    if (t) t.click();
  });
  await zz(700);
  const pair = async (res) => {
    await setRes(res);
    return page.evaluate(() => {
      const hm = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.pulses"]');
      const rs = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.steps"]');
      const push = document.querySelector('.v2-layer .v2-f[data-f="part.rhythm.rotate"]');
      const hintOf = (el) => { const row = el && el.closest('.ambient-ctrl');
        const h = row && row.querySelector('.ambient-hint'); return h ? h.textContent.trim() : null; };
      return {
        res: rs ? (rs.value | 0) : null,
        many: hm ? (hm.value | 0) : null,
        manyMax: hm ? (hm.getAttribute('max') | 0) : null,
        manyHint: hintOf(hm),
        pushMax: push ? (push.getAttribute('max') | 0) : null,
      };
    });
  };
  const p16 = await pair(16), p48 = await pair(48), p64 = await pair(64);
  console.log('  ⊞ 16: ' + JSON.stringify(p16));
  console.log('  ⊞ 48: ' + JSON.stringify(p48));
  console.log('  ⊞ 64: ' + JSON.stringify(p64) + '\n');

  ok('How many is capped at the Resolution, not a fixed 32',
    p48.manyMax === 48 && p64.manyMax === 64,
    JSON.stringify({ at48: p48.manyMax, at64: p64.manyMax }));
  ok('…so its value is never above its own maximum',
    p48.many <= p48.manyMax && p64.many <= p64.manyMax,
    JSON.stringify({ at48: p48.many + '/' + p48.manyMax, at64: p64.many + '/' + p64.manyMax }));
  ok('…and Push is counted in the same steps',
    p48.pushMax === 47 && p64.pushMax === 63,
    JSON.stringify({ at48: p48.pushMax, at64: p64.pushMax }));
  // THE ROW SAYS WHAT IT IS COUNTING OF, and that the two move together.
  ok('How many states the pair, in the unit the part is counted in',
    /of 48 a bar/.test(p48.manyHint || ''), JSON.stringify(p48.manyHint));
  ok('…and says it moves with Resolution',
    /moves with .*Resolution/.test(p48.manyHint || ''), JSON.stringify(p48.manyHint));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
