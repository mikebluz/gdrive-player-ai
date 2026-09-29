// PROBE — every ✺ Variation option has an on/off switch you can compare with.
//
// user, 2026-09-28: "all options in Variation need on/off toggles so user can
// compare what it's like with them on or off".
//
// One mechanism for all of them (`_ambVarOptSet`): OFF parks the value in
// `varOff` and writes 0 — which every reader already treats as off — and ON puts
// it back. So each check here is the whole contract, driven the way a user does:
// open the card's chip, MEASURE the switch where it is (the reachability rule —
// a querySelector hit proves nothing), TAP it with a real touch, and read the
// config: value 0 + memory kept, then back to exactly what it was.
//
//   node test/probe-varopt-toggles.js      (needs `npm start`; BLOOPS_URL to retarget)
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
  await zz(900);
  // press the Arrangement tab ONCE (a second press closes the pane)
  await page.evaluate(() => {
    const t = document.querySelector('.ambient-tabsec-tab[data-tab="progsec"]'); if (t) t.click();
  });
  await zz(600);
  // an area WITH changes and every option set, so all six cards are offered
  await page.evaluate(() => {
    const E = _masterEng; let c = E.getCfg();
    // a layer to push/pull (a fresh headless workspace has none)
    try { if (!_ambMixerLayers(c).length) _ambAddPreset(E, { layers: [{ type: 'bed' }, { type: 'beat' }] }); } catch (e) {}
    c = E.getCfg();
    c.prog.on = true;
    c.prog.chords = [{ root: 0, intervals: [0, 4, 7], bars: 2 }, { root: 5, intervals: [0, 3, 7], bars: 2 }];
    c.prog.salt = { colors: 3, scatter: 35 };
    c.prog.vary = 45; c.prog.tension = 40; c.prog.reroll = 50;
    c.prog.rubato = { amount: 60 };
    c.groove = Object.assign(c.groove || {}, { swing: 30, accent: 40, density: 20, ghost: 25, rolls: 15, streak: 35, couple: 45 });
    c.startVary = 22;
    E.getCfg();
    try { _ambSyncControls(E); } catch (e) {}
    try { _ambRenderProgOverview(E); } catch (e) {}
    try { _ambRenderGroove(E); } catch (e) {}
  });
  await zz(600);
  // ✺ Variation is CLOSED by default — open its accordion like a user would
  await page.evaluate(() => {
    const g = document.querySelector('.ambient-proggrp[data-grp="✺ Variation"] > .ambient-grp-head');
    if (g && !g.parentElement.classList.contains('open')) g.click();
  });
  await zz(500);

  const openCard = async (pov) => {
    const r = await page.evaluate((pov) => {
      const b = document.querySelector('.ambient-pov-varstrip [data-pov="' + pov + '"]');
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const q = b.getBoundingClientRect();
      return { x: q.left + q.width / 2, y: q.top + q.height / 2, w: q.width };
    }, pov);
    if (!r || !r.w) return false;
    await page.touchscreen.tap(r.x, r.y);
    await zz(700);
    return page.evaluate(() => !!document.querySelector('.ambient-grppop-host'));
  };
  const closeCard = async () => {
    await page.evaluate(() => { const a = document.querySelector('.ambient-grp-pop .sm-apply'); if (a) a.click(); });
    await zz(500);
  };
  // measure a switch INSIDE the open popover, then tap its centre
  const measure = (key) => page.evaluate((key) => {
    const host = document.querySelector('.ambient-grppop-host');
    // by CLASS for the novelty switch — every instance prefixes its ids (the
    // master engine's are `mix-bloom-…`), so a bare id finds nothing
    const b = host && host.querySelector(key === 'ambient-nov-ab' ? '.ambient-nov-ab' : ('.ambient-var-opt[data-varopt="' + key + '"]'));
    if (!b) return { there: false };
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const t = b.firstChild && b.firstChild.nodeType === 3 ? b : null;
    return { there: true, w: Math.round(r.width), h: Math.round(r.height), par: !!b.offsetParent,
             x: r.left + r.width / 2, y: r.top + r.height / 2, lit: b.classList.contains('active'),
             clipped: t ? (b.scrollWidth > b.clientWidth + 1) : false, text: b.textContent.trim() };
  }, key);
  const readCfg = () => page.evaluate(() => {
    const c = _masterEng.getCfg(), p = c.prog, g = c.groove || {};
    return {
      colors: (p.salt || {}).colors | 0, scatter: (p.salt || {}).scatter | 0, vary: p.vary | 0,
      tension: p.tension | 0, reroll: p.reroll | 0, rubato: (p.rubato || {}).amount | 0,
      swing: g.swing | 0, accent: g.accent | 0, humanize: c.startVary | 0, density: g.density | 0,
      ghost: g.ghost | 0, rolls: g.rolls | 0, streak: g.streak | 0, couple: g.couple | 0,
      progMem: p.varOff || null, grooveMem: g.varOff || null,
    };
  });
  const memOf = (st, key) => {
    const m = ['swing', 'accent', 'humanize', 'density', 'ghost', 'rolls', 'streak', 'couple'].indexOf(key) >= 0 ? st.grooveMem : st.progMem;
    return m ? (m[key] | 0) : 0;
  };

  const checkOption = async (key, label) => {
    const before = await readCfg();
    const m0 = await measure(key);
    ok(label + ': a switch is on screen in the popover (measured)',
      m0.there && m0.w > 20 && m0.h > 14 && m0.par, JSON.stringify(m0));
    ok(label + ': …names the option and starts LIT', m0.lit === true && m0.text.length > 1 && !m0.clipped, JSON.stringify(m0));
    if (!m0.there) return;
    await page.touchscreen.tap(m0.x, m0.y);
    await zz(450);
    const off = await readCfg();
    const m1 = await measure(key);
    ok(label + ': tap → OFF — value 0, the setting kept',
      off[key] === 0 && memOf(off, key) === before[key] && m1.lit === false,
      JSON.stringify({ was: before[key], now: off[key], mem: memOf(off, key), lit: m1.lit }));
    // the memory must survive the normalizer (runs on every getCfg)
    const kept = await page.evaluate((key) => { const E = _masterEng; E.getCfg(); E.getCfg(); return true; }, key);
    const off2 = await readCfg();
    ok(label + ': …and the kept value survives normalize', kept && memOf(off2, key) === before[key], JSON.stringify(off2[key === 'humanize' ? 'grooveMem' : 'progMem']));
    await page.touchscreen.tap(m1.x, m1.y);
    await zz(450);
    const on = await readCfg();
    const m2 = await measure(key);
    ok(label + ': tap → ON — exactly what it was, memory cleared',
      on[key] === before[key] && memOf(on, key) === 0 && m2.lit === true,
      JSON.stringify({ want: before[key], got: on[key], mem: memOf(on, key), lit: m2.lit }));
  };

  // ── 🧂 SALT — five dials, five switches, plus the master ─────────────────
  console.log('\n  🧂 Salt');
  ok('the 🧂 Salt card opens', await openCard('grp:salt'));
  for (const [k, l] of [['colors', 'Colours'], ['vary', '🌊 Vary'], ['tension', '🌡 Tension'], ['reroll', '🎲 Take'], ['scatter', 'Scatter']]) {
    await checkOption(k, l);
  }
  // the master is the five at once, and is LIT while any plays (it had no painter)
  {
    const mst = () => page.evaluate(() => { const b = document.querySelector('.ambient-grppop-host .ambient-salt-onoff');
      if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, lit: b.classList.contains('active') }; });
    const a = await mst();
    ok('🧂 Salt master: on screen and LIT while Salt plays', !!a && a.w > 20 && a.lit === true, JSON.stringify(a));
    await page.touchscreen.tap(a.x, a.y); await zz(450);
    const s1 = await readCfg(), b = await mst();
    ok('🧂 Salt master OFF: all five at 0, all five kept, master unlit',
      !s1.colors && !s1.vary && !s1.tension && !s1.reroll && !s1.scatter && s1.progMem &&
      s1.progMem.colors === 3 && s1.progMem.vary === 45 && s1.progMem.scatter === 35 && b.lit === false, JSON.stringify(s1));
    await page.touchscreen.tap(b.x, b.y); await zz(450);
    const s2 = await readCfg(), c2 = await mst();
    ok('🧂 Salt master ON: all five back exactly', s2.colors === 3 && s2.vary === 45 && s2.tension === 40 &&
      s2.reroll === 50 && s2.scatter === 35 && !s2.progMem && c2.lit === true, JSON.stringify(s2));
  }
  // dragging an OFF option's dial turns it back on (no stale "off" beside a live value)
  {
    const r = await page.evaluate(() => {
      const E = _masterEng, c = E.getCfg(); _ambVarOptSet(c, 'vary', false); E.getCfg();
      const el = document.querySelector('.ambient-grppop-host #' + _ambTrId(E, 'ambient-prog-vary')) ||
                 document.querySelector('.ambient-grppop-host input[id$="prog-vary"]');
      const shown = el ? +el.value : -1;
      if (el) { el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })); }
      const c2 = E.getCfg();
      const b = document.querySelector('.ambient-grppop-host .ambient-var-opt[data-varopt="vary"]');
      return { shownWhileOff: shown, live: c2.prog.vary | 0, mem: (c2.prog.varOff || {}).vary | 0, lit: !!(b && b.classList.contains('active')) };
    });
    ok('an OFF option’s dial keeps showing its kept value', r.shownWhileOff === 45, JSON.stringify(r));
    ok('…and dragging it switches it back ON (memory dropped, switch lit)', r.live === 20 && r.mem === 0 && r.lit === true, JSON.stringify(r));
    await page.evaluate(() => { const c = _masterEng.getCfg(); c.prog.vary = 45; _masterEng.getCfg(); try { _ambSyncControls(_masterEng); } catch (e) {} });
  }
  await closeCard();

  // ── ↔ RUBATO ────────────────────────────────────────────────────────────
  console.log('\n  ↔ Rubato');
  ok('the ↔ Rubato card opens', await openCard('grp:rubato'));
  await checkOption('rubato', '↔ Rubato');
  await closeCard();

  // ── 🕺 GROOVE — eight macros + Push / pull ─────────────────────────────
  console.log('\n  🕺 Groove');
  ok('the 🕺 Groove card opens', await openCard('grp:groove'));
  for (const [k, l] of [['swing', 'Swing'], ['accent', 'Accent'], ['humanize', 'Humanize'], ['density', 'Sparse'],
                        ['ghost', 'Ghost'], ['rolls', 'Rolls'], ['streak', 'Streaks'], ['couple', 'Couple']]) {
    await checkOption(k, l);
  }
  {
    // Push / pull — per layer; give one layer an offset first
    const key0 = await page.evaluate(() => {
      const E = _masterEng, c = E.getCfg(); const rows = _ambMixerLayers(c);
      if (!rows.length) return null;
      const L = _ambLayerByKey(E, rows[0].key); L.push = 25; E.getCfg(); _ambRenderGroove(E); return rows[0].key;
    });
    if (!key0) ok('Push / pull: the area has a layer to push', false, 'no layers');
    else {
      await zz(300);
      const m0 = await measure('push');
      ok('Push / pull: a switch is on screen (measured) and LIT', m0.there && m0.w > 20 && m0.par && m0.lit, JSON.stringify(m0));
      await page.touchscreen.tap(m0.x, m0.y); await zz(450);
      const off = await page.evaluate((k) => { const E = _masterEng, c = E.getCfg(); return { push: _ambLayerByKey(E, k).push, mem: ((c.groove.varOff || {}).push || {})[k] }; }, key0);
      const m1 = await measure('push');
      ok('Push / pull OFF: the layer lands on the beat, its offset kept', off.push === 0 && off.mem === 25 && m1.lit === false, JSON.stringify(off));
      await page.touchscreen.tap(m1.x, m1.y); await zz(450);
      const on = await page.evaluate((k) => { const E = _masterEng, c = E.getCfg(); return { push: _ambLayerByKey(E, k).push, mem: c.groove.varOff ? c.groove.varOff.push : null }; }, key0);
      ok('Push / pull ON: the offset is back exactly', on.push === 25 && !on.mem, JSON.stringify(on));
    }
  }
  await closeCard();

  // ── ✺ NOVELTY — applied ⇄ original ───────────────────────────────────────
  console.log('\n  ✺ Novelty');
  ok('the ✺ Novelty card opens', await openCard('grp:novelty'));
  {
    const m0 = await measure('ambient-nov-ab');
    ok('✺ Novelty switch: on screen before any Apply, dim (pressable, explains itself)',
      m0.there && m0.w > 20 && m0.par && await page.evaluate(() => {
        const b = document.querySelector('.ambient-grppop-host .ambient-nov-ab'); return !!(b && b.classList.contains('ambient-var-dim')); }),
      JSON.stringify(m0));
    const before = await page.evaluate(() => JSON.stringify(_masterEng.getCfg().prog));
    await page.evaluate(() => { const a = document.querySelector('.ambient-grppop-host .ambient-nov-apply'); if (a) a.click(); });
    await zz(500);
    const applied = await page.evaluate(() => JSON.stringify(_masterEng.getCfg().prog));
    const m1 = await measure('ambient-nov-ab');
    ok('after ✺ Apply the switch is LIT (Apply’s result is playing)', m1.lit === true && applied !== before, JSON.stringify({ lit: m1.lit, changed: applied !== before }));
    await page.touchscreen.tap(m1.x, m1.y); await zz(450);
    const offState = await page.evaluate(() => JSON.stringify(_masterEng.getCfg().prog));
    const m2 = await measure('ambient-nov-ab');
    const strip = (s) => { const o = JSON.parse(s); delete o.varOff; return JSON.stringify(o); };
    ok('Novelty OFF: the original settings are back', strip(offState) === strip(before) && m2.lit === false,
      JSON.stringify({ same: strip(offState) === strip(before), lit: m2.lit }));
    await page.touchscreen.tap(m2.x, m2.y); await zz(450);
    const onState = await page.evaluate(() => JSON.stringify(_masterEng.getCfg().prog));
    const m3 = await measure('ambient-nov-ab');
    ok('Novelty ON: exactly what Apply wrote, again', strip(onState) === strip(applied) && m3.lit === true,
      JSON.stringify({ same: strip(onState) === strip(applied), lit: m3.lit }));
  }
  await closeCard();

  // ── 🌒 ARC — its switch now LOOKS different on and off ────────────────────
  console.log('\n  🌒 Arc (family audit)');
  ok('the 🌒 Arc card opens', await openCard('grp:arc'));
  {
    const bg = () => page.evaluate(() => { const b = document.querySelector('.ambient-grppop-host .ambient-arc-toggle');
      if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, lit: b.classList.contains('active'), bg: getComputedStyle(b).backgroundColor }; });
    const a = await bg();
    await page.touchscreen.tap(a.x, a.y); await zz(450);
    const b = await bg();
    ok('🌒 Arc: on and off are visibly different (it had no lit style)', !!a && !!b && a.lit !== b.lit && a.bg !== b.bg, JSON.stringify([a, b]));
  }
  await closeCard();

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 6).join('\n  '));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
