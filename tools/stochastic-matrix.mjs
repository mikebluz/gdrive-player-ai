#!/usr/bin/env node
// Bloom's stochastic controls, as a layer × parameter matrix.
//
//   npm run stoch            → rewrite docs/bloom-stochastic-controls.md
//   npm run stoch -- --html  → also write /tmp/…/stochastic-matrix.html
//
// MEMBERSHIP is read from the LIVE `_AMB_LAYER_SCHEMA` (needs `npm start`), so
// the doc cannot drift from the schema. TYPE and GRAIN are the one hand-authored
// part: they come from reading each control's DRAW SITE in the emitters, which
// no amount of schema introspection can tell you. When you add a control, add it
// to META below — the script fails loudly on anything it does not know.
//
//   TYPE  = what the control edits.
//   GRAIN = what counts as ONE set of choices. This is the axis that matters for
//           any "how often does this layer play something new" model: only the
//           `cycle` controls are what Write / Evolve actually captures.
import fs from 'fs';
import path from 'path';

const META = {
  // ── one NOTE: a fresh choice for every note played ──────────────────────
  velVar:    { t: 'Dynamics',     u: 'note',  n: 'volume jitter, seeded on position in the performance' },
  humanize:  { t: 'Rhythm',       u: 'note',  n: 'onset jitter — the ONLY unseeded draw (Math.random)' },
  lenVary:   { t: 'Length',       u: 'note',  n: '_ambVaryLen around the layer Length' },
  accent:    { t: 'Dynamics',     u: 'note',  n: 'one draw picks accented / ghost / plain' },
  ornament:  { t: 'Articulation', u: 'note',  n: 'grace / mordent / turn; draws from the caller stream' },
  slide:     { t: 'Articulation', u: 'note',  n: 'approach a leap by step' },
  contour:   { t: 'Pitch',        u: 'note',  n: 'walk-direction bias; draws at every setting' },
  gravity:   { t: 'Pitch',        u: 'note',  n: 'pull toward chord tones' },
  stutter:   { t: 'Pitch',        u: 'note',  n: 'repeat instead of walking' },
  motion:    { t: 'Pitch',        u: 'note',  n: 'seeded detune offset per voice' },
  randomness:{ t: 'Pitch',        u: 'note',  n: 'scramble the arp index' },
  twist:     { t: 'Rhythm',       u: 'note',  n: 'burst of extra walk-steps on one fire' },
  // ── one SLOT: a choice per candidate onset, played or not ───────────────
  restProb:  { t: 'Rhythm',       u: 'slot',  n: 'rest gate per candidate onset' },
  ghosts:    { t: 'Rhythm',       u: 'slot',  n: 'quiet pickup hit half a slot early' },
  syncop:    { t: 'Rhythm',       u: 'slot',  n: 'offbeat bias in the stochastic fill' },
  pitchVar:  { t: 'Pitch',        u: 'slot',  n: 'Walk — advances per euclidean HIT' },
  // ── one CYCLE: one choice for the whole phrase / pass ───────────────────
  rhythmVar: { t: 'Rhythm',       u: 'cycle', n: 're-rolls the euclid pattern per cycle' },
  rateVar:   { t: 'Rhythm',       u: 'cycle', n: 'note rate per series pass' },
  timeVary:  { t: 'Rhythm',       u: 'cycle', n: 'drone onset, from the per-phrase cRnd' },
  phraseVary:{ t: 'Rhythm',       u: 'cycle', n: 'Start — where the phrase begins (Motif)' },
  startVary: { t: 'Rhythm',       u: 'cycle', n: 'Start — where the phrase begins (Bed)' },
  pitchVary: { t: 'Pitch',        u: 'cycle', n: 'drone: one slot per phrase, so per cycle' },
  vary:      { t: 'Pitch',        u: 'cycle', n: 'Riff/Pedal, from the per-phrase cRnd' },
};
const GRAINS = [
  ['note',  'one NOTE',  'a fresh choice for every note played'],
  ['slot',  'one SLOT',  'a choice per candidate onset, played or not'],
  ['cycle', 'one CYCLE', 'one choice for the whole phrase / pass'],
];
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const URLBASE = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';

const puppeteer = (await import(path.join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'))).default;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
try {
  await page.goto(URLBASE, { waitUntil: 'networkidle2', timeout: 45000 });
} catch (e) {
  console.error('Could not reach ' + URLBASE + ' — is `npm start` running?');
  await browser.close(); process.exit(2);
}
await new Promise(r => setTimeout(r, 2500));
const data = await page.evaluate(() => {
  const S = _AMB_LAYER_SCHEMA, types = Object.keys(S), cells = {}, labels = {};
  types.forEach(t => { let g = '';
    (S[t].ctrls || []).forEach(c => {
      if (!Array.isArray(c)) return;
      if (c[0] === 'grp') { g = c[1]; return; }
      if (g !== 'Variance' && g !== 'Performance') return;
      const k = c[1]; if (!k) return;
      cells[k] = cells[k] || {}; cells[k][t] = 1;
      labels[k] = labels[k] || new Set(); labels[k].add(c[2] || k);
    }); });
  return { types: types.map(t => ({ key: t, label: S[t].label || t })), cells,
    labels: Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, [...v]])) };
});
await browser.close();

const keys = Object.keys(data.cells);
const unknown = keys.filter(k => !META[k]);
if (unknown.length) {
  console.error('Unknown control(s): ' + unknown.join(', ') +
    '\nAdd each to META in tools/stochastic-matrix.mjs with its TYPE and GRAIN — ' +
    'read them from the control’s draw site in the emitter, not from its label.');
  process.exit(1);
}
const stale = Object.keys(META).filter(k => !data.cells[k]);
const cnt = k => Object.keys(data.cells[k]).length;
const cols = keys.sort((a, b) =>
  GRAINS.findIndex(g => g[0] === META[a].u) - GRAINS.findIndex(g => g[0] === META[b].u)
  || cnt(b) - cnt(a) || a.localeCompare(b));
const lab = k => data.labels[k].join(' / ');
const rowTotal = t => cols.filter(k => data.cells[k][t.key]).length;
const byType = {}; cols.forEach(k => { (byType[META[k].t] = byType[META[k].t] || []).push(k); });

let md = `# Bloom — stochastic controls by layer

> Generated by \`npm run stoch\` from the live \`_AMB_LAYER_SCHEMA\`. Do not hand-edit:
> re-run it after adding, moving or removing a Variance / Performance control.
> Visual version: https://claude.ai/code/artifact/5283fea5-96be-46ca-a878-44c845451f28

Every control in each layer's **Variance** and **Performance** groups — ${cols.length} controls
across ${data.types.length} layer types. Two axes:

- **Type** — what the control edits.
- **Grain** — what counts as ONE set of choices. This is the axis that matters:
  only the \`cycle\` controls are what Write / Evolve actually captures, so a
  "play something new every N passes" setting governs those and nothing else.

Membership is read from the schema. Type and grain are hand-authored in
\`tools/stochastic-matrix.mjs\` from each control's **draw site** in the emitters —
a label cannot tell you either.

## By grain

`;
GRAINS.forEach(([u, title, desc]) => {
  const ks = cols.filter(k => META[k].u === u);
  md += `### ${title} — ${desc}\n\n`;
  md += `| control | key | type | layers | what it draws |\n|---|---|---|---|---|\n`;
  ks.forEach(k => { md += `| ${lab(k)} | \`${k}\` | ${META[k].t} | ${cnt(k)} | ${META[k].n} |\n`; });
  md += `\n`;
});
md += `## By type

| type | controls | count |
|---|---|---|
`;
Object.keys(byType).sort((a, b) => byType[b].length - byType[a].length).forEach(t => {
  md += `| ${t} | ${byType[t].map(k => lab(k)).join(' · ')} | ${byType[t].length} |\n`;
});
md += `\n## By layer\n\n| layer | controls | count |\n|---|---|---|\n`;
data.types.forEach(t => {
  md += `| ${t.label} | ${cols.filter(k => data.cells[k][t.key]).map(k => lab(k)).join(' · ') || '—'} | ${rowTotal(t)} |\n`;
});
const nNote = cols.filter(k => META[k].u === 'note').length;
const nCycle = cols.filter(k => META[k].u === 'cycle').length;
md += `
## What the shape says

- **${nNote} of ${cols.length}** controls re-decide on every note, so no amount of freezing
  makes them repeat. Only the **${nCycle} cycle** controls are what Write / Evolve captures.
- **Rhythm and Pitch are ${(byType.Rhythm || []).length + (byType.Pitch || []).length} of ${cols.length}.** Loudness, articulation and length are
  ${cols.length - (byType.Rhythm || []).length - (byType.Pitch || []).length} controls between them.
- \`humanize\` is the only control on unseeded \`Math.random\` — which is exactly why
  the same take replays identically except for its humanize.
- **${cols.filter(k => cnt(k) === 1).length}** controls belong to a single layer. That tail is per-layer character,
  not duplication, and collapsing it would flatten what makes a Motif a Motif.

## Resolved

- \`phrasing\` (Motif "Phrasing" / Riff "Articulate") drew **zero** RNG at any setting —
  a deterministic blend of the seed pattern's shape. Moved out of Variance into
  Timing, so every control listed here genuinely draws.
- \`startVary\` (Bed) and \`phraseVary\` (Motif) were the same algorithm written twice.
  Still two fields, now one implementation: \`_ambStartOffset\`.

## Open

- \`pitchVar\` (Bass "Walk", per **slot**) and \`pitchVary\` (Arp/Drone, per **cycle**)
  differ by one letter *and* by grain — a live trap when reading this code.
- Rests and Ghosts are one bipolar density axis pointing opposite ways. Merging is
  a real behaviour change: it hands ghosts to five layers that never had them.
- Six of Motif's controls (Contour, Gravity, Stutter, Twist, Ornament, Slide) are
  one idea — how the walk behaves — presented as six sliders.
`;
if (stale.length) md += `\n> **Note:** \`${stale.join('`, `')}\` ${stale.length === 1 ? 'is' : 'are'} in META but no longer in the schema.\n`;

const out = path.join(ROOT, 'docs/bloom-stochastic-controls.md');
fs.writeFileSync(out, md);
console.log('wrote ' + path.relative(ROOT, out) + ' — ' + cols.length + ' controls, ' +
  data.types.length + ' layers, ' + Object.keys(byType).length + ' types' +
  (stale.length ? ' (stale META: ' + stale.join(',') + ')' : ''));
