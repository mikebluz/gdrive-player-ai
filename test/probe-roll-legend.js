// PROBE — the drawing's hollow outlines have a name on the card.
//
// The roll draws every note the NEXT PASSES play behind the take you are
// looking at, hollow. Nothing on the card said so, and it was asked outright:
// "what are all these shadow notes". `.v2-vizlab` now ends with
// `· outlines: the next 7 takes, a colour each`, and each outline is stroked in
// the hue of the soonest take that plays it.
//
// The invariant is the BICONDITIONAL, not the presence: the clause is there
// exactly when outlines are drawn (`.v2-vizcv._ghostN`), and never while the
// drawing is hidden — Hide keeps the readout and takes the picture away, and a
// legend for a picture that is not on screen is noise. Saying it on a FIXED
// part (which has no outlines by construction) would be the lie; staying
// silent on a part with 24 of them is the bug that prompted this.
//
// The COLOURS carry the second half: alpha says how many passes play a note,
// hue says which one plays it first. The load-bearing check is the same one
// test/probe-label-hue.js makes — the drawing and the stylesheet resolve to the
// SAME value, one table, so they can never drift into two palettes.
//
// Needs a server on :3001 (or PROBE_PORT).
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.PROBE_PORT || '3001';
const URL = process.env.BLOOPS_URL || `http://localhost:${PORT}/bloops.html`;
const LEGEND = 'outlines: the next 7 takes, a colour each';
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

  const open = () => page.evaluate(() => { document.querySelector('.v2-layer')?.classList.remove('collapsed'); });

  // ---- a v2 layer, through the real door (as test/ui-lifecycle.js does) ----
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer')?.click(); });
  await zz(600);
  const picked = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')];
    const t = bs.find((x) => x.textContent.trim() === 'Layer');
    if (!t) return 'no "Layer": ' + bs.map((x) => x.textContent.trim()).join(' | ');
    t.click(); return null;
  });
  await zz(700);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(700);
  await open();
  const haveCard = await page.evaluate(() => !!document.querySelector('.v2-layer'));
  ok('a v2 layer card exists to drive', haveCard, picked || '');
  if (!haveCard) { console.log('\nprobe: ' + pass + ' passed, ' + (fail + 1) + ' failed'); await browser.close(); process.exit(1); }

  // ---- MATERIAL, then VARY — both through the card's own doors ------------
  // A NEW LAYER STARTS EMPTY (an empty `recorded` part), and a recorded part
  // is excluded from the pass sampling, so there is nothing to draw outlines
  // for until a Material door has made it live.
  const mat = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.v2-layer .v2-autopick')];
    const mel = bs.find((x) => /Melody/.test(x.textContent));
    if (!mel) return 'no Melody door: ' + bs.map((x) => x.textContent.trim().slice(0, 12)).join(' | ');
    mel.click(); return null;
  });
  await zz(1400);
  await page.evaluate(() => {
    const d = [...document.querySelectorAll('.v2-layer .v2-autox')].find((x) => /Done/.test(x.textContent) && x.offsetParent);
    if (d) d.click();
  });
  await zz(1000); await open();
  ok('a Material door made the part live', !mat &&
     (await page.evaluate(() => (_masterEng.getCfg().layers || [])[0]?.part?.kind)) === 'live', mat || '');

  await page.evaluate(() => {
    const t = document.querySelector('.v2-layer .v2-varytoggle');
    if (t && !t.classList.contains('on')) t.click();   // 🎲 Roll again
  });
  await zz(1100); await open();

  // What the picture actually drew, beside what the readout actually says.
  const read = () => page.evaluate((LEGEND) => {
    const card = document.querySelector('.v2-layer');
    const cv = card?.querySelector('.v2-vizcv');
    const lab = card?.querySelector('.v2-vizlab');
    const L = (_masterEng.getCfg().layers || [])[0];
    return {
      ghostN: cv ? (cv._ghostN | 0) : -1,
      vary: !!L?.part?.vary, kind: L?.part?.kind,
      says: !!(lab && lab.textContent.includes(LEGEND)),
      text: (lab?.textContent || '').trim().slice(0, 200),
      // Rule 2: text wraps and stays inside its box — measured on the leaf,
      // never on documentElement (html/body carry overflow-x:hidden, so an
      // overflowing readout is silently CLIPPED and reads as zero overflow).
      overflows: lab ? (lab.scrollWidth > lab.clientWidth + 1) : true,
      rightOut: lab ? (lab.getBoundingClientRect().right >
                       lab.parentElement.getBoundingClientRect().right + 1) : true,
      // WHICH takes the outlines belong to, and the hue each was given.
      takes: cv ? (cv._ghostTakes || []) : [],
      // The stylesheet's own answer, for the one-table check.
      css: (() => { const rs = getComputedStyle(document.documentElement);
        return [1, 2, 3, 4, 5, 6, 7].map((i) => (rs.getPropertyValue('--take-' + i) || '').trim()); })(),
      // WHAT ACTUALLY REACHED THE PIXELS. A hue assigned but never stroked is
      // the confident-wrong-answer shape, so count distinct hue families in the
      // bitmap rather than trusting the published mapping alone.
      hueBins: (() => {
        if (!cv) return 0;
        let px; try { px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; }
        catch (e) { return -1; }
        const bins = {};
        for (let i = 0; i < px.length; i += 4) {
          const a = px[i + 3]; if (a < 40) continue;
          const r = px[i] / 255, g2 = px[i + 1] / 255, b = px[i + 2] / 255;
          const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b), d = mx - mn;
          const l = (mx + mn) / 2;
          if (d < 0.10 || l < 0.12 || l > 0.95) continue;     // greys and the ground
          let h = 0;
          if (mx === r) h = 60 * (((g2 - b) / d) % 6);
          else if (mx === g2) h = 60 * ((b - r) / d + 2);
          else h = 60 * ((r - g2) / d + 4);
          if (h < 0) h += 360;
          const k = Math.round(h / 20);                        // 20° families
          bins[k] = (bins[k] || 0) + 1;
        }
        return Object.values(bins).filter((n) => n >= 25).length;
      })(),
    };
  }, LEGEND);

  // ---- 1. VARYING: outlines drawn, and the readout names them -------------
  let v = await read();
  // A take can happen to agree with its neighbours; re-roll until the picture
  // actually has outlines to explain (bounded — never an endless loop).
  for (let i = 0; i < 6 && v.ghostN <= 0; i++) {
    await page.evaluate(() => { document.querySelector('.v2-layer .v2-barroll')?.click(); });
    await zz(900); await open();
    v = await read();
  }
  console.log('\nvarying part');
  ok('the part varies', v.vary === true && v.kind === 'live', JSON.stringify(v));
  ok('the drawing put outlines behind the take', v.ghostN > 0, JSON.stringify(v));
  ok('the readout names them', v.says === true, v.text);
  ok('and names them LAST, after the take', /take \d[\s\S]*outlines:/.test(v.text), v.text);
  ok('readout does not overflow its box', !v.overflows && !v.rightOut,
     JSON.stringify({ o: v.overflows, r: v.rightOut, t: v.text }));

  console.log('\ncolour coding');
  const ks = [...new Set(v.takes.map((t) => t.k))].sort((a, b) => a - b);
  const hues = [...new Set(v.takes.map((t) => t.hue))];
  ok('the outlines span more than one take', ks.length >= 2, 'takes ' + JSON.stringify(ks));
  ok('…so more than one hue is in play', hues.length >= 2, JSON.stringify(hues));
  ok('no outline wears take 0 (that is the drawn take)', ks.every((k) => k > 0), JSON.stringify(ks));
  // ONE TABLE, SHARED — the drawing's hue for take k and the stylesheet's
  // --take-k must be the same value, or the picture and the palette have
  // drifted into two vocabularies for one axis.
  ok('every hue is the stylesheet\'s own --take-N',
     v.css.filter(Boolean).length === 7 &&
     v.takes.every((t) => t.hue.toLowerCase() === v.css[(t.k - 1) % 7].toLowerCase()),
     JSON.stringify({ css: v.css, sample: v.takes.slice(0, 4) }));
  // …and it reached the bitmap: the drawn take's own hue plus at least two
  // take hues. One family would mean the picture is still monochrome.
  ok('the canvas really is multi-hued now', v.hueBins >= 3, 'hue families = ' + v.hueBins);

  // ---- 2. HIDDEN drawing: the readout stays, the legend must not ----------
  console.log('\ndrawing hidden (Hide keeps the readout)');
  await page.evaluate(() => { document.querySelector('.v2-layer .v2-viztog')?.click(); });
  await zz(800); await open();
  const h = await read();
  ok('the readout is still there', h.text.length > 10, h.text);
  ok('no legend for a picture that is not on screen', h.says === false, h.text);
  await page.evaluate(() => { document.querySelector('.v2-layer .v2-viztog')?.click(); });
  await zz(900); await open();
  const back = await read();
  ok('showing it again brings the legend back', back.says === true, back.text);

  // ---- 3. FIXED: no outlines by construction, so no clause ----------------
  console.log('\nfixed part (one take, sampled eight times)');
  await page.evaluate(() => {
    const t = document.querySelector('.v2-layer .v2-varytoggle');
    if (t && t.classList.contains('on')) t.click();     // ✓ Play this take
  });
  await zz(1100); await open();
  const f = await read();
  ok('the part no longer varies', f.vary === false, JSON.stringify(f));
  ok('no outlines are drawn', f.ghostN === 0, JSON.stringify(f));
  ok('and the readout stays silent about them', f.says === false, f.text);

  // ---- 4. EVOLVE: the other clock that has coming takes -------------------
  // `vary` advances the take every cycle; Evolve advances it every `ev`
  // passes. Both end up asking for `base + 1, +2, …`, so the outlines are the
  // next takes either way — the preview used to ask only under `vary`, which
  // took it away from the mode most about future takes.
  console.log('\nevolving part (vary off, Evolve on)');
  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    L.part.vary = 0;                       // Evolve and Each cycle are exclusive
    L.chg = { ev: 2, am: 100 };
    _masterEng.getCfg(); window._v2.render(_masterEng);
  });
  await zz(1100); await open();
  const ev = await read();
  ok('the part is live and not varying', ev.kind === 'live' && ev.vary === false, JSON.stringify(ev));
  ok('outlines are drawn for the coming takes', ev.ghostN > 0, JSON.stringify(ev));
  ok('…still one hue per take', [...new Set(ev.takes.map((t) => t.hue))].length >= 2,
     JSON.stringify([...new Set(ev.takes.map((t) => t.hue))]));
  ok('the readout names them', ev.says === true, ev.text);
  ok('…and says how often they arrive', /one every 2 passes/.test(ev.text), ev.text);

  // ---- the invariant, stated once ----------------------------------------
  const shown = [v, back, f, ev];                 // every state with the picture up
  ok('said exactly when outlines are drawn', shown.every((s) => s.says === (s.ghostN > 0)),
     JSON.stringify(shown.map((s) => ({ g: s.ghostN, says: s.says }))));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
