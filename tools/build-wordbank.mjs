// tools/build-wordbank.mjs — build the layer-name word bank from Project
// Gutenberg, ONCE, and commit the result.
//
// WHY A BUILD STEP AND NOT A RUNTIME FETCH: naming a layer must work with no
// network, in the native shell, and on a plane. A committed list also means the
// name a layer gets is reviewable — a runtime corpus could serve anything.
//
// WHAT IS KEPT. Frequency is the safety mechanism as much as the quality one:
// the words a reader meets constantly in classic prose are ordinary vocabulary
// (morning, river, silence, hollow), while the period slurs these texts do
// contain sit far down the tail. So the bank is drawn from a frequency BAND —
// common enough to be real and safe, past the function words that carry no
// colour — and then an explicit blocklist catches what rank alone would not.
//
// Run:  node tools/build-wordbank.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'js', 'bloops', 'wordbank.js');

// Public-domain texts chosen for ATMOSPHERE and for neutral vocabulary — the
// bank is meant to name a sound, so the corpus leans on landscape, weather and
// interior quiet rather than on plot.
const BOOKS = [
  [205, 'Walden — Thoreau'],
  [27805, 'The Wind in the Willows — Grahame'],
  [11, 'Alice in Wonderland — Carroll'],
  [2641, 'A Room with a View — Forster'],
  [16, 'Peter Pan — Barrie'],
  [1322, 'Leaves of Grass — Whitman'],
];

// Function words and pronouns: real and frequent, but they name nothing.
const STOP = new Set(`a about above after again against all am an and any are as at be because been
before being below between both but by can cannot could did do does doing down during each few for
from further had has have having he her here hers herself him himself his how i if in into is it its
itself me more most my myself no nor not of off on once only or other ought our ours ourselves out
over own same she should so some such than that the their theirs them themselves then there these
they this those through to too under until up very was we were what when where which while who whom
why with would you your yours yourself yourselves said say says one two three four five six seven
eight nine ten shall will may might must upon thus yet also even still just like made make man men
went come came go going got get give given take taken seem seemed thing things much many little
great good old new long time day days night way ways part place places side hand hands eye eyes
head face fellow sort kind mind heart life world people never always every another around almost
whose whether among though since perhaps indeed rather quite along across behind beside
// CONTRACTION FRAGMENTS. The tokeniser splits on the apostrophe, so "wasn't"
// leaves "wasn" — a high-frequency non-word that sailed straight into the bank.
wasn isn didn doesn couldn wouldn shouldn hasn hadn aren weren mustn needn mightn shan
that's don ain tis twas thou thee thy`
  .split(/\s+/).filter(Boolean));

// Rank alone cannot be trusted with century-old prose. This is a hard refusal
// list: slurs and epithets that appear in public-domain texts, plus a few words
// that would simply read badly as the name of a musical layer.
const BLOCK = new Set(`negro negroes nigger niggers savage savages savagery heathen heathens injun
injuns squaw squaws half-breed halfbreed darkie darkies coon coons wench wenches idiot idiots imbecile
imbeciles lunatic lunatics cripple cripples spastic gypsy gypsies jewess mulatto quadroon octoroon
oriental orientals negress chinaman chinamen redskin redskins papist popish
corpse corpses death dead dying died die kill killed killing murder murdered blood bloody
slave slaves slavery master masters whip whipped
damn damned hell devil devils curse cursed sin sins sinful wicked evil
war wars battle battles gun guns sword swords knife blade wound wounds
disease diseased plague fever sick sickness vomit filth filthy foul stench
hate hatred cruel cruelty torture agony misery wretched wretch
drunk drunken whore whores harlot bastard bastards`
  .split(/\s+/).filter(Boolean));

const fetchBook = async ([id, title]) => {
  const url = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${title}: HTTP ${r.status}`);
  let t = await r.text();
  // Strip Gutenberg's own header/footer — its boilerplate vocabulary
  // ("gutenberg", "ebook", "license", "donations") would otherwise rank high.
  const s = t.indexOf('*** START OF');
  const e = t.indexOf('*** END OF');
  if (s >= 0) t = t.slice(t.indexOf('\n', s) + 1);
  if (e > 0) t = t.slice(0, t.lastIndexOf('*** END OF'));
  console.log(`  ${title}: ${(t.length / 1024 | 0)} KB`);
  return t;
};

const main = async () => {
  console.log('fetching…');
  const texts = await Promise.all(BOOKS.map(fetchBook));

  // Count only words seen in LOWER CASE, which drops most proper nouns (names
  // and places) without needing a gazetteer: "river" appears lowercase
  // constantly, "Ratty" essentially never does.
  const freq = new Map();
  for (const t of texts) {
    for (const m of t.matchAll(/\b[a-z]{4,9}\b/g)) {
      const w = m[0];
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  const isWord = (w) => freq.has(w) && freq.get(w) >= 12;
  const ranked = [...freq.entries()]
    .filter(([w, n]) => n >= 12 && !STOP.has(w) && !BLOCK.has(w))
    // no plurals-of-a-word-we-already-have, and no -ly adverbs: both read as
    // grammar rather than as a name
    .filter(([w]) => !w.endsWith('ly'))
    // PAST TENSES READ AS EVENTS, NOT NAMES — `Listened` is a worse layer name
    // than `Hollow`. Dropped only when the stem is ITSELF a word in the corpus,
    // which is what tells an inflection ("listen|ed") from a noun that merely
    // ends that way (seed, reed, shed, breed). The same test cannot be used on
    // -ing, where the nouns are too good to risk: spring, evening, morning,
    // wing, string all survive a naive stem test badly.
    .filter(([w]) => {
      if (!w.endsWith('ed')) return true;
      const stem = w.slice(0, -2);              // listened -> listen
      const stemE = w.slice(0, -1);             // raised   -> raise
      return !(isWord(stem) || isWord(stemE));
    })
    .sort((a, b) => b[1] - a[1]);

  // SKIP THE TOP OF THE BAND. Even past the stop list the most frequent words
  // are abstractions that name nothing — "without", "nothing", "course",
  // "think". A layer called `nothing` is a worse name than `hollow`, and the
  // colour starts a little further down. Measured by reading the band, not by
  // theory: rank 120 is about where concrete nouns take over.
  const BAND_FROM = 120;
  const seen = new Set();
  const words = [];
  for (const [w] of ranked.slice(BAND_FROM)) {
    if (words.length >= 1400) break;
    // drop a plural whose singular is already in
    if (w.endsWith('s') && seen.has(w.slice(0, -1))) continue;
    // drop a word whose plural we already took
    if (seen.has(w + 's')) continue;
    seen.add(w);
    words.push(w);
  }

  const body = `// GENERATED by tools/build-wordbank.mjs — do not edit by hand.
// A word bank for naming layers, drawn from Project Gutenberg (public domain):
${BOOKS.map(([id, t]) => `//   · ${t}  (gutenberg.org/ebooks/${id})`).join('\n')}
//
// Built ONCE and committed: naming a layer must work with no network, in the
// native shell, and offline — and a committed list is reviewable, which a
// runtime corpus is not. Drawn from a frequency band (common enough to be real
// vocabulary, past the function words that carry no colour), then filtered
// against an explicit blocklist — see the tool for why rank alone is not enough
// with century-old prose.
// ${words.length} words.
window.BLOOPS_WORDBANK = Object.freeze(${JSON.stringify(words)});
`;
  fs.writeFileSync(OUT, body);
  console.log(`\nwrote ${words.length} words -> ${path.relative(process.cwd(), OUT)}`);
  console.log('sample:', words.slice(0, 24).join(' '));
  console.log('mid   :', words.slice(600, 620).join(' '));
  console.log('tail  :', words.slice(-20).join(' '));
};
main().catch((e) => { console.error(e); process.exit(1); });
