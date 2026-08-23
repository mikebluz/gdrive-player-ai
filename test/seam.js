// SEAM HUNT — does a layer play the SAME SHAPE every time a given pass comes
// round? That is the question behind "a slight delay, feels like it skips at
// the boundary", and it is the only one that survives a sparse layer: a motif
// with rests has irregular gaps BY DESIGN, so flagging a gap larger than the
// layer's own median reports its rests as bugs (measured: 31 "holes" in a
// euclid bass that was behaving perfectly).
//
// So: fold every onset into the pass it falls in, take it relative to that
// pass's start, and compare consecutive occurrences of the SAME pass index.
// A stable layer is identical every time; a seam bug is a pass whose shape
// differs from its own previous occurrence.
//
//   node test/seam.js [seconds-per-case]      (needs `npm start` running)
//
// Cases climb in complexity: plain bars → a Passes grid whose passes differ in
// length → a cadence (fractional pass) → both, with four layers. Add cases
// here rather than writing another throwaway probe.
import puppeteer from 'puppeteer-core';
const SECS = Number(process.argv[2] || 34);
const b = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:'new', protocolTimeout: 600000, args:['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(String(e.message)));
await pg.goto('http://localhost:3001/bloops.html',{waitUntil:'networkidle2'});
await pg.evaluate(()=>document.body.classList.add('view-mix'));

const start = (opts) => pg.evaluate(async (opts) => {
  const E=_masterEng; const cfg=E.getCfg();
  cfg.prog = { on:1, name:'T', chords: (opts.bars||[1,1,1,1]).map((bars,i)=>({ root:[0,9,2,7][i], intervals:[0,4,7], ...(bars!==1?{bars}:{}) })) };
  // PARTS + PLAYS. This harness used to hard-delete parts, so every case was a
  // part-less progression — which is exactly the axis a real project has and the
  // reason the reported shape (two parts + plays + phrases + a Passes grid) was
  // uncovered. Each axis was green while the COMBINATION was untested.
  if (opts.parts) cfg.prog.parts = opts.parts.map(([name,len,plays]) => ({ name, len, ...(plays?{plays}:{}) }));
  else delete cfg.prog.parts;
  if (opts.grid) {
    // With parts the grid lives on the PART, not on prog.
    if (opts.parts) { cfg.prog.parts[opts.gridPart||0].grid = opts.grid; delete cfg.prog.grid; }
    else cfg.prog.grid = opts.grid;
  } else { delete cfg.prog.grid; if (cfg.prog.parts) cfg.prog.parts.forEach(x=>{ delete x.grid; }); }
  cfg.extras = []; (opts.layers||['motif']).forEach(t => _ambAddExtra(E, t));
  cfg.extras.forEach(x => { x.mute = 0; });
  // PHRASES (partSeqs) — a banked phrase mapped onto passes. The bank has to be
  // seeded before the layer reads it.
  if (opts.phrases) {
    savedSequences.length = 0;
    Object.entries(opts.phrases.bank).forEach(([name, steps]) => savedSequences.push({ name, steps }));
    cfg.extras.forEach(x => { x.partSeqs = JSON.parse(JSON.stringify(opts.phrases.map)); });
  }
  E.inited=false; _ambientInit(E); _E=E;
  try { await Tone.start(); } catch(e){}
  try { await Tone.getContext().rawContext.resume(); } catch(e){}
  const keys = E.getCfg().extras.map(x=>x.type+':'+x.id);
  window.__h = { keys, seen:{}, edges:[], last:-1, t0:0, clocks:[] };
  keys.forEach(k=>window.__h.seen[k]={});
  await _ambStartGenerator(E);
  window.__h.t0 = Tone.now();
  return keys;
}, opts);

const poll = () => pg.evaluate(() => {
  const E=_masterEng, H=window.__h; if(!H) return;
  const now=Tone.now(), cfg=E._cfg||E.getCfg();
  H.keys.forEach(k => ((E.cap&&E.cap[k])||[]).forEach(ev=>{
    const at=ev.at!=null?ev.at:ev.time; if(at==null) return;
    const kk=at.toFixed(4); if(!(kk in H.seen[k])) H.seen[k][kk]=at; }));
  try { const w=_ambPartChordAt(E,cfg,now);
    const id = (w?w.pi:'-')+':'+(w?w.pass:'-');
    if (w && (id!==H.last)) { H.last=id;
      H.edges.push({ t:+(now-H.t0).toFixed(3), pass:id, pi:w.pi }); } } catch(e){}
  // the layer's own clock: when is its NEXT onset, and what does it think its period is?
  H.keys.forEach(k=>{ try {
    const c=E.clocks&&E.clocks[k];
    H.clocks.push({ k, t:+(now-H.t0).toFixed(2), next: c&&c.next!=null?+(c.next-H.t0).toFixed(3):null,
                    per: (typeof _ambLayerPeriodSec==='function')?+(_ambLayerPeriodSec(E,k)||0).toFixed(3):null });
  } catch(e){} });
});

const finish = () => pg.evaluate(() => {
  const E=_masterEng, H=window.__h; _ambStopGenerator(E);
  const out={ edges:H.edges, layers:{} };
  H.keys.forEach(k=>{
    const on=Object.values(H.seen[k]).sort((a,b)=>a-b).map(x=>+(x-H.t0).toFixed(4));
    // FOLD BY PASS: onsets of each pass, relative to that pass's start. A stable
    // layer plays the same shape every time a given pass comes round.
    const byPass={};
    for (let i=0;i<H.edges.length;i++){
      const e=H.edges[i], nx=H.edges[i+1];
      const lo=e.t, hi=nx?nx.t:1e9;
      const rel=on.filter(x=>x>=lo-1e-6&&x<hi).map(x=>+(x-lo).toFixed(3));
      (byPass[e.pass]=byPass[e.pass]||[]).push({ at:lo, rel });   // e.pass is "pi:pass"
    }
    // compare consecutive occurrences of the SAME pass
    const diffs=[];
    Object.entries(byPass).forEach(([p,runs])=>{
      for (let i=1;i<runs.length;i++){
        const a=JSON.stringify(runs[i-1].rel), c=JSON.stringify(runs[i].rel);
        if (a!==c) diffs.push({ pass:p, at:runs[i].at, prev:runs[i-1].rel.slice(0,8), now:runs[i].rel.slice(0,8) });
      }
    });
    out.layers[k]={ notes:on.length, first:on.slice(0,10),
      perPass:Object.fromEntries(Object.entries(byPass).map(([p,r])=>[p,r.map(x=>x.rel.length)])),
      unstable:diffs.length, diffs:diffs.slice(0,4),
      clocks:(H.clocks.filter(c=>c.k===k)).slice(0,6) };
  });
  return out;
});

const PH = { bank: { riffA: [ {freq:220,duration:0.25,subdivision:1}, {freq:277,duration:0.25,subdivision:1},
                              {freq:330,duration:0.25,subdivision:1}, {freq:440,duration:0.25,subdivision:1} ],
                     riffB: [ {freq:196,duration:0.5,subdivision:1}, {freq:294,duration:0.5,subdivision:1} ] },
             map: { 0: { all: 'riffA', '1:*': 'riffB' } } };
const CASES = [
  ['motif, NO grid',   { bars:[1,1,1,1], layers:['motif'] }],
  ['motif, passes',    { bars:[1,1,1,1], grid:{ cols:3, seq:{ 1:[0,2], 2:[0,1,2] }, len:4 }, layers:['motif'] }],
  ['bed, passes',      { bars:[1,1,1,1], grid:{ cols:3, seq:{ 1:[0,2], 2:[0,1,2] }, len:4 }, layers:['bed'] }],
  // THE REPORTED SHAPE: two parts, plays, phrases mapped onto passes, and a
  // Passes grid — each axis was already covered somewhere, the combination by
  // nothing.
  ['2 parts + plays',        { bars:[1,1,1,1], parts:[['Verse',2,2],['Chorus',2]], layers:['motif'] }],
  ['2 parts + passes',       { bars:[1,1,1,1], parts:[['Verse',2,2],['Chorus',2]],
                               grid:{ cols:2, seq:{ 1:[1] }, len:2 }, layers:['motif'] }],
  ['2 parts + phrases',      { bars:[1,1,1,1], parts:[['Verse',2,2],['Chorus',2]],
                               phrases:PH, layers:['motif'] }],
  ['2 parts + all of it',    { bars:[1,1,1,1], parts:[['Verse',2,2],['Chorus',2]],
                               grid:{ cols:2, seq:{ 1:[1] }, len:2 }, phrases:PH,
                               layers:['motif','bed'] }],
];
for (const [name,opts] of CASES){
  await start(opts);
  const end=Date.now()+SECS*1000;
  while (Date.now()<end){ await new Promise(r=>setTimeout(r,130)); await poll(); }
  const r=await finish();
  console.log('\n=== '+name);
  console.log('  passes: '+JSON.stringify(r.edges.slice(0,10).map(e=>e.pass+'@'+e.t)));
  for (const [k,v] of Object.entries(r.layers)){
    console.log('  '+k+': notes '+v.notes+' · per-pass counts '+JSON.stringify(v.perPass)+' · UNSTABLE '+v.unstable);
    console.log('     first onsets '+JSON.stringify(v.first));
    if (v.diffs.length) v.diffs.forEach(d=>console.log('     pass '+d.pass+' @'+d.at+'  was '+JSON.stringify(d.prev)+'  now '+JSON.stringify(d.now)));
    console.log('     clocks '+JSON.stringify(v.clocks));
  }
  await new Promise(r=>setTimeout(r,300));
}
console.log('\npageerrors:', errs.slice(0,4));
await b.close();
