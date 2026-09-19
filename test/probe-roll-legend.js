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

  // ---- 4b. EVOLVE IS ITS OWN STATE (2026-09-19) ---------------------------
  // The readout and the badge say EVOLVES (not VARIES) and the badge wears
  // `--evo`; the drawing carries its own chip, published as `cv._evoChip`
  // (the picture's own claim, not a re-derivation); the three knobs that set
  // it are marked `.v2-evorow`, REACHABLE (rect + offsetParent, through the
  // ⚙ Deep door and the 🎲 Take tab — the way a person gets there), and their
  // labels resolve to the same hue. One colour for one state, read from the
  // stylesheet rather than restated here.
  console.log('\nEvolve is its own state');
  const es = await page.evaluate(() => new Promise((res) => {
    const card = document.querySelector('.v2-layer');
    const cv = card?.querySelector('.v2-vizcv');
    const lab = card?.querySelector('.v2-vizlab');
    const badge = lab?.querySelector('.v2-livebadge');
    const evoCss = (getComputedStyle(document.documentElement).getPropertyValue('--evo') || '').trim();
    const rgb = (hx) => { const n = parseInt(hx.replace('#', ''), 16);
      return 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')'; };
    card?.querySelector('.v2-genbtn')?.click();
    setTimeout(() => {
      card?.querySelector('.v2-fttab[data-ft="take"]')?.click();
      setTimeout(() => {
        const rows = ['chg.ev', 'chg.am', 'chg.clock'].map((f) => {
          const inp = card?.querySelector('.v2-genwrap [data-f="' + f + '"]');
          const row = inp?.closest('.ambient-ctrl');
          const r = row?.getBoundingClientRect();
          return { f, marked: !!row?.classList.contains('v2-evorow'),
            shown: !!(row && row.offsetParent && r.width > 0 && r.height > 0),
            labelColor: row ? getComputedStyle(row.querySelector('label')).color : '' };
        });
        const scv = card?.querySelector('.v2-genwrap .v2-stagecv');
        res({ text: (lab?.textContent || '').trim().slice(0, 80),
          badge: badge?.textContent, badgeCls: badge?.className || '',
          badgeColor: badge ? getComputedStyle(badge).color : '',
          evoCss, evoRgb: evoCss ? rgb(evoCss) : '',
          chip: cv?._evoChip || null, stageChip: scv?._evoChip || null, rows,
          summary: (card?.querySelector('.v2-summary')?.textContent || '').trim().slice(0, 40) });
      }, 500);
    }, 400);
  }));
  ok('the readout leads with EVOLVES and its clock', /^EVOLVES every 2 passes:/.test(es.text), es.text);
  ok('the badge is EVOLVES, in Evolve\'s hue',
     es.badge === 'EVOLVES' && /v2-sum-evo/.test(es.badgeCls) && es.badgeColor === es.evoRgb,
     JSON.stringify({ b: es.badge, c: es.badgeCls, col: es.badgeColor, want: es.evoRgb }));
  ok('the summary leads with it too', /^EVOLVES/.test(es.summary), es.summary);
  ok('the drawing carries an Evolve chip in that hue',
     !!es.chip && /EVOLVES every 2 passes/.test(es.chip.text) && es.chip.hue.toLowerCase() === es.evoCss.toLowerCase(),
     JSON.stringify(es.chip));
  ok('…and so does ⚙ Deep\'s staged drawing', !!es.stageChip && /EVOLVES every 2 passes/.test(es.stageChip.text),
     JSON.stringify(es.stageChip));
  ok('the three Evolve knobs are marked, reachable, and wear the hue',
     es.rows.length === 3 && es.rows.every((r) => r.marked && r.shown && r.labelColor === es.evoRgb),
     JSON.stringify(es.rows));
  await page.evaluate(() => { document.querySelector('.v2-layer .v2-gencancel')?.click(); });
  await zz(400); await open();

  // ---- 4c. ONE BUTTON ON THE FACE (2026-09-19) ---------------------------
  // "Evolve feels buried in the Deep menu" → a switch on the take bar; then
  // "can't they just one button then" → ⟳ Evolve is a toggle whose fill and
  // tail carry the state, with Every N beneath it while on (Re-roll = Every
  // 1, Repeat = off). Each press is a real click with the config read back,
  // the button measured (rect + offsetParent) and its colour compared to the
  // stylesheet, and the Every row held to "shown exactly while on".
  console.log('\nthe one button on the card face');
  const readSw = () => page.evaluate(() => {
    const card = document.querySelector('.v2-layer');
    const L = (_masterEng.getCfg().layers || [])[0];
    const b = card?.querySelector('.v2-evotog');
    const r = b?.getBoundingClientRect();
    const evr = card?.querySelector('.v2-evoevery');
    const er = evr?.getBoundingClientRect();
    return { lit: !!b?.classList.contains('on'), face: b?.textContent || '', disabled: !!b?.disabled,
      frozenCls: !!b?.classList.contains('v2-clockfrozen'),
      shown: !!(b && b.offsetParent && r.width > 0 && r.height > 0),
      color: b ? getComputedStyle(b).color : '', vary: !!L?.part?.vary, ev: ((L?.chg || {}).ev | 0),
      kind: L?.part?.kind,
      badge: card?.querySelector('.v2-vizlab .v2-livebadge')?.textContent,
      everyShown: !!(evr && evr.offsetParent && getComputedStyle(evr).display !== 'none' && er.height > 0),
      everyVal: evr ? +(evr.querySelector('.v2-f[data-f="chg.ev"]')?.value) : null,
      deepEv: +(card?.querySelector('.v2-genwrap .v2-f[data-f="chg.ev"]')?.value),
      chip: !!card?.querySelector('.v2-vizcv')?._evoChip };
  });
  const press = async () => {
    await page.evaluate(() => { document.querySelector('.v2-layer .v2-evotog')?.click(); });
    await zz(900); await open();
    return readSw();
  };
  // section 4 left it evolving every 2 (set directly) — the first press turns it OFF
  const s1 = await press();
  ok('press: off — unlit, says so, Evolve 0, vary off, no chip, no Every row', !s1.lit && /off/.test(s1.face) &&
     s1.shown && s1.ev === 0 && !s1.vary && s1.badge !== 'EVOLVES' && !s1.chip && !s1.everyShown, JSON.stringify(s1));
  const s2 = await press();
  ok('press: on — lit in the hue, every 4 (the default), badge EVOLVES, chip drawn, Every row reachable and mirrored into ⚙ Deep',
     s2.lit && /every 4 passes/.test(s2.face) && s2.shown && s2.color === es.evoRgb && !s2.vary && s2.ev === 4 &&
     s2.badge === 'EVOLVES' && s2.chip && s2.everyShown && s2.everyVal === 4 && s2.deepEv === 4, JSON.stringify(s2));
  // ⚙ Deep's legacy Each cycle (`part.vary`) reads on the face as Every 1 —
  // and the badge and the chip agree, or amber VARIES would sit over a lime
  // button saying the opposite
  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    L.part.vary = 1; _masterEng.getCfg(); window._v2.render(_masterEng);
  });
  await zz(900); await open();
  const s3 = await readSw();
  ok('Re-roll (Each cycle in ⚙ Deep) reads as ⟳ Evolve: every cycle, Every 1, badge EVOLVES, chip drawn',
     s3.lit && /every cycle/.test(s3.face) && s3.everyVal === 1 && s3.everyShown && s3.badge === 'EVOLVES' && s3.chip,
     JSON.stringify(s3));
  // …and on a FROZEN take the press RELEASES it and evolves — never a
  // disabled button ("why can't i click it": a disabled button cannot take
  // the press to explain itself, and its title never shows on a phone)
  await page.evaluate(() => {
    const L = (_masterEng.getCfg().layers || [])[0];
    window._v2.capture(_masterEng, L); _masterEng.getCfg(); window._v2.render(_masterEng);
  });
  await zz(900); await open();
  const fr = await readSw();
  ok('a frozen take dims the button but never disables it', fr.kind === 'recorded' && fr.frozenCls && !fr.disabled && !fr.lit,
     JSON.stringify(fr));
  const s4 = await press();
  ok('the press on a frozen take releases it and evolves', s4.kind === 'live' && s4.lit && !s4.vary && s4.ev > 0 &&
     s4.badge === 'EVOLVES', JSON.stringify(s4));

  // ---- the invariant, stated once ----------------------------------------
  const shown = [v, back, f, ev];                 // every state with the picture up
  ok('said exactly when outlines are drawn', shown.every((s) => s.says === (s.ghostN > 0)),
     JSON.stringify(shown.map((s) => ({ g: s.ghostN, says: s.says }))));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
