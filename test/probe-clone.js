// PROBE — ⧉ Clone a layer.
//
// user, 2026-09-23: "add ability to clone a layer".
//
// A clone is only a clone if it plays the same thing, and in this engine the
// layer id IS the seed — so a copy with a new id draws a DIFFERENT melody from
// identical rules unless something carries the draw identity across. That is
// what `seedId` is for, and most of what these checks are about; the rest is
// the ordinary copy contract (every field, the right place in the strip, a
// name you can tell apart) and the promise that a project with no clone in it
// is untouched.
//
//   node test/probe-clone.js         (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(1300);

  // A CHANCE RHYTHM IS PURE SEED — no formula to fall back on, so if the draw
  // identity does not cross, the copy's onsets simply will not match. A walk
  // pitch puts the same question to the pitch axis.
  await page.evaluate(() => {
    const E = _masterEng, L = (E.getCfg().layers || [])[0];
    delete L.part.form;
    L.part.kind = 'euclid';
    L.part.notes = [];
    L.part.bars = 2;
    L.part.rhythm = { kind: 'chance', steps: 16, chance: 55 };
    L.part.pitch = { kind: 'walk', degree: 1, span: 8 };
    L.part.shape = Object.assign({}, L.part.shape, { lenShape: '', lenRatio: 60 });
    E.getCfg();
  });
  await zz(500);

  const before = await page.evaluate(() => (_masterEng.getCfg().layers || []).map((l) => l.id | 0));
  console.log('\n  layers: ' + JSON.stringify(before));
  ok('a layer exists to clone', before.length === 1, JSON.stringify(before));

  // ── THE DOOR ────────────────────────────────────────────────────────────
  // A querySelector hit proves nothing; a 0×0 rect is the tell. The card opens
  // COLLAPSED and the menu is built a tick after the press, into `document.body`.
  await page.evaluate(() => {
    [...document.querySelectorAll('.v2-layer')].forEach((c) => {
      if (c.classList.contains('collapsed')) c.querySelector('.ambient-collapse').click();
    });
  });
  await zz(900);
  await page.evaluate(() => { document.querySelector('.v2-layer .v2-menu').click(); });
  await zz(600);
  const door = await page.evaluate(() => {
    const m = document.querySelector('.ctx-menu');
    if (!m) return { menu: false };
    const btns = [...m.querySelectorAll('button')];
    const i = btns.findIndex((b) => b.textContent.indexOf('Clone layer') >= 0);
    const rm = btns.findIndex((b) => b.textContent.indexOf('Remove layer') >= 0);
    if (i < 0) return { menu: true, there: false, labels: btns.map((b) => b.textContent) };
    const r = btns[i].getBoundingClientRect();
    return { menu: true, there: true, label: btns[i].textContent,
             reachable: r.width > 0 && r.height > 0 && !!btns[i].offsetParent,
             inView: r.right <= document.documentElement.clientWidth + 1 && r.bottom <= window.innerHeight + 1,
             aboveRemove: rm > i, disabled: btns[i].disabled };
  });
  console.log('  ⧉ door: ' + JSON.stringify(door));
  ok('⧉ Clone layer is in the layer menu, sized and fits 390px',
    door.menu && door.there && door.reachable && door.inView && !door.disabled, JSON.stringify(door));
  ok('…above ✕ Remove layer, where the non-destructive rows live',
    door.aboveRemove === true, JSON.stringify({ aboveRemove: door.aboveRemove }));

  // ── DRIVEN BY A REAL PRESS ──────────────────────────────────────────────
  await page.evaluate(() => {
    [...document.querySelectorAll('.ctx-menu button')]
      .find((b) => b.textContent.indexOf('Clone layer') >= 0).click();
  });
  await zz(1200);

  const after = await page.evaluate(() => {
    const ls = _masterEng.getCfg().layers || [];
    // THE COPY CONTRACT IS ABOUT STORED FIELDS. Underscore keys are the
    // generators' own scratch (`part._deg` is the walk's last degree), written
    // by whoever drew last — so they belong to the note-for-note check below,
    // not to this one.
    const bare = (o) => { const c = {};
      Object.keys(o).forEach((k) => { if (k.charAt(0) !== '_') c[k] = o[k]; }); return c; };
    const strip = (o) => { const c = bare(JSON.parse(JSON.stringify(o)));
      delete c.id; delete c.seedId; delete c.name;
      if (c.part && typeof c.part === 'object') c.part = bare(c.part);
      return c; };
    // NAMES THE FIELD, one level into `part` — "the bodies differ" is not a
    // diagnosis, and this check is the one that catches a field that stops
    // being copied.
    const dk = (a, b, pre) => [...new Set(Object.keys(a).concat(Object.keys(b)))]
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .reduce((out, k) => out.concat(
        (pre === '' && k === 'part' && a[k] && b[k]) ? dk(a[k], b[k], 'part.') : [pre + k]), []);
    const diffKeys = (a, b) => dk(a, b, '');
    return { n: ls.length, ids: ls.map((l) => l.id | 0), names: ls.map((l) => l.name),
             seeds: ls.map((l) => (l.seedId === undefined ? null : (l.seedId | 0))),
             sameBody: ls.length === 2 &&
               JSON.stringify(strip(ls[0])) === JSON.stringify(strip(ls[1])),
             diff: ls.length === 2 ? diffKeys(strip(ls[0]), strip(ls[1])) : null,
             srcSeed: ls[0] && ls[0].seedId };
  });
  console.log('  after:  ' + JSON.stringify(after));
  ok('the press makes exactly one more layer', after.n === 2, JSON.stringify(after));
  ok('…directly below the one it came from, with its own id',
    after.ids.length === 2 && after.ids[1] !== after.ids[0] &&
    after.ids[1] > after.ids[0], JSON.stringify(after.ids));
  ok('…every other field copied, whole', after.sameBody === true,
    'differing keys: ' + JSON.stringify(after.diff));
  ok('the copy carries the SOURCE’s draw identity, the original carries none',
    after.seeds[0] === null && after.seeds[1] === after.ids[0],
    JSON.stringify({ seeds: after.seeds, ids: after.ids }));
  // A LAYER ARRIVES WITH A GENERATED NAME ("Folded", "Peaceful"), which IS a
  // name — so the copy says what it came from rather than inventing a second,
  // unrelated word for the same material.
  ok('the copy is named after what it came from',
    after.names[1] === after.names[0] + ' copy', JSON.stringify(after.names));

  // ── THE POINT OF ALL OF IT: IT PLAYS THE SAME NOTES ─────────────────────
  const heard = await page.evaluate(async () => {
    const E = _masterEng, V = window._v2;
    E._progAnchor = 0; E._playStartAt = 0; E._barGridAnchor = 0;
    const ask = (L) => {
      const cyc = V.cycleSec(L, E.getCfg());
      return (V.withEdit(() => V.withTake(0, () => V.notesFor(L,
        { E, cfg: E.getCfg(), key: 'v2:' + L.id, cycleStart: 0, cycleSec: cyc }))) || [])
        .slice().sort((a, b) => a.at - b.at)
        .map((n) => Math.round(n.at * 1000) + '@' + Math.round(n.freq || 0));
    };
    const ls = E.getCfg().layers || [];
    return { a: ask(ls[0]), b: ask(ls[1]) };
  });
  console.log('  heard:  ' + heard.a.length + ' notes vs ' + heard.b.length);
  ok('the copy plays a real part, not an empty one', heard.a.length >= 4, JSON.stringify(heard.a.length));
  ok('…and it is the SAME part, note for note',
    heard.a.length === heard.b.length && heard.a.join('|') === heard.b.join('|'),
    JSON.stringify({ a: heard.a.slice(0, 6), b: heard.b.slice(0, 6) }));

  // ── A NAME YOU TYPED IS YOURS, AND STAYS DISTINCT ───────────────────────
  const named = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const src = (E.getCfg().layers || [])[0];
    src.name = 'Pads'; E.getCfg();
    const c1 = V.cloneLayer(E, (E.getCfg().layers || [])[0]);
    // WITH A LAYER BELOW IT, "directly below" and "at the end" stop being the
    // same place — which is the only arrangement that can tell them apart.
    const ls1 = E.getCfg().layers || [];
    const at1 = ls1.map((l) => l.id | 0).indexOf(c1 ? (c1.id | 0) : -1);
    const c2 = V.cloneLayer(E, (E.getCfg().layers || [])[0]);
    return { first: c1 && c1.name, second: c2 && c2.name, at1, tail: ls1.length - 1,
             all: (E.getCfg().layers || []).map((l) => l.name) };
  });
  console.log('  named:  ' + JSON.stringify(named));
  ok('a chosen name survives as "<name> copy"', named.first === 'Pads copy', JSON.stringify(named));
  ok('…and with a layer below it, the copy still lands directly below its source',
    named.at1 === 1 && named.tail > 1, JSON.stringify({ at: named.at1, tail: named.tail }));
  ok('…and the next one numbers rather than collides',
    named.second === 'Pads copy 2' &&
    new Set(named.all).size === named.all.length, JSON.stringify(named));

  // …and the one name that is NOT a choice — `normLayer`'s fallback for a layer
  // that never got one — hands its copy the same fallback, not "Layer 3 copy".
  const fallback = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const L0 = (E.getCfg().layers || [])[0];
    const was = L0.name;
    L0.name = 'Layer ' + (L0.id | 0); E.getCfg();
    const c = V.cloneLayer(E, (E.getCfg().layers || [])[0]);
    const got = c && c.name, cid = c && (c.id | 0);
    const cfg = E.getCfg();
    cfg.layers = cfg.layers.filter((x) => (x.id | 0) !== cid);
    cfg.layers[0].name = was; E.getCfg();
    return { got, cid };
  });
  console.log('  fallbk: ' + JSON.stringify(fallback));
  ok('an unnamed layer takes the same fallback again, not "Layer 3 copy"',
    fallback.got === 'Layer ' + fallback.cid, JSON.stringify(fallback));

  // ── A CLONE OF A CLONE, AND ↔ ANSWER ────────────────────────────────────
  const chain = await page.evaluate(() => {
    const E = _masterEng, V = window._v2;
    const ls = E.getCfg().layers || [];
    const src = ls[0], copy = ls.find((l) => l.name === 'Pads copy');
    src.part.answer = { src: ls[ls.length - 1].id | 0 };
    E.getCfg();
    const gc = V.cloneLayer(E, copy);
    const again = V.cloneLayer(E, E.getCfg().layers[0]);
    return { srcId: src.id | 0, copySeed: copy.seedId | 0, grandSeed: gc && (gc.seedId | 0),
             answered: again && again.part && again.part.answer && (again.part.answer.src | 0),
             wanted: ls[ls.length - 1].id | 0 };
  });
  console.log('  chain:  ' + JSON.stringify(chain));
  ok('a clone of a clone keeps the ORIGINAL’s draw identity',
    chain.grandSeed === chain.srcId && chain.copySeed === chain.srcId, JSON.stringify(chain));
  // ↔ Answer points at a source BY ID: the copy answers what the original
  // answered, rather than being silently re-pointed at the original.
  ok('↔ Answer comes across pointing where it pointed',
    chain.answered === chain.wanted, JSON.stringify(chain));

  // ── ADDITIVE AND ABSENT BY DEFAULT ──────────────────────────────────────
  const norm = await page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.seedId = L.id | 0; E.getCfg();
    const selfSeed = L.seedId;
    L.seedId = 0; E.getCfg();
    const zero = L.seedId;
    L.seedId = -4; E.getCfg();
    const neg = L.seedId;
    const fresh = JSON.stringify(window._v2.defaultLayer() || {});
    return { selfSeed, zero, neg, defHasSeed: fresh.indexOf('seedId') >= 0 };
  });
  console.log('  norm:   ' + JSON.stringify(norm));
  ok('a seedId equal to the layer’s own id is pruned',
    norm.selfSeed === undefined, JSON.stringify(norm));
  ok('…and a zero or negative one never survives normalize',
    norm.zero === undefined && norm.neg === undefined, JSON.stringify(norm));
  ok('a new layer stores no seedId at all',
    norm.defHasSeed === false, JSON.stringify(norm));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 6).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
