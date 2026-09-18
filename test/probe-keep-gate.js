// PROBE — the take keep-gate, end to end in the real app.
// Temporary: the shared UI gate (test/ui-lifecycle.js) is red at this branch's
// HEAD for an unrelated reason (`.v2-capture` was removed from the card on
// 2026-09-17 and the gate still drives it in eight places, so the run dies in
// `capFaces` before reaching anything else). This drives the same page the same
// way, for the one flow that changed.
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
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  // the card, through the real door — exactly as test/ui-lifecycle.js drives it
  const doorOpened = await page.evaluate(() => {
    const b = document.getElementById('mix-bloom-add-layer'); if (!b) return 'no + Add layer button';
    b.scrollIntoView({ block: 'center' }); b.click(); return null;
  });
  await zz(600);
  const doorPicked = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (!bs.length) return 'Add-layer popover did not open';
    const t = bs.find((x) => x.textContent.trim() === 'Layer');
    if (!t) return 'no "Layer": ' + bs.map((x) => x.textContent.trim()).join(' | ');
    t.click(); return null;
  });
  await zz(800);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(700);
  const added = doorOpened || doorPicked || 'ok';
  const haveCard = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    if (c) c.classList.remove('collapsed');
    return !!c;
  });
  ok('a v2 layer card exists to drive', haveCard, 'added=' + added);
  if (!haveCard) { console.log('\nprobe: ' + pass + ' passed, ' + (fail + 1) + ' failed'); await browser.close(); process.exit(1); }
  await zz(400);

  // OPEN THE CONTENT GROUP — the drawing and the take bar live in it, and a
  // freshly added card has it closed. Through its own head, the way a finger
  // would: measuring a control inside a closed fold is the documented 0×0 tell.
  await page.evaluate(() => {
    const g = document.querySelector('.v2-layer .ambient-grp[data-v2grp="Content"]');
    const hd = g && g.querySelector('.ambient-grp-head');
    if (hd) hd.click();
  });
  await zz(600);

  // ---- 1. 💾 Save this take is gone; 🎲 New take is reachable --------------
  // MEASURED IN THE VIEW THE USER HAS OPEN, and across the whole FAMILY: the
  // drawing is rendered into the card body AND into the section sheet, so a
  // `querySelector` hit is the wrong question — "is any of them a real box"
  // is the right one (the documented 0×0 tell).
  const bar = await page.evaluate(() => {
    const c = document.querySelector('.v2-layer');
    const all = [...c.querySelectorAll('.v2-newtake')].map((nt) => {
      const r = nt.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vis: !!nt.offsetParent };
    });
    return { save: c.querySelectorAll('.v2-savetake').length, all,
             live: all.filter((x) => x.vis && x.w > 40 && x.h > 20).length,
             faces: [...c.querySelectorAll('.v2-takebar .ambient-seg')].map((b) => b.textContent.trim()) };
  });
  ok('the take bar no longer carries 💾 Save this take, and is three buttons wide',
    bar.save === 0 && bar.faces.length >= 3 &&
    /New take/.test(bar.faces[0]) && !bar.faces.some((f) => /Save this take/.test(f)),
    JSON.stringify(bar));
  ok('🎲 New take is REACHABLE — a real rect, not a 0×0',
    bar.live >= 1, JSON.stringify(bar));

  // ---- 2. a take with notes: the gate opens and offers three answers -------
  const seed = async () => page.evaluate(() => {
    const E = _masterEng;
    const L = (E.getCfg().layers || [])[0];
    L.part.kind = 'recorded'; L.part.bars = 1; L.part.made = 'take';
    L.part.rhythm = { kind: 'pulse', n: 4, steps: 16 };
    L.part.notes = [{ t: 0, midi: 60, dur: 0.25 }, { t: 0.25, midi: 64, dur: 0.125 },
                    { t: 0.5, midi: 67, dur: 0.0625 }, { t: 0.75, midi: 72, dur: 0.25 }];
    E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
  });
  await seed(); await zz(500);
  await page.evaluate(() => document.querySelector('.v2-layer').classList.remove('collapsed'));
  const gate = await page.evaluate(() => {
    document.querySelector('.v2-layer .v2-newtake').click();
    const pop = document.querySelector('.ambient-addpop');
    if (!pop) return null;
    return { title: (pop.querySelector('.sm-title') || {}).textContent || '',
             head: (pop.querySelector('.addpop-head') || {}).textContent || '',
             btns: [...pop.querySelectorAll('.addpop-btn')].map((x) => x.textContent.trim()),
             close: !!pop.querySelector('.addpop-close'),
             danger: pop.querySelectorAll('.addpop-btn.danger').length };
  });
  ok('🎲 New take opens the keep-gate instead of rolling',
    !!gate && /keep this one/i.test(gate.title), JSON.stringify(gate));
  ok('…with THREE answers: save, roll over it, and close',
    !!gate && gate.btns.length === 2 && gate.close &&
    /Save it to the bank/.test(gate.btns[0]) && /this take is gone/.test(gate.btns[1]) &&
    gate.danger === 1, JSON.stringify(gate && gate.btns));
  ok('…and the head counts what is at risk',
    !!gate && /4 notes/.test(gate.head) && /cannot be undone/.test(gate.head), (gate || {}).head);

  // ---- 3. CLOSE is a cancel — nothing rolls -------------------------------
  const closed = await page.evaluate(async () => {
    const snap = () => JSON.stringify((((_masterEng.getCfg().layers || [])[0]).part.notes || [])
      .map((n) => [Math.round(n.t * 1000), n.midi]));
    const before = snap();
    const b = document.querySelector('.ambient-addpop .addpop-close');
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 60));
    return { same: snap() === before, gone: !document.querySelector('.ambient-addpop') };
  });
  await zz(300);
  ok('Close changes nothing — the take is still there', closed.same && closed.gone, JSON.stringify(closed));

  // ---- 4. DISCARD rolls -------------------------------------------------
  const rolled = await page.evaluate(async () => {
    const snap = () => JSON.stringify((((_masterEng.getCfg().layers || [])[0]).part.notes || [])
      .map((n) => [Math.round(n.t * 1000), n.midi]));
    const before = snap();
    document.querySelector('.v2-layer .v2-newtake').click();
    const b = [...document.querySelectorAll('.ambient-addpop .addpop-btn')]
      .find((x) => /this take is gone/.test(x.textContent));
    if (!b) return { err: 'no discard' };
    b.click();
    await new Promise((r) => setTimeout(r, 500));
    return { changed: snap() !== before, n: (((_masterEng.getCfg().layers || [])[0]).part.notes || []).length };
  });
  await zz(400);
  ok('“Roll over it” rolls a new take', !rolled.err && rolled.changed && rolled.n > 0, JSON.stringify(rolled));

  // ---- 5. SAVE banks the take, then rolls --------------------------------
  await page.evaluate(() => { document.querySelector('.v2-layer').classList.remove('collapsed'); });
  await seed(); await zz(500);
  await page.evaluate(() => document.querySelector('.v2-layer').classList.remove('collapsed'));
  const savedRun = await page.evaluate(async () => {
    const E = _masterEng;
    const P = () => ((E.getCfg().layers || [])[0]).part;
    const cells = (n) => Math.max(1, Math.round(n.dur * 16));
    const before = JSON.stringify((P().notes || []).map((n) => [Math.round(n.t * 1000), n.midi, cells(n)]));
    window.prompt = () => 'probe-take'; window.confirm = () => true;
    document.querySelector('.v2-layer .v2-newtake').click();
    const b = [...document.querySelectorAll('.ambient-addpop .addpop-btn')]
      .find((x) => /Save it to the bank/.test(x.textContent));
    if (!b) return { err: 'no save answer' };
    b.click();
    await new Promise((r) => setTimeout(r, 700));
    const ent = savedSequences.find((x) => x && x.name === 'probe-take');
    const after = JSON.stringify((P().notes || []).map((n) => [Math.round(n.t * 1000), n.midi, cells(n)]));
    return { banked: !!ent, steps: ent ? (ent.steps || []).filter((x) => x && (x.freq != null || x.chord)).length : 0,
             alsoRolled: after !== before, before };
  });
  await zz(400);
  ok('“Save it to the bank” banks the take AND then rolls',
    savedRun.banked && savedRun.steps === 4 && savedRun.alsoRolled, JSON.stringify(savedRun));

  // ---- 6. loading from the bank asks the same question -------------------
  const loadRun = await page.evaluate(async () => {
    const E = _masterEng;
    const P = () => ((E.getCfg().layers || [])[0]).part;
    const cells = (n) => Math.max(1, Math.round(n.dur * 16));
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 400));
    const c = document.querySelector('.v2-layer'); c.classList.remove('collapsed');
    const row = [...c.querySelectorAll('.v2-bankit .v2-bkload')].find((x) => /probe-take/.test(x.textContent));
    if (!row) return { err: 'no bank row' };
    row.click();
    const pop = document.querySelector('.ambient-addpop');
    const o = { gate: !!pop, title: pop ? (pop.querySelector('.sm-title') || {}).textContent : '',
                btns: pop ? [...pop.querySelectorAll('.addpop-btn')].map((x) => x.textContent.trim()) : [] };
    const b = pop && [...pop.querySelectorAll('.addpop-btn')].find((x) => /what is here is gone/.test(x.textContent));
    if (!b) return Object.assign(o, { err: 'no discard answer' });
    b.click();
    await new Promise((r) => setTimeout(r, 700));
    o.after = JSON.stringify((P().notes || []).map((n) => [Math.round(n.t * 1000), n.midi, cells(n)]));
    o.from = P().from || null;
    return o;
  });
  await zz(400);
  ok('loading from the bank asks first, and names the phrase',
    loadRun.gate && /probe-take/.test(loadRun.title || '') &&
    (loadRun.btns || []).some((b) => /Save this take to the bank/.test(b)),
    JSON.stringify(loadRun).slice(0, 300));
  ok('…and discarding loads it back EXACTLY',
    loadRun.after === savedRun.before && loadRun.from === 'probe-take',
    JSON.stringify({ after: loadRun.after, want: savedRun.before, from: loadRun.from }));

  // ---- 7. nothing to lose ⇒ no gate --------------------------------------
  const empty = await page.evaluate(async () => {
    const E = _masterEng;
    const L = () => ((E.getCfg().layers || [])[0]);
    L().part.kind = 'recorded'; L().part.notes = []; E.getCfg();
    const h = document.getElementById('bloom-v2-layers'); if (h) h._sig = '';
    window._v2.render(E);
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('.v2-layer').classList.remove('collapsed');
    document.querySelector('.v2-layer .v2-newtake').click();
    const gated = !!document.querySelector('.ambient-addpop');
    await new Promise((r) => setTimeout(r, 500));
    return { gated, n: (L().part.notes || []).length };
  });
  await zz(300);
  ok('an EMPTY part asks nothing — it just rolls', !empty.gated && empty.n > 0, JSON.stringify(empty));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
