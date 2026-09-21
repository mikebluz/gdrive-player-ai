// PROBE — 🎲 New take advances every press, and says so when it changed nothing.
//
// user: "why does clicking New take only work once (re-rolls once) then no-ops
// from then on". The take advances on EVERY press — that part is measured here
// so the claim can be checked rather than argued. What it cannot do is change
// the NOTES of a material that has no dice in it: ⛰ Play the changes takes its
// chord tones from the changes and its strike pattern is fixed, so with the
// ♪ Line on its default `series` every take is the same take. The press was
// silent about that, and a button that reports nothing reads as broken.
//
//   node test/probe-newtake.js        (needs `npm start` on :3001)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

const setup = async (page, line) => {
  await page.evaluate((k) => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    L.part.kind = 'live'; L.part.notes = [];
    delete L.part.takeb; delete L.part.ruleb; delete L.part.ground;
    E.getCfg();
    window._v2.applyPreset(E, (E.getCfg().layers || [])[0], 'comp');
    E.getCfg();
    const L2 = (E.getCfg().layers || [])[0];
    const g = L2.part.ground || (L2.part.ground = {});
    const bag = g.parts || (g.parts = {});
    (bag['0'] || (bag['0'] = {})).mel = { rate: 4, kind: k, oct: 1, len: 80, vel: 70, on: 1 };
    L2.chg = { ev: 1, am: 100 }; L2.ahead = 7;
    E.getCfg(); window._v2.render(E);
  }, line);
  await zz(900);
  await page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    if (card.classList.contains('collapsed')) card.querySelector('.ambient-collapse').click();
  });
  await zz(900);
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
    cfg.prog.chords = [{ root: 6, intervals: [0, 3, 7] }, { root: 9, intervals: [0, 4, 7, 11] },
                       { root: 7, intervals: [0, 4, 7, 10] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { const x = document.getElementById('mix-bloom-add-layer'); x.scrollIntoView({ block: 'center' }); x.click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1000);

  const shot = () => page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const L = (E.getCfg().layers || [])[0];
    const cv = document.querySelector('.v2-layer .v2-vizcv');
    const t = [...document.querySelectorAll('.ambient-toast, .toast, [class*="toast"]')]
      .map((n) => (n.textContent || '').trim()).filter(Boolean);
    return {
      take: V.takeOf(L),
      canvas: cv && cv._hits ? cv._hits.map((h) => Math.round((h.t || 0) * 1e4) + ':' + h.midi).join(' ') : '',
      toast: t.join(' | '),
    };
  });
  const press = async () => {
    const box = await page.evaluate(() => {
      const x = document.querySelector('.v2-layer .v2-newtake'); if (!x) return null;
      x.scrollIntoView({ block: 'center' });
      const r = x.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });
    if (!box || !(box.w > 0)) return false;
    await page.touchscreen.tap(box.x, box.y);
    await zz(1100);
    return true;
  };

  // ── A MATERIAL WITH DICE: five presses, five different takes ────────────
  await setup(page, 'walk');
  let prev = await shot();
  const walk = { takes: [prev.take], moved: 0 };
  for (let i = 0; i < 5; i++) {
    if (!(await press())) break;
    const s = await shot();
    walk.takes.push(s.take);
    if (s.canvas !== prev.canvas) walk.moved++;
    prev = s;
  }
  console.log('\n  ⛰ Comp with a ♪ Line set to WALK:');
  console.log('   takes   ' + walk.takes.join(' → ') + '   picture moved ' + walk.moved + '/5\n');
  ok('every press advances the take', walk.takes.every((t, i) => i === 0 || t === walk.takes[i - 1] + 1),
    walk.takes.join(' → '));
  ok('…and every press redraws a different picture', walk.moved === 5,
    walk.moved + ' of 5 presses changed the drawing');

  // ── A MATERIAL WITHOUT: the take still moves, the notes cannot ──────────
  await setup(page, 'series');
  prev = await shot();
  const ser = { takes: [prev.take], moved: 0, toast: '' };
  for (let i = 0; i < 3; i++) {
    if (!(await press())) break;
    const s = await shot();
    ser.takes.push(s.take);
    if (s.canvas !== prev.canvas) ser.moved++;
    if (s.toast) ser.toast = s.toast;
    prev = s;
  }
  console.log('  ⛰ Comp with the default ♪ Line (series):');
  console.log('   takes   ' + ser.takes.join(' → ') + '   picture moved ' + ser.moved + '/3');
  console.log('   toast   “' + ser.toast.slice(0, 150) + '”\n');

  ok('the take still advances on every press — it is not "working once"',
    ser.takes.every((t, i) => i === 0 || t === ser.takes[i - 1] + 1), ser.takes.join(' → '));
  ok('…the notes cannot move, because this material has no dice',
    ser.moved === 0, ser.moved + ' of 3 presses changed the drawing');
  ok('…and the press SAYS so rather than going quiet',
    /IDENTICAL/i.test(ser.toast), JSON.stringify(ser.toast.slice(0, 150)));
  // …and names the dice that ACTUALLY work on this material. Measured,
  // distinct takes out of 6 on ⛰ Comp: Roam 6 · Walk line 6 · Twist 6 ·
  // Slip 6, against Inversion 1 · Len vary 1 · Rhythm vary 1. Naming a knob
  // that does nothing would send someone round the same loop again.
  ok('…and names dice that actually work here',
    /Roam/i.test(ser.toast) && /Walk/i.test(ser.toast) &&
    /Twist/i.test(ser.toast) && /Slip/i.test(ser.toast),
    JSON.stringify(ser.toast.slice(0, 180)));
  ok('…and names none that do not', !/Inversion|Len vary/i.test(ser.toast),
    JSON.stringify(ser.toast.slice(0, 180)));

  // ── AND THE NAMED DICE MUST BE TRUE ──────────────────────────────────────
  // The toast is a claim about the engine; this checks the engine keeps it.
  const dice = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const Lat = () => (E.getCfg().layers || [])[0];
    const clean = () => {
      const L = Lat(); L.part.kind = 'live'; L.part.notes = [];
      delete L.part.ground; delete L.part.takeb; delete L.part.ruleb; E.getCfg();
      V.applyPreset(E, Lat(), 'comp'); E.getCfg();
      // a preset does not reset what it does not state — clear every die by
      // hand or each reading carries the last one's
      const L2 = Lat();
      delete L2.part.pitch.roam; delete L2.part.shape.slip;
      delete L2.twist; delete L2.part.ground; E.getCfg();
    };
    const distinct = () => {
      const s2 = new Set();
      for (let t = 0; t < 6; t++) {
        const L = Lat();
        E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
        s2.add((V.withEdit(() => V.withTake(t, () => V.notesFor(L,
          { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: 6 }))) || [])
          .map((n) => Math.round(n.at * 1000) + ':' +
            Math.round(69 + 12 * Math.log2((n.freq || 440) / 440))).join(' '));
      }
      return s2.size;
    };
    const out = {};
    clean(); out.bare = distinct();
    clean(); Lat().part.pitch.roam = 50; E.getCfg(); out.roam = distinct();
    clean(); Lat().twist = 50; E.getCfg(); out.twist = distinct();
    clean(); Lat().part.shape.slip = 50; E.getCfg(); out.slip = distinct();
    clean(); (() => { const L = Lat();
      const g = L.part.ground || (L.part.ground = {});
      const bag = g.parts || (g.parts = {});
      (bag['0'] || (bag['0'] = {})).mel = { rate: 4, kind: 'walk', oct: 1, len: 80, vel: 70, on: 1 };
    })(); E.getCfg(); out.walk = distinct();
    return out;
  });
  console.log('  distinct takes out of 6 on ⛰ Comp:');
  console.log('   bare ' + dice.bare + '   Roam ' + dice.roam + '   Twist ' + dice.twist +
              '   Slip ' + dice.slip + '   ♪ Walk ' + dice.walk + '\n');
  ok('bare, it really has no dice', dice.bare === 1, dice.bare + ' distinct');
  ok('…and every die the message names really rolls it',
    dice.roam === 6 && dice.twist === 6 && dice.slip === 6 && dice.walk === 6,
    JSON.stringify(dice));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
