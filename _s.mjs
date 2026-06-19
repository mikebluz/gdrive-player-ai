import puppeteer from 'puppeteer-core';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--autoplay-policy=no-user-gesture-required','--no-sandbox']});
const page=await browser.newPage(); await page.setViewport({width:760,height:1100});
const errs=[]; page.on('pageerror',e=>errs.push('PE: '+e.message));
await page.goto('http://localhost:3001/bloops.html',{waitUntil:'networkidle2'});
await new Promise(r=>setTimeout(r,1400));
const g=(e)=>page.evaluate(x=>window.eval(x),e);
await g(`(function(){ ensureLanesInitialized(); gridRows=3; _resizeLanesToGridRows(); lanes.forEach((l,i)=>{l.name='L'+i; l.collapsed=false; l.steps=[{freq:262,label:'C4',cellIndex:0,sound:'sawtooth',params:{type:'sawtooth'},duration:1,subdivision:1}];}); _laneExpanderOpen=true; activeLaneIdx=0; renderSequence(); _placeLaneExpander(); return 'ok'; })()`);
// visual order helper (top->bottom by bounding rect)
const visOrder = ()=> page.evaluate(()=>{
  const d=document.getElementById('sequence-display');
  return Array.from(d.children).map(c=>({label: c.id==='lane-expander'?'[GRID]': c.id==='step-edit-row'?'[edit]': (c.querySelector?.('.lane-status')?.textContent||c.id||'?')+(c.classList?.contains('active')?'*':''), y: c.getBoundingClientRect().top}))
    .filter(o=>o.y>=0).sort((a,b)=>a.y-b.y).map(o=>o.label);
});
console.log('active=0:', JSON.stringify(await visOrder()));
await page.evaluate(()=>{ const rows=document.querySelectorAll('#sequence-display .lane-row'); rows[rows.length-1].querySelector('.lane-status').click(); });
await new Promise(r=>setTimeout(r,250));
console.log('after select last lane:', JSON.stringify(await visOrder()));
console.log('ERR:', errs.join('|')||'(none)');
await page.screenshot({path:'_lane_fixed.png', clip:{x:0,y:Math.max(0,await page.evaluate(()=>document.getElementById('sequence-display').getBoundingClientRect().top)),width:760,height:680}});
await browser.close();
