// PROBE — ✂ CUT: a held note follows the Tone set instead of keeping the voice it began with.
//
// user, 2026-09-27: "I have each Tone in a Tone Set with 3 Tones to 1 bar, but they
// play for the full part."
//
// Measured then: the set advances correctly, but a voice is chosen at a note's ONSET
// and holds for that note — so a layer that starts one long note per part hears ONE
// voice per part however the set is written. ✂ Cut ends a note at each step edge and
// starts the next voice there. OFF BY DEFAULT: absent, the emit path is untouched and
// golden stays bit-exact.
//
//   node test/probe-tsqcut.js        (needs `npm start` on :3001)
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
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(800);
  await page.evaluate(() => { const b = document.getElementById('mix-bloom-add-layer');
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
  await zz(450);
  await page.evaluate(() => { const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    if (bs.length) (bs.find((x) => x.textContent.trim() === 'Layer') || bs[0]).click() || void setTimeout(() => { const _e = document.querySelector('.g2 [data-a="keepempty"]') || [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')].find((y) => /^Empty/.test(y.textContent.trim())); if (_e) _e.click(); }, 60); });
  await zz(900);

  console.log('\n  ✂ where a held note would change voice');
  const cuts = await page.evaluate(() => {
    const E = _masterEng; _E = E;
    const T0 = 500;
    E._barGridAnchor = T0; E._progAnchor = T0; E._playStartAt = T0; E._t0 = T0;
    const barSec = (60 / Math.max(20, _ambBpm())) * 4;
    const mk = (steps, extra) => ({ toneSeq: Object.assign({ on: 1, steps }, extra || {}),
                                    tone: 'zz', id: 'v2:77' });
    // two voices, a quarter-bar each — edges every half bar
    const q = mk([{ tone: 'sine', bars: 0.25 }, { tone: 'square', bars: 0.25 }]);
    const inOne = _ambToneCuts(q, T0 + 0.01, barSec * 0.2);       // inside one step
    const overOne = _ambToneCuts(q, T0 + 0.01, barSec * 0.4);     // crosses one edge
    const overThree = _ambToneCuts(q, T0 + 0.01, barSec * 0.9);   // crosses three
    const off = _ambToneCuts(mk([{ tone: 'sine', bars: 0.25 }], { on: 0 }), T0, barSec * 4);
    // a PART row is an answer for as long as that part runs — no edge inside it
    const c = E.getCfg();
    const CH = (root) => ({ root, intervals: [0, 4, 7], bars: 1 });
    c.prog.on = true; c.barsPerChord = 1;
    c.prog.chords = [CH(0), CH(5)];
    c.prog.parts = [{ name: 'A', len: 2 }];
    E.getCfg();
    const fixed = _ambToneCuts(mk([{ tone: 'organ', unit: 'part', part: 0 }]), T0 + 0.01, barSec * 4);
    return { barSec, inOne, overOne: overOne.map((t) => +((t - T0) / barSec).toFixed(3)),
             overThree: overThree.length, off, fixed };
  });
  ok('a note inside one step is not cut', JSON.stringify(cuts.inOne) === '[]', JSON.stringify(cuts.inOne));
  ok('a note crossing one edge is cut ONCE, at the edge',
    JSON.stringify(cuts.overOne) === '[0.25]', JSON.stringify(cuts.overOne));
  ok('…and a longer one at every edge it crosses', cuts.overThree === 3, String(cuts.overThree));
  ok('a set that is OFF never cuts', JSON.stringify(cuts.off) === '[]', JSON.stringify(cuts.off));
  ok('…nor does a part row — it is an answer for as long as that part runs',
    JSON.stringify(cuts.fixed) === '[]', JSON.stringify(cuts.fixed));

  // ---- IT REACHES THE NOTES ---------------------------------------------------
  console.log('\n  ✂ what actually plays');
  const heard = async (cut) => page.evaluate(async (cutOn) => {
    const E = _masterEng; _E = E;
    const c = E.getCfg(), L = c.layers[0];
    L.part.kind = 'live';
    L.part.rhythm = { kind: 'pulse', n: 1, steps: 16 };
    L.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 0.25 }, { tone: 'square', bars: 0.25 }] };
    if (cutOn) L.toneSeq.cut = 1; else delete L.toneSeq.cut;
    E.getCfg();
    window.__notes = [];
    if (!window.__pnWrapped) {
      window.__pnWrapped = 1;
      const pn = window.playNote;
      window.playNote = function (f, params, dur, at) {
        try { window.__notes.push({ at: +at || 0, d: +dur || 0, t: params && params.type }); } catch (e) {}
        return pn.apply(this, arguments);
      };
    }
    try { await Tone.start(); } catch (e) {}
    try { await Tone.getContext().rawContext.resume(); } catch (e) {}
    const b = document.getElementById('mix-bloom-play-btn'); if (b) b.click();
    await new Promise((r) => setTimeout(r, 6000));
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 400));
    const ns = (window.__notes || []).slice();
    // group by onset — a chord fires several notes at one time
    const byAt = {};
    ns.forEach((x) => { const k = Math.round(x.at * 100) / 100; (byAt[k] = byAt[k] || []).push(x); });
    const onsets = Object.keys(byAt).map(Number).sort((a, b2) => a - b2);
    return { n: ns.length, onsets: onsets.length,
             types: [...new Set(ns.map((x) => x.t))].sort(),
             durs: [...new Set(ns.map((x) => Math.round(x.d)))].sort((a, b2) => a - b2).slice(0, 6) };
  }, cut);

  const plain = await heard(false);
  const cutOn = await heard(true);
  ok('the layer plays something to cut', plain.n > 0, JSON.stringify(plain));
  ok('OFF: one voice per note — the set is heard only where a note starts',
    plain.types.length === 1, JSON.stringify(plain));
  ok('ON: the same material now speaks in BOTH voices',
    cutOn.types.length === 2, JSON.stringify(cutOn));
  ok('…because it is more, shorter notes — not the same notes relabelled',
    cutOn.n > plain.n, JSON.stringify([plain.n, cutOn.n]));

  // ---- THE CONTROL ------------------------------------------------------------
  console.log('\n  ✂ the switch');
  const ui = await page.evaluate(async () => {
    const E = _masterEng; _E = E;
    const c = E.getCfg(), L = c.layers[0];
    L.toneSeq = { on: 1, steps: [{ tone: 'sine', bars: 1 }, { tone: 'square', bars: 1 }] };
    E.getCfg();
    try { _ambRebuildMaster(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 900));
    const card = document.querySelector('.v2-layer');
    if (!card) return { err: 'no card' };
    card.classList.remove('collapsed');
    [...card.querySelectorAll('.ambient-grp')].forEach((g) => g.classList.add('open'));
    await new Promise((r) => setTimeout(r, 300));
    const box = card.querySelector('.ambient-toneseq-box');
    const b = box && box.querySelector('.ambient-toneseq-cut');
    if (!b) return { err: 'no ✂ button', html: (box || {}).innerHTML ? 'box present' : 'no box' };
    const r = b.getBoundingClientRect();
    const out = { face0: b.textContent.trim(),
                  reach: !!(b.offsetParent && r.width > 20 && r.height > 14) };
    b.click();
    await new Promise((r2) => setTimeout(r2, 300));
    const b2 = card.querySelector('.ambient-toneseq-cut');
    out.face1 = b2 ? b2.textContent.trim() : null;
    out.stored = (E.getCfg().layers[0].toneSeq || {}).cut;
    out.sum = ((card.querySelector('.tsq-sum') || {}).textContent || '');
    // …and with ONE voice there is nothing for it to change
    E.getCfg().layers[0].toneSeq.steps = [{ tone: 'sine', bars: 1 }];
    E.getCfg();
    const box2 = card.querySelector('.ambient-toneseq-box');
    box2.innerHTML = _ambToneSeqBoxHtml(E.getCfg().layers[0]);
    out.goneWithOne = !box2.querySelector('.ambient-toneseq-cut');
    return out;
  });
  ok('the ✂ switch is on the Tone set, and reachable', !ui.err && ui.reach === true, JSON.stringify(ui));
  ok('…its face is the OFFER, then the STATE', /^✂ Cut$/.test(ui.face0 || '') && /Cutting/.test(ui.face1 || ''),
    JSON.stringify([ui.face0, ui.face1]));
  ok('…pressing writes the store', ui.stored === 1, JSON.stringify(ui.stored));
  ok('…and the header says it is doing it', /cutting held notes/.test(ui.sum || ''), JSON.stringify(ui.sum));
  ok('with one voice the switch is absent — nothing for it to change',
    ui.goneWithOne === true, JSON.stringify(ui.goneWithOne));

  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
