#!/usr/bin/env node
// Bloom's stochastic controls, as a layer × parameter matrix.
//
//   npm run stoch      → rewrite docs/bloom-stochastic-controls.md
//
// EVERYTHING comes from the running app: MEMBERSHIP from `_AMB_LAYER_SCHEMA`, and
// TYPE / GRAIN / wording from `_AMB_STOCH` (js/bloops/17-ambient.js), which is the
// same table the card readouts render from. So the doc cannot drift from the UI.
//
// WHAT THIS CAN AND CANNOT CHECK. It catches a control in a Variance/Performance
// group with no description. It CANNOT catch a stochastic control living in some
// other group — nothing can, short of reading the emitter — which is exactly how
// Stereo, Salt, Spatialize, Fidelity, Fill, Proximity, Poly and Variety went
// unmarked until 2026-08-20. The group is not the predicate; the draw site is.
//
// Needs the dev server (`npm start`).
import fs from 'fs';
import path from 'path';

const TYPE_NAME = { rhy: 'Rhythm', pit: 'Pitch', dyn: 'Dynamics', art: 'Articulation', len: 'Length', pan: 'Space' };
const GRAINS = [
  ['note',  'one NOTE',  'a fresh choice for every note played'],
  ['slot',  'one SLOT',  'a choice per candidate onset, played or not'],
  ['chord', 'one CHORD', 'one choice per chord, re-dealt each time it comes round'],
  ['cycle', 'one CYCLE', 'one choice for the whole phrase / pass'],
];
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const URLBASE = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';

const puppeteer = (await import(path.join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'))).default;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
let data = null;
try {
  await page.goto(URLBASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));
  data = await page.evaluate(() => {
    const S = _AMB_LAYER_SCHEMA, types = Object.keys(S);
    const cells = {}, labels = {}, groups = {}, tokens = {}, variance = {};
    types.forEach(t => { let g = '', sub = '';
      (S[t].ctrls || []).forEach(c => {
        if (!Array.isArray(c)) return;
        if (c[0] === 'grp') { g = c[1]; sub = ''; return; }
        if (c[0] === 'sub') { sub = c[1]; return; }
        // A BARE TOKEN (['spread'], ['salt'], ['spat']) is how the custom-built
        // controls declare which layers carry them — they are not sl/tm rows.
        if (c.length === 1) { (tokens[c[0]] = tokens[c[0]] || {})[t] = 1; return; }
        if (c[0] !== 'sl' && c[0] !== 'tm') return;
        const k = c[1]; if (!k) return;
        cells[k] = cells[k] || {}; cells[k][t] = 1;
        labels[k] = labels[k] || new Set(); labels[k].add(c[2] || k);
        groups[k] = groups[k] || new Set(); groups[k].add(g + (sub ? '/' + sub : ''));
        if (g === 'Variance' || g === 'Performance') variance[k] = 1;
      }); });
    const meta = {};   // _AMB_STOCH holds functions (`at`); ship only what serialises
    Object.keys(_AMB_STOCH).forEach(k => { const m = _AMB_STOCH[k];
      meta[k] = { type: m.type, grain: m.grain, draws: m.draws || '', does: m.does || '',
                  off: m.off || '', token: m.token || '' }; });
    return { types: types.map(t => ({ key: t, label: S[t].label || t })), cells, meta, tokens,
      variance: Object.keys(variance),
      groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v]])),
      labels: Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, [...v]])) };
  });
} catch (e) {
  console.error('Could not read the schema from ' + URLBASE + ' — is `npm start` running?\n' + e);
  await browser.close(); process.exit(2);
}
await browser.close();

const META = data.meta;
// A control's LAYERS: a token-rendered control names its token; everything else
// is an sl/tm row and is found by key.
const owners = k => META[k].token ? (data.tokens[META[k].token] || {}) : (data.cells[k] || {});
const keys = Object.keys(META);
const orphan = keys.filter(k => !Object.keys(owners(k)).length);
if (orphan.length) {
  console.error('In _AMB_STOCH but present in no layer schema: ' + orphan.join(', ') +
    '\nEither the control was removed, or it is rendered by a token that must be named in its `token` field.');
  process.exit(1);
}
const undescribed = data.variance.filter(k => !META[k]);
if (undescribed.length) {
  console.error('Control(s) in a Variance/Performance group but missing from _AMB_STOCH: ' + undescribed.join(', ') +
    '\nAdd each to _AMB_STOCH in js/bloops/17-ambient.js with its type, grain, does and off — ' +
    'read type and grain from the control’s draw site in the emitter, not from its label.\n' +
    'Until you do, the card shows no description for it and this doc cannot list it.');
  process.exit(1);
}
const cnt = k => Object.keys(owners(k)).length;
const tname = k => TYPE_NAME[META[k].type] || META[k].type;
const grp = k => (data.groups[k] || ['token: ' + META[k].token]).join(', ');
const lab = k => (data.labels[k] || [k]).join(' / ');
const cols = keys.sort((a, b) =>
  GRAINS.findIndex(g => g[0] === META[a].grain) - GRAINS.findIndex(g => g[0] === META[b].grain)
  || cnt(b) - cnt(a) || a.localeCompare(b));
const rowTotal = t => cols.filter(k => owners(k)[t.key]).length;
const byType = {}; cols.forEach(k => { (byType[tname(k)] = byType[tname(k)] || []).push(k); });
const outside = cols.filter(k => !data.variance.includes(k));

let md = `# Bloom — stochastic controls by layer

> Generated by \`npm run stoch\`. Every column comes from the running app —
> membership from \`_AMB_LAYER_SCHEMA\`, type/grain/wording from \`_AMB_STOCH\`
> (\`js/bloops/17-ambient.js\`), which is also what the card readouts render from.
> Do not hand-edit; edit \`_AMB_STOCH\` and re-run.
> Visual version: https://claude.ai/code/artifact/5283fea5-96be-46ca-a878-44c845451f28

Every control that makes a stochastic decision — ${cols.length} of them across
${data.types.length} layer types. Two axes:

- **Type** — what the control edits.
- **Grain** — what counts as ONE set of choices. This is the axis that matters:
  only the \`cycle\` controls are what Write / Evolve actually captures, so a
  "play something new every N passes" setting governs those and nothing else.

Neither is derivable from a label — both come from each control's **draw site**
in the emitters. That is why they are recorded in the app rather than here.

**The group is not the predicate.** ${outside.length} of these ${cols.length} live outside the Variance and
Performance groups (${outside.map(k => lab(k)).join(' · ')}),
and every one of them went unmarked until 2026-08-20 because the first sweep used
the group to decide what counted. Three are custom tokens rather than \`sl\` rows,
so they were not in that sweep at all. This generator can catch a Variance control
with no description; it can never catch a stochastic control somewhere else.

## By grain

`;
GRAINS.forEach(([u, title, desc]) => {
  const ks = cols.filter(k => META[k].grain === u);
  if (!ks.length) return;
  md += `### ${title} — ${desc}\n\n`;
  md += `| control | key | type | group | layers | what a user sees | what it draws |\n|---|---|---|---|---|---|---|\n`;
  ks.forEach(k => { md += `| ${lab(k)} | \`${k}\` | ${tname(k)} | ${grp(k)} | ${cnt(k)} | ${META[k].does} | ${META[k].draws} |\n`; });
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
  md += `| ${t.label} | ${cols.filter(k => owners(k)[t.key]).map(k => lab(k)).join(' · ') || '—'} | ${rowTotal(t)} |\n`;
});
const nNote = cols.filter(k => META[k].grain === 'note').length;
const nCycle = cols.filter(k => META[k].grain === 'cycle').length;
const nRhyPit = (byType.Rhythm || []).length + (byType.Pitch || []).length;
md += `
## What the shape says

- **${nNote} of ${cols.length}** controls re-decide on every note, so no amount of freezing
  makes them repeat. Only the **${nCycle} cycle** controls are what Write / Evolve captures.
- **Rhythm and Pitch are ${nRhyPit} of ${cols.length}.** Loudness, articulation, length and space are
  ${cols.length - nRhyPit} controls between them.
- \`humanize\` is the only control on unseeded \`Math.random\` — which is exactly why
  the same take replays identically except for its humanize.
- **${cols.filter(k => cnt(k) === 1).length}** controls belong to a single layer. That tail is per-layer character,
  not duplication, and collapsing it would flatten what makes a Motif a Motif.
- Some controls roll only in certain **modes**: Stereo draws nothing in Pan mode,
  Spatialize only in Mode = Random, Variety only while Feel is Stochastic. The
  marker still applies — it describes what the control does when it is active —
  and the description carries the condition.

## Resolved

- \`phrasing\` (Motif "Phrasing" / Riff "Articulate") drew **zero** RNG at any setting —
  a deterministic blend of the seed pattern's shape. Moved out of Variance into
  Timing, so every control listed here genuinely draws.
- \`startVary\` (Bed) and \`phraseVary\` (Motif) were the same algorithm written twice.
  Still two fields, now one implementation: \`_ambStartOffset\`.
- Type and grain used to live in this generator, where the UI could not reach them.
  They now live in \`_AMB_STOCH\` and feed both the doc and the card readouts.

## Open

- **\`mutateRate\` (Texture "Mutate", \`slow→fast\`) is DEAD** and is deliberately not
  listed above. Nine occurrences in the tree — defaults, two presets, the unit
  table, the ramp list, one \`bind\`, one \`set\` — and no emitter reads it.
  \`_ambTexBuildPattern\` has one caller, guarded \`if (!_E.texPattern)\`, and
  \`_E.texMutateAt\` is assigned 0 in three places and never read. Either implement
  it (it would be the only "how often does this re-decide" control in the app) or
  remove it; leaving a slider that does nothing is the worst case for a panel
  whose whole problem is that people cannot tell what the controls do.
- \`pitchVar\` (Bass "Walk", per **slot**) and \`pitchVary\` (Arp/Drone, per **cycle**)
  differ by one letter *and* by grain — a live trap when reading this code.
- Rests and Ghosts are one bipolar density axis pointing opposite ways. Merging is
  a real behaviour change: it hands ghosts to five layers that never had them.
- Six of Motif's controls (Contour, Gravity, Stutter, Twist, Ornament, Slide) are
  one idea — how the walk behaves — presented as six sliders.
`;

const out = path.join(ROOT, 'docs/bloom-stochastic-controls.md');
fs.writeFileSync(out, md);
console.log('wrote ' + path.relative(ROOT, out) + ' — ' + cols.length + ' controls, ' +
  data.types.length + ' layers, ' + Object.keys(byType).length + ' types, ' +
  outside.length + ' outside Variance/Performance');
