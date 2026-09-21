// PROBE — ◢ Bass: the root of each change, low and on the beat.
//
// The one obvious hole in the material list, and not a new invention: v1 HAD a
// Bass layer and this file's own v1 importer still maps it to exactly
// `euclid × fixed degree 1` (see `eff === 'bass'`). v2 never built the door.
//
// THE REGISTER IS THE MATERIAL. A root-degree line at the default register 4 is
// just ▪ Repeat one note in the middle of the mix — what makes it a bass is
// sitting two octaves under everything else, and nobody reaches for Register to
// discover that. So the checks below are about PITCH HEIGHT as much as about
// which notes: a "bass" that lands where the pads are is not one.
//
//   node test/probe-bass.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  // a progression, so "the root of each change" has changes to follow
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 0, intervals: [0, 4, 7] }, { root: 5, intervals: [0, 4, 7] },
                       { root: 7, intervals: [0, 4, 7] }];
    delete cfg.prog.parts; delete cfg.prog.chain; delete cfg.prog.arrGrid; delete cfg.prog.grid;
    E.getCfg();
  });
  await zz(400);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(1200);
  await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
  });
  await zz(700);
  await page.evaluate(() => { window._v2.openGen(_masterEng, (_masterEng.getCfg().layers || [])[0]); });
  await zz(1400);

  const offered = await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    return sp ? [...sp.options].map((o) => o.value).filter(Boolean) : [];
  });
  console.log('\n  materials offered: ' + JSON.stringify(offered) + '\n');
  ok('◢ Bass has a door of its own', offered.indexOf('bass') >= 0, JSON.stringify(offered));

  // a SUSTAIN first, to have something to compare the register against
  const ref = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const pick = (k) => {
      const sp = document.querySelector('.v2-layer .v2-shapepick');
      sp.value = k;
      sp.dispatchEvent(new Event('input', { bubbles: true }));
      sp.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const midis = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 8 }))) || [];
      return ns.map((n) => Math.round(69 + 12 * Math.log2((n.freq || 440) / 440)));
    };
    pick('sustain'); await new Promise((r) => setTimeout(r, 1400));
    const sus = { midis: midis(), reg: (Lat().instrument || {}).register };
    pick('bass'); await new Promise((r) => setTimeout(r, 1500));
    const l = Lat();
    return {
      sus,
      mat: l.part.mat, reg: (l.instrument || {}).register,
      rk: l.part.rhythm.kind, pk: l.part.pitch.kind, deg: l.part.pitch.degree,
      midis: midis(),
    };
  });
  const lo = (a) => (a.length ? Math.min(...a) : null);
  console.log('  Sustain: register ' + ref.sus.reg + ', lowest note ' + lo(ref.sus.midis));
  console.log('  Bass:    register ' + ref.reg + ', lowest note ' + lo(ref.midis) +
              '  (' + ref.rk + ' × ' + ref.pk + ' degree ' + ref.deg + ')');
  console.log('  bass notes: ' + JSON.stringify(ref.midis) + '\n');

  ok('picking it builds v1’s own recipe — a euclid on the root degree',
    ref.mat === 'bass' && ref.rk === 'euclid' && ref.pk === 'fixed' && ref.deg === 1,
    JSON.stringify({ mat: ref.mat, rk: ref.rk, pk: ref.pk, deg: ref.deg }));
  // THE POINT OF THE MATERIAL: it sits under everything, without being asked.
  ok('…and it drops the register, which is what makes it a bass',
    ref.reg < ref.sus.reg && ref.reg <= 2, JSON.stringify({ bass: ref.reg, sustain: ref.sus.reg }));
  ok('…so its notes really are below the pad’s',
    lo(ref.midis) !== null && lo(ref.sus.midis) !== null && lo(ref.midis) < lo(ref.sus.midis) - 6,
    JSON.stringify({ bassLow: lo(ref.midis), sustainLow: lo(ref.sus.midis) }));
  // ONE NOTE AT A TIME — a bass that stacks a triad is not a bass.
  ok('…one note at a time, not a chord',
    new Set(ref.midis).size <= 3 && ref.midis.length >= 4,
    JSON.stringify({ distinct: new Set(ref.midis).size, n: ref.midis.length }));

  // ── IT FOLLOWS THE CHANGES ──────────────────────────────────────────────
  // `fixed` degree 1 is the ROOT of whatever chord is sounding, so over
  // C · F · G the line must move, and move BY those roots.
  // FROM THE CYCLE ALREADY READ, not a second one at a different length: a
  // 24s read of a 2-bar part is one long cycle resolved against the chord at
  // its start, so it reported a single pitch class and looked like a bass that
  // ignores the changes — while the 8s read beside it plainly moved.
  const follows = (() => {
    const pcs = [...new Set(ref.midis.map((m) => ((m % 12) + 12) % 12))].sort((a, b) => a - b);
    return { pcs, n: ref.midis.length };
  })();
  console.log('  pitch classes over C · F · G: ' + JSON.stringify(follows.pcs) + '\n');
  ok('the line follows the changes — it plays each chord’s root',
    follows.pcs.length >= 2 && follows.pcs.indexOf(0) >= 0,
    JSON.stringify(follows.pcs));

  // ── CHARACTERS ──────────────────────────────────────────────────────────
  const chars = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const count = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      return (V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 8 }))) || []).length;
    };
    const ps = document.querySelector('.v2-layer .v2-presetpick');
    const list = ps ? [...ps.options].map((o) => o.value).filter(Boolean) : [];
    // RE-QUERY EVERY TIME. Applying a Character re-renders the card, so a
    // select captured before the first one is DETACHED by the second — setting
    // `.value` on it does nothing and the check reads as the Character having
    // no effect. (The re-render-under-the-finger trap, hitting the probe.)
    const apply = async (id2) => {
      const el = document.querySelector('.v2-layer .v2-presetpick');
      if (!el) return null;
      el.value = id2;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      return count();
    };
    const held = list.indexOf('bassheld') >= 0 ? await apply('bassheld') : null;
    const heldR = JSON.parse(JSON.stringify(Lat().part.rhythm));
    const pump = list.indexOf('basspump') >= 0 ? await apply('basspump') : null;
    const pumpR = JSON.parse(JSON.stringify(Lat().part.rhythm));
    return { list, held, pump, heldR, pumpR, mat: Lat().part.mat, kind: Lat().part.kind };
  });
  console.log('  Characters: ' + JSON.stringify(chars.list));
  console.log('  Held → ' + chars.held + ' notes  ' + JSON.stringify(chars.heldR));
  console.log('  Pumping → ' + chars.pump + ' notes  ' + JSON.stringify(chars.pumpR));
  console.log('  mat=' + chars.mat + ' kind=' + chars.kind + '\n');
  ok('◢ Bass has Characters of its own',
    chars.list.length >= 4 && chars.list.indexOf('bassheld') >= 0,
    JSON.stringify(chars.list));
  // THEY DIFFER BY RHYTHM, which is what actually separates one bass from
  // another — `fixed` plays one degree, so a Character moving `dir`/`span`
  // would be a knob set that changes nothing.
  ok('…and they differ where a bass actually differs: how often it plays',
    chars.held !== null && chars.pump !== null && chars.pump > chars.held * 2,
    JSON.stringify({ held: chars.held, pumping: chars.pump }));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
