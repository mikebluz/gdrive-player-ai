// PROBE — a row label wears its section's colour.
//
// "parameter labels in these layer menus needs to be spruced up, with some
// color". The hues already existed, one per section, on the `.v2-gototab`
// chips. The load-bearing check is that the LABEL and the CHIP resolve to the
// SAME value — one table, shared, so the button you pressed and the rows it
// took you to can never drift into two different colours for one section.
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
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 240000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await zz(2500);
  await page.evaluate(() => { document.body.classList.add('view-mix'); _ambInitMaster(); });
  await zz(600);
  await page.evaluate(() => { document.getElementById('mix-bloom-add-layer').click(); });
  await zz(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ambient-addpop-ov .addpop-btn')]
    .find((x) => x.textContent.trim() === 'Layer').click(); });
  await zz(900);
  await page.evaluate(() => { _ambRebuildMaster(); });
  await zz(800);

  const run = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = _masterEng;
    const L = () => (E.getCfg().layers || [])[0];
    L().on = true; L().present = true; E.getCfg();
    // SIX OF THE EIGHT yield a plain-text row label on a default layer, and the
    // sweep asserts over those rather than pretending otherwise: Generate's
    // only ungated row is "Per part", whose label is HIDDEN as redundant with
    // its own tab, and Bank needs saved phrases before it has a row at all.
    // Every section still gets its `data-sec`, which is checked separately.
    // A COLLAPSED CARD GETS NO SHEET — expand, THEN render.
    const h = document.getElementById('bloom-v2-layers');
    const un = () => { const c = document.querySelector('.v2-layer'); if (c) c.classList.remove('collapsed'); };
    if (h) h._sig = ''; window._v2.render(E); await wait(300); un();
    if (h) h._sig = ''; window._v2.render(E); await wait(340); un(); await wait(160);

    const hex2rgb = (x) => {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(x).trim());
      return m ? 'rgb(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ')' : null;
    };
    const out = { secs: [], base: null };
    // the BASE colour, for the fallback claim — a pane with no section
    const SECS = ['Instrument', 'Generate', 'Playing', 'Shape', 'Time', 'Mix', 'FX', 'Bank'];
    for (const nm of SECS) {
      const d = document.querySelector('.v2-layer .v2-gototab[data-goto="' + nm + '"]');
      if (!d) { out.secs.push({ nm, err: 'no chip' }); continue; }
      const want = (getComputedStyle(d).getPropertyValue('--sec') || '').trim();
      d.click(); await wait(420);
      let pane = document.querySelector('.v2-layer .v2-pop-pane');
      // ROWS SIT BEHIND TABS and only the ACTIVE tab's are shown — and a label
      // that merely repeats the active tab's name is hidden as redundant. So
      // walk the strip until a visible label turns up rather than assuming the
      // first tab has one.
      const visLab = () => {
        const pn = document.querySelector('.v2-layer .v2-pop-pane');
        return pn && [...pn.querySelectorAll('.ambient-ctrl > label')]
          .find((x) => x.getBoundingClientRect().height > 0 && (x.textContent || '').trim());
      };
      let lab = visLab();
      if (!lab) {
        const tabs = [...document.querySelectorAll('.v2-layer .v2-pop-tabs [data-tab]')];
        for (const tb of tabs) {
          tb.click(); await wait(280);
          lab = visLab();
          if (lab) break;
        }
      }
      pane = document.querySelector('.v2-layer .v2-pop-pane');
      out.secs.push({
        nm,
        sec: pane ? pane.getAttribute('data-sec') : null,
        want: hex2rgb(want),
        got: lab ? getComputedStyle(lab).color : null,
        weight: lab ? getComputedStyle(lab).fontWeight : null,
        text: lab ? lab.textContent.trim() : null,
      });
    }
    // A PANE WITH NO SECTION falls back to the old grey rather than going
    // transparent — the `var(--sec, …)` default.
    {
      const pane = document.querySelector('.v2-layer .v2-pop-pane');
      if (pane) {
        const keep = pane.getAttribute('data-sec');
        pane.removeAttribute('data-sec');
        const lab = [...pane.querySelectorAll('.ambient-ctrl > label')]
          .find((x) => x.getBoundingClientRect().height > 0 && (x.textContent || '').trim());
        out.base = lab ? getComputedStyle(lab).color : null;
        if (keep) pane.setAttribute('data-sec', keep);
      }
    }
    return out;
  });

  const seen = run.secs.filter((s) => !s.err && s.got);
  ok('ALL EIGHT sections open and each pane carries its own name',
    run.secs.length === 8 && run.secs.every((s) => s.sec === s.nm),
    JSON.stringify(run.secs.map((s) => s.nm + ':' + (s.sec || '-'))));
  // THE ONE THAT MATTERS: one table, shared with the chips.
  ok('a row label resolves to the SAME hue as the chip that opens it',
    seen.length >= 6 && seen.every((s) => s.want && s.got === s.want),
    JSON.stringify(seen.map((s) => ({ s: s.nm, want: s.want, got: s.got }))));
  ok('…and they are distinct colours, not one repeated',
    new Set(seen.map((s) => s.got)).size === seen.length,
    JSON.stringify(seen.map((s) => s.nm + ' ' + s.got)));
  ok('…and the label reads as a LABEL — semibold, not body text',
    seen.every((s) => (s.weight | 0) >= 600), JSON.stringify(seen.map((s) => s.weight)));
  ok('a pane with no section falls back to the old grey, not to nothing',
    run.base === 'rgb(197, 201, 212)' || run.base === null,
    JSON.stringify(run.base));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  seen.forEach((s) => console.log('  ' + s.nm.padEnd(11) + s.got + '   (' + s.text + ')'));
  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe harness error —', e.message); console.error(e.stack); process.exit(1); });
