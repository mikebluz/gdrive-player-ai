// REPLAY A REAL PROJECT — the answer to "I can't reproduce it".
//
// Every round of guesswork in this area came from me approximating the user's
// project and testing my approximation. `bloomDump()` in the browser console
// hands over the actual area config, the banked phrases it references, and each
// layer's live freeze state; this loads that JSON into a headless engine, plays
// it, and reports what each layer DID — per pass, with the numbers that
// distinguish the failure modes we keep meeting:
//
//   • loop length vs the chord and vs the pass       (a phrase fitted to the wrong frame)
//   • same-pitch onsets within 40 ms                 (a comb — two copies competing)
//   • gaps across a pass boundary vs within a pass   (the seam hole)
//   • the progress bar's period                      (what the bar is actually reporting)
//
//   node test/replay.js dump.json [seconds] [--layer motif:1]
//
// Needs `npm start` running. Save the pasted dump to a file first.
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const file = process.argv[2];
if (!file) { console.error('usage: node test/replay.js <dump.json> [seconds] [--layer key]'); process.exit(2); }
const SECS = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 40;
const only = (process.argv.find(a => a.startsWith('--layer')) || '').split('=')[1] || null;
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));

const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(String(e.message)));
await pg.goto('http://localhost:3001/bloops.html', { waitUntil: 'networkidle2' });
await pg.evaluate(() => document.body.classList.add('view-mix'));

const keys = await pg.evaluate(async (d) => {
  const E = _masterEng;
  // Load the project verbatim — the whole point is that nothing here is a
  // reconstruction. The bank is restored first so a mapped phrase resolves.
  try { savedSequences.length = 0; (d.seqs || []).forEach(x => savedSequences.push(x)); } catch (e) {}
  const cur = E.getCfg();
  Object.keys(cur).forEach(k => { delete cur[k]; });
  Object.assign(cur, JSON.parse(JSON.stringify(d.cfg)));
  E.inited = false; _ambientInit(E); _E = E;
  try { await Tone.start(); } catch (e) {}
  try { await Tone.getContext().rawContext.resume(); } catch (e) {}
  const c = E.getCfg();
  const ks = [];
  ['bed', 'motif', 'texture', 'beat'].forEach(k => { if (c[k] && c[k].present !== false) ks.push(k); });
  (c.extras || []).forEach(x => { if (x && x.type != null && x.id != null) ks.push(x.type + ':' + x.id); });
  window.__R = { ks, t0: 0, notes: {}, edges: [], last: -1, bar: {}, loop: {} };
  ks.forEach(k => { window.__R.notes[k] = []; window.__R.bar[k] = []; window.__R.loop[k] = []; });
  await _ambStartGenerator(E);
  window.__R.t0 = Tone.now();
  return ks;
}, dump);

console.log('layers: ' + keys.join(', '));
console.log('(from the dump) ' + (dump.layers || []).map(l =>
  l.key + (l.mapped ? ' mapped→' + l.mappedTo : '') + (l.composed ? ' composed' : '') +
  (l.write ? ' write ' + l.write : '')).join(' · '));

const end = Date.now() + SECS * 1000;
while (Date.now() < end) {
  await new Promise(r => setTimeout(r, 110));
  await pg.evaluate(() => {
    const E = _masterEng, R = window.__R, now = Tone.now(), cfg = E._cfg || E.getCfg();
    const rel = +(now - R.t0).toFixed(4);
    try { _ambUpdatePlayheadsCore(E); } catch (e) {}
    R.ks.forEach(k => {
      ((E.cap && E.cap[k]) || []).forEach(ev => {
        const at = ev.at != null ? ev.at : ev.time, f = ev.freq != null ? ev.freq : ev.f;
        if (at == null) return;
        const kk = at.toFixed(4) + '/' + (f ? Math.round(f) : 0);
        if (!R.notes[k].some(n => n.kk === kk)) R.notes[k].push({ kk, at: +(at - R.t0).toFixed(4), f: f ? Math.round(f) : 0 });
      });
      const el = [...document.querySelectorAll('.ambient-ph')].find(x => x.dataset.phkey === k);
      if (el) { const v = parseFloat(getComputedStyle(el).getPropertyValue('--ph')); if (!isNaN(v)) R.bar[k].push({ t: rel, v: +v.toFixed(3) }); }
      const fsx = E.freeze && E.freeze[k];
      const L = fsx && fsx.loopLen ? +fsx.loopLen.toFixed(3) : null;
      const arr = R.loop[k]; if (!arr.length || arr[arr.length - 1].L !== L) arr.push({ t: rel, L });
    });
    try { const w = _ambPartChordAt(E, cfg, now);
      if (w && w.pass !== R.last) { if (rel > 0.6) R.edges.push(rel); R.last = w.pass; } } catch (e) {}
  });
}

const r = await pg.evaluate(() => {
  const E = _masterEng, R = window.__R; _ambStopGenerator(E);
  const out = { edges: R.edges, layers: {} };
  R.ks.forEach(k => {
    const on = R.notes[k].slice().sort((a, b) => a.at - b.at);
    const gaps = []; for (let i = 1; i < on.length; i++) gaps.push(+(on[i].at - on[i - 1].at).toFixed(4));
    const dbl = []; for (let i = 1; i < on.length; i++)
      for (let j = i - 1; j >= 0 && on[i].at - on[j].at < 0.04; j--)
        if (on[j].f === on[i].f) dbl.push({ at: on[i].at, f: on[i].f, dt: +(on[i].at - on[j].at).toFixed(4) });
    // the bar's own period: time between resets
    const bs = R.bar[k], res = [];
    for (let i = 1; i < bs.length; i++) if (bs[i].v < bs[i - 1].v - 0.2) res.push(bs[i].t);
    const per = []; for (let i = 1; i < res.length; i++) per.push(+(res[i] - res[i - 1]).toFixed(2));
    // gap ACROSS each pass edge vs the layer's own median
    const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 0;
    const across = R.edges.map(e => {
      let before = null, after = null;
      on.forEach(n => { if (n.at < e) before = n.at; if (after == null && n.at >= e) after = n.at; });
      return (before != null && after != null) ? +(after - before).toFixed(3) : null;
    }).filter(x => x != null);
    out.layers[k] = { notes: on.length, medianGap: med, doubles: dbl.length, doubleSample: dbl.slice(0, 4),
      loopChanges: R.loop[k].slice(0, 8), barPeriods: per.slice(0, 8),
      gapAcrossEdges: across.slice(0, 8),
      lateAtEdges: across.filter(g => med > 0 && g > med * 1.6).length };
  });
  return out;
});

console.log('\npass boundaries (s): ' + JSON.stringify(r.edges.slice(0, 12)));
for (const [k, v] of Object.entries(r.layers)) {
  if (only && k !== only) continue;
  console.log('\n[' + k + ']  notes ' + v.notes + '  median gap ' + v.medianGap);
  console.log('   loop length over time  ' + JSON.stringify(v.loopChanges));
  console.log('   bar period between resets ' + JSON.stringify(v.barPeriods));
  console.log('   gap across pass edges  ' + JSON.stringify(v.gapAcrossEdges) +
              (v.lateAtEdges ? '   <-- LATE at ' + v.lateAtEdges + ' edge(s)' : '   (on time)'));
  console.log('   same-pitch doubles <40ms: ' + v.doubles + (v.doubles ? '  ' + JSON.stringify(v.doubleSample) : ''));
}
console.log('\npageerrors: ' + JSON.stringify(errs.slice(0, 4)));
await b.close();
