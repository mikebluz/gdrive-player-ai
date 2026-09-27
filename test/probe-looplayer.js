// PROBE — ◐ A LOOP LAYER: the shipped recordings become something you can play.
//
// §11 groundwork, user 2026-09-27 ("groundwork only"): `samples/manifest.json` has been
// REGISTERED by `loadSampleManifest` for a while, but a LOOP was excluded from every
// picker in the app ("carries its own tempo, a different animal") — so there was no
// surface one could be chosen from at all.
//
// A loop layer is a fourth VOICE: its content is a fixed recording, it starts on the
// layer's own anchor, it repeats at its OWN length and it is NEVER stretched. It takes
// none of the note machinery — no rhythm, no pitch — and is played at its RECORDED ROOT
// so `playbackRate` is 1.
//
//   node test/probe-looplayer.js        (needs `npm start` on :3001)
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
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(3000);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(900);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click(); });
  await zz(900);

  console.log('\n  ◐ the library');
  const lib = await page.evaluate(() => {
    const loops = (typeof _ambLoopSamples === 'function') ? _ambLoopSamples() : null;
    let all = 0, kinds = {};
    try { sampleSamplers.forEach((m) => { all++; kinds[m.kind || '?'] = (kinds[m.kind || '?'] || 0) + 1; }); } catch (e) {}
    return { loops, all, kinds, built: (window.__sampleStats && window.__sampleStats.built) || null };
  });
  ok('the manifest is registered', lib.all > 0, JSON.stringify(lib.kinds));
  ok('…and its LOOPS are now a list', Array.isArray(lib.loops) && lib.loops.length > 0,
    JSON.stringify((lib.loops || []).slice(0, 2)));
  ok('…each one carrying the length that IS its cycle',
    (lib.loops || []).every((x) => x.seconds > 0), JSON.stringify((lib.loops || []).map((x) => x.seconds)));

  console.log('\n  ◐ the store');
  const store = await page.evaluate(() => {
    const E = _masterEng; _E = E;
    const id = _ambLoopSamples()[0].id;
    const L = E.getCfg().layers[0];
    L.instrument.voice = 'loop'; L.instrument.loopId = id;
    const a = E.getCfg().layers[0].instrument;
    const o = { voice: a.voice, id: a.loopId === id };
    E.getCfg().layers[0].instrument.voice = 'nonsense';
    o.junk = E.getCfg().layers[0].instrument.voice;
    E.getCfg().layers[0].instrument.voice = 'loop';
    E.getCfg().layers[0].instrument.loopId = '';
    o.blankPruned = E.getCfg().layers[0].instrument.loopId === undefined;
    E.getCfg().layers[0].instrument.loopId = id;
    E.getCfg();
    return o;
  });
  ok('a loop layer keeps its voice and its recording', store.voice === 'loop' && store.id === true,
    JSON.stringify(store));
  ok('…an unknown voice still falls back to synth', store.junk === 'synth', JSON.stringify(store));
  ok('…and a blank recording is pruned, not stored', store.blankPruned === true, JSON.stringify(store));

  console.log('\n  ◐ the card');
  const ui = await page.evaluate(async () => {
    const E = _masterEng;
    try { _ambRebuildMaster(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 900));
    const card = document.querySelector('.v2-layer');
    if (!card) return { err: 'no card' };
    card.classList.remove('collapsed');
    [...card.querySelectorAll('.ambient-grp')].forEach((g) => g.classList.add('open'));
    await new Promise((r) => setTimeout(r, 300));
    const row = card.querySelector('[data-v2when="voice:loop"]');
    const sel = row && row.querySelector('[data-f="instrument.loopId"]');
    const fam = card.querySelector('[data-v2when="voice:synth"]');
    const r = sel ? sel.getBoundingClientRect() : null;
    const vsel = card.querySelector('[data-f="instrument.voice"]');
    return {
      row: !!row, opts: sel ? sel.options.length : 0,
      reach: !!(sel && sel.offsetParent && r.width > 40 && r.height > 14),
      value: sel ? sel.value : null,
      // the pitched rows fall away on their own — they were always gated
      synthHidden: !!(fam && !fam.offsetParent),
      voiceOffers: vsel ? [...vsel.options].map((o) => o.value) : [],
    };
  });
  ok('the Recording row is on the card for a loop layer', !ui.err && ui.row === true && ui.opts > 1,
    JSON.stringify(ui));
  ok('…measurable, not merely present', ui.reach === true, JSON.stringify([ui.reach, ui.value]));
  ok('…the voice picker offers it beside the other three',
    JSON.stringify(ui.voiceOffers) === '["synth","kit","speech","loop"]', JSON.stringify(ui.voiceOffers));
  ok('…and the pitched rows fall away without being told', ui.synthHidden === true, JSON.stringify(ui.synthHidden));

  console.log('\n  ◐ what plays');
  const heard = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    const id = _ambLoopSamples()[0];
    const L = E.getCfg().layers[0];
    L.instrument.voice = 'loop'; L.instrument.loopId = id.id;
    E.getCfg();
    window.__notes = [];
    if (!window.__pnWrapped) {
      window.__pnWrapped = 1;
      const pn = window.playNote;
      window.playNote = function (f, params, dur, at) {
        try { window.__notes.push({ at: +at || 0, d: +dur || 0, t: params && params.type, f: Math.round(f) }); } catch (e) {}
        return pn.apply(this, arguments);
      };
    }
    try { await Tone.start(); } catch (e) {}
    try { await Tone.getContext().rawContext.resume(); } catch (e) {}
    const b = document.getElementById('mix-bloom-play-btn'); if (b) b.click();
    await new Promise((r) => setTimeout(r, 9000));
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 300));
    const ns = (window.__notes || []).slice();
    const gaps = [];
    for (let i = 1; i < ns.length; i++) gaps.push(Math.round((ns[i].at - ns[i - 1].at) * 100) / 100);
    return { want: id, n: ns.length, types: [...new Set(ns.map((x) => x.t))],
             durs: [...new Set(ns.map((x) => Math.round(x.d)))], gaps,
             freqs: [...new Set(ns.map((x) => x.f))] };
  });
  ok('a loop layer plays its recording', heard.n > 0 &&
    heard.types.every((t) => t === 'sample:' + heard.want.id), JSON.stringify(heard).slice(0, 220));
  ok('…for its own natural length, never stretched to a cycle',
    heard.durs.length === 1 && Math.abs(heard.durs[0] - Math.round(heard.want.seconds * 1000)) <= 1,
    JSON.stringify([heard.durs, heard.want.seconds]));
  ok('…repeating at that same length',
    heard.gaps.length === 0 || heard.gaps.every((g) => Math.abs(g - heard.want.seconds) < 0.05),
    JSON.stringify(heard.gaps));
  ok('…at its recorded root, so nothing transposes it',
    heard.freqs.length === 1, JSON.stringify(heard.freqs));

  const silent = await page.evaluate(async () => {
    const E = _masterEng;
    E.getCfg().layers[0].instrument.loopId = '';
    E.getCfg();
    window.__notes = [];
    const b = document.getElementById('mix-bloom-play-btn'); if (b) b.click();
    await new Promise((r) => setTimeout(r, 3000));
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 200));
    return { n: (window.__notes || []).length };
  });
  ok('with no recording chosen it plays NOTHING — a guessed substitute is worse than silence',
    silent.n === 0, JSON.stringify(silent));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
