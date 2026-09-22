// PROBE — ▪ One note: holds, or follows, and you can see which.
//
// user, of a pedal note: "why does 'hold a pedal note' not obey changes"
//
// It was behaving exactly as designed. A pedal point is a note held AGAINST
// moving harmony — `anchor` picks the tonic by v1's own `_ambAnchorPc` and
// holds it, and that friction is the device. The follows-the-changes version
// existed too, as a SEPARATE material called ▪ Repeat one note. Two adjacent
// menu entries whose names hid the only thing that differs between them, so the
// answer to "why doesn't this follow" was "pick the other one" — which nothing
// on screen said.
//
// So the fix is not to the pedal; it is to make the choice visible. One door,
// one switch, and the check that matters is that each setting does what its
// words say over a real progression.
//
//   node test/probe-onenote.js        (needs `npm start`; BLOOPS_URL to retarget)
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
  // THREE CHORDS WITH DIFFERENT ROOTS, so "follows" has somewhere to go and
  // "stays put" has something to stay put against.
  await page.evaluate(() => {
    const E = _masterEng, cfg = E.getCfg();
    cfg.bed.present = true; cfg.prog.on = true;
    cfg.prog.chords = [{ root: 6, intervals: [0, 3, 7] },    // F#m
                       { root: 9, intervals: [0, 4, 7] },    // A
                       { root: 7, intervals: [0, 4, 7, 10] }]; // G7
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

  // ── 1. ONE DOOR ─────────────────────────────────────────────────────────
  const offered = await page.evaluate(() => {
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    return sp ? [...sp.options].map((o) => o.value).filter(Boolean) : [];
  });
  console.log('\n  materials offered: ' + JSON.stringify(offered) + '\n');
  ok('▪ One note is one door', offered.indexOf('one') >= 0, JSON.stringify(offered));
  ok('…and the two it replaces are gone from the menu',
    offered.indexOf('anchor') < 0 && offered.indexOf('onenote') < 0, JSON.stringify(offered));
  // NAMED, NOT COUNTED — the lesson from `probe-beat`, which broke twice on a
  // length assertion while the list was being consolidated, and which this
  // check then broke a third time (♦ Beat is listed on synths now, so the
  // total went back up by one). What this check is ABOUT is that the two old
  // one-note doors became one, so that is what it asserts.
  ok('…so the menu carries one of them, not two',
    offered.filter((k) => ['one', 'anchor', 'onenote'].indexOf(k) >= 0).length === 1,
    JSON.stringify(offered));

  // ── 2. THE SWITCH IS ON SCREEN ──────────────────────────────────────────
  const built = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const sp = document.querySelector('.v2-layer .v2-shapepick');
    sp.value = 'one';
    sp.dispatchEvent(new Event('input', { bubbles: true }));
    sp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1600));
    const card = document.querySelector('.v2-layer');
    const x = card.querySelector('.v2-gzbar[data-gz="2"]');
    if (x && !card.classList.contains('v2-gz-2')) x.click();
    await new Promise((r) => setTimeout(r, 700));
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !!e.offsetParent; };
    // `.v2-holds` SPECIFICALLY — `part.pitch.kind` has several controls now
    // (this, Moves, and Advanced: recipe's full-grain copy); a bare `[data-f]`
    // query finds whichever is first in the DOM.
    const sw = card.querySelector('.v2-genwrap .v2-holds');
    const l = Lat();
    return { mat: l.part.mat, pk: l.part.pitch.kind,
             shown: vis(sw), opts: sw ? [...sw.options].map((o) => o.value) : null,
             label: (() => { const r = sw && sw.closest('.ambient-ctrl');
               const lb = r && r.querySelector('label'); return lb ? lb.textContent.trim() : null; })() };
  });
  console.log('  built: mat=' + built.mat + ' pitch=' + built.pk);
  console.log('  switch "' + built.label + '" shown=' + built.shown + ' ' + JSON.stringify(built.opts) + '\n');
  ok('picking it stamps the merged material', built.mat === 'one', JSON.stringify(built.mat));
  // IT DEFAULTS TO FOLLOWING, because that is what was expected of it.
  ok('…and the note follows the changes by default', built.pk === 'fixed', JSON.stringify(built.pk));
  ok('…with the choice on screen, both ways',
    built.shown && !!built.opts && built.opts.indexOf('fixed') >= 0 && built.opts.indexOf('anchor') >= 0,
    JSON.stringify({ shown: built.shown, opts: built.opts }));

  // ── 3. THE QUESTION THAT WAS ASKED ──────────────────────────────────────
  // Over F#m · A · G7 the two settings must genuinely differ: one line moves
  // with the roots, the other does not move at all.
  const both = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const pcs = () => {
      const l = Lat();
      E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
      const ns = V.withEdit(() => V.withTake(0, () => V.notesFor(l,
        { E, cfg: E.getCfg(), key: 'v2:' + l.id, cycleStart: 0, cycleSec: 9 }))) || [];
      return [...new Set(ns.map((n) =>
        ((Math.round(69 + 12 * Math.log2((n.freq || 440) / 440)) % 12) + 12) % 12))].sort((a, b) => a - b);
    };
    const set = async (v) => {
      const el = document.querySelector('.v2-layer .v2-genwrap .v2-holds');
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      return pcs();
    };
    return { follows: await set('fixed'), stays: await set('anchor') };
  });
  console.log('  Follows the changes → pitch classes ' + JSON.stringify(both.follows));
  console.log('  Stays put (pedal)   → pitch classes ' + JSON.stringify(both.stays) + '\n');
  ok('"Follows the changes" really does move with them',
    both.follows.length >= 2, JSON.stringify(both.follows));
  // THE PEDAL IS NOT BROKEN — it is the one material that deliberately ignores
  // the harmony, and this is the check that says so out loud.
  ok('…and "Stays put" holds ONE note through all three chords',
    both.stays.length === 1, JSON.stringify(both.stays));

  // ── 4. CHARACTERS, WHICH NEITHER OLD MATERIAL HAD ───────────────────────
  const chars = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const ps = () => document.querySelector('.v2-layer .v2-presetpick');
    const list = ps() ? [...ps().options].map((o) => o.value).filter(Boolean) : [];
    const apply = async (cid) => {
      const el = ps(); if (!el) return null;          // re-query: each apply re-renders
      el.value = cid;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const l = Lat();
      return { pk: l.part.pitch.kind, n: l.part.rhythm.n };
    };
    return { list, pedal: await apply('onepedal'), pump: await apply('onepump') };
  });
  console.log('  Characters: ' + JSON.stringify(chars.list));
  console.log('  Pedal → ' + JSON.stringify(chars.pedal) + '   Pumping → ' + JSON.stringify(chars.pump) + '\n');
  ok('▪ One note has Characters — neither old material had any',
    chars.list.length >= 4 && chars.list.indexOf('onepedal') >= 0,
    JSON.stringify(chars.list));
  ok('…and they reach the switch: Pedal stays put, Pumping follows',
    !!chars.pedal && chars.pedal.pk === 'anchor' && !!chars.pump && chars.pump.pk === 'fixed',
    JSON.stringify({ pedal: chars.pedal, pumping: chars.pump }));

  // ── 5. THE OLD STAMPS STILL RESOLVE ─────────────────────────────────────
  const legacy = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    const id = (E.getCfg().layers || [])[0].id | 0;
    const Lat = () => V.stagedOf(id) || (E.getCfg().layers || [])[0];
    const out = {};
    for (const old of ['anchor', 'onenote']) {
      const l = Lat();
      l.part.kind = 'live'; l.part.mat = old; E.getCfg();
      try { V.render(E); } catch (e) {}
      await new Promise((r) => setTimeout(r, 800));
      const sp = document.querySelector('.v2-layer .v2-shapepick');
      const ps = document.querySelector('.v2-layer .v2-presetpick');
      out[old] = { picked: sp ? sp.value : null,
                   chars: ps ? [...ps.options].map((o) => o.value).filter(Boolean).length : 0 };
    }
    return out;
  });
  console.log('  a part still stamped…');
  Object.keys(legacy).forEach((k) => console.log('    ' + k.padEnd(8) + ' → picker shows "' +
    legacy[k].picked + '", ' + legacy[k].chars + ' Characters'));
  console.log('');
  ok('both old stamps select the merged door',
    Object.keys(legacy).every((k) => legacy[k].picked === 'one'), JSON.stringify(legacy));
  ok('…and find its Characters',
    Object.keys(legacy).every((k) => legacy[k].chars >= 4), JSON.stringify(legacy));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
