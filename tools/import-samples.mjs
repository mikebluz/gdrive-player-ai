#!/usr/bin/env node
// Import a folder of audio files into the app's shipped sample library.
//
//   npm run samples                     # prompts for the folder
//   npm run samples -- ~/Sounds/Kit     # or pass it
//   npm run samples -- ~/Sounds --prune # also remove samples no longer in the source
//   npm run samples -- ~/Sounds --dry   # show what would happen, touch nothing
//
// Copies every audio file it finds (at any depth) into ./samples, preserving the
// folder structure, and regenerates samples/manifest.json. deploy.sh already
// ships ./samples, so anything imported here is live after the next deploy.
//
// IDS ARE STABLE AND MATTER. A project stores a voice as `sample:<id>`, so an id
// that changes silently breaks every saved project using it. The id is derived
// from the file's path relative to the source folder, which means: renaming or
// moving a file in the source RENAMES its id and orphans projects that used it,
// while re-running the import on an unchanged tree is a no-op.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'samples');
const MANIFEST = path.join(DEST, 'manifest.json');

// Formats a browser can actually decode. AIFF is deliberately absent — Chrome
// cannot decode it, so importing one would produce a library entry that is
// silent in the app rather than a helpful error.
const AUDIO = new Set(['.wav', '.mp3', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm']);
const SKIP_UNSUPPORTED = new Set(['.aif', '.aiff', '.aifc', '.wma', '.alac', '.caf']);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const DRY = flag('--dry') || flag('-n');
const PRUNE = flag('--prune');
const YES = flag('--yes') || flag('-y');
let src = argv.find(a => !a.startsWith('-'));

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m` };
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// ---- source folder -------------------------------------------------------
async function askForFolder() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const a = (await rl.question(c.b('Folder containing your samples: '))).trim();
      if (!a) { console.log(c.dim('  (nothing entered — ctrl-C to quit)')); continue; }
      // Tolerate a path dragged in from Finder: quoted, and with escaped spaces.
      const p = path.resolve(a.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ').replace(/^~(?=\/|$)/, process.env.HOME || '~'));
      if (!fs.existsSync(p)) { console.log(c.r(`  no such folder: ${p}`)); continue; }
      if (!fs.statSync(p).isDirectory()) { console.log(c.r('  that is a file, not a folder')); continue; }
      return p;
    }
  } finally { rl.close(); }
}

async function confirm(q) {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(q + ' [y/N] ')).trim()); }
  finally { rl.close(); }
}

// ---- scanning ------------------------------------------------------------
function walk(dir, base, out = [], depth = 0) {
  if (depth > 12) return out;                       // a symlink loop should not hang the import
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;           // .DS_Store and friends
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, base, out, depth + 1); continue; }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (SKIP_UNSUPPORTED.has(ext)) { out.push({ rel: path.relative(base, full), unsupported: ext }); continue; }
    if (!AUDIO.has(ext)) continue;
    out.push({ rel: path.relative(base, full), full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs });
  }
  return out;
}

// URL- and id-safe, while staying recognisable. Collisions are resolved by the
// caller rather than by hashing, so the id stays readable.
//
// `#` cannot survive in a filename — it is the URL fragment delimiter, so
// samples/rhodes_F#3.wav would fetch as samples/rhodes_F and 404. Dropping it
// is lossy in a way that BITES: rhodes_F#3 and rhodes_F3 would collapse to the
// same id and the second would be renamed to -2, silently. Map it to the usual
// `s` instead, so F#3 → Fs3 stays distinct and readable.
const slug = (s) => s.normalize('NFKD')
  .replace(/[#♯]/g, 's').replace(/[♭]/g, 'b')
  .replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
const slugPath = (rel) => rel.split(path.sep).map(slug).filter(Boolean).join('/');

// "pad_C4.wav", "kick-a#2.wav", "bell Gb3.wav" → the note the file is recorded at.
// Everything is pitch-shifted from its root note, so guessing this wrong makes a
// sample play at the wrong pitch — hence the conservative pattern (a note letter
// with an explicit octave, at a word boundary) and the C4 fallback.
function rootNoteOf(name) {
  const m = String(name).replace(/\.[^.]+$/, '').match(/(?:^|[^A-Za-z])([A-Ga-g])([#b♯♭]?)(-?[0-8])(?![0-9])/);
  if (!m) return null;
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
  return m[1].toUpperCase() + acc + m[3];
}

const prettyName = (rel) => {
  const base = path.basename(rel).replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || base;
};

// ---- run -----------------------------------------------------------------
(async () => {
  console.log(c.b('\nBloops sample import\n'));
  if (!src) src = await askForFolder();
  else {
    src = path.resolve(src.replace(/^~(?=\/|$)/, process.env.HOME || '~'));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      console.error(c.r(`Not a folder: ${src}`)); process.exit(1);
    }
  }
  if (path.resolve(src) === DEST) { console.error(c.r('Source and destination are the same folder.')); process.exit(1); }

  console.log(c.dim(`  source: ${src}`));
  console.log(c.dim(`  dest:   ${DEST}${DRY ? c.y('   (dry run — nothing will be written)') : ''}\n`));

  const found = walk(src, src);
  const unsupported = found.filter(f => f.unsupported);
  const files = found.filter(f => !f.unsupported).sort((a, b) => a.rel.localeCompare(b.rel));
  if (!files.length) {
    console.log(c.y('No importable audio found.'));
    if (unsupported.length) console.log(c.dim(`  (${unsupported.length} file(s) in formats browsers cannot decode — see below)`));
    else console.log(c.dim(`  Looked for: ${[...AUDIO].join(' ')}`));
    if (!unsupported.length) process.exit(0);
  }

  // Build entries, resolving id collisions (two files can slug to one name).
  const entries = [], seen = new Map();
  let copied = 0, unchanged = 0, bytes = 0, guessed = 0;
  for (const f of files) {
    const relSlug = slugPath(f.rel);
    let id = relSlug.replace(/\.[^.]+$/, '');
    if (seen.has(id)) { let n = 2; while (seen.has(id + '-' + n)) n++; id = id + '-' + n; }
    seen.set(id, f.rel);

    const destRel = id + path.extname(f.rel).toLowerCase();
    const destAbs = path.join(DEST, destRel);
    let need = true;
    try { const st = fs.statSync(destAbs); need = (st.size !== f.size); } catch (e) { need = true; }
    if (need) {
      if (!DRY) { fs.mkdirSync(path.dirname(destAbs), { recursive: true }); fs.copyFileSync(f.full, destAbs); }
      copied++;
    } else unchanged++;
    bytes += f.size;

    const rn = rootNoteOf(f.rel);
    if (!rn) guessed++;
    entries.push({ id, file: destRel, name: prettyName(f.rel), rootNote: rn || 'C4' });
  }

  // Anything in samples/ that this import did not produce.
  const shipped = walk(DEST, DEST).filter(f => !f.unsupported).map(f => f.rel.split(path.sep).join('/'));
  const produced = new Set(entries.map(e => e.file));
  const orphans = shipped.filter(r => !produced.has(r));

  if (orphans.length) {
    console.log(c.y(`${orphans.length} file(s) already in samples/ are not in this source folder:`));
    orphans.slice(0, 12).forEach(o => console.log(c.dim('    ' + o)));
    if (orphans.length > 12) console.log(c.dim(`    …and ${orphans.length - 12} more`));
    if (PRUNE) {
      if (DRY) console.log(c.y('  --prune: would delete the files above.\n'));
      else if (await confirm(c.r('  --prune: DELETE the files above?'))) {
        orphans.forEach(o => { try { fs.unlinkSync(path.join(DEST, o)); } catch (e) {} });
        pruneEmptyDirs(DEST);   // else a removed folder lingers forever as an empty one
        console.log(c.g(`  deleted ${orphans.length}.\n`));
      } else { console.log(c.dim('  kept.\n')); orphans.forEach(o => keepOrphan(o, entries)); }
    } else {
      console.log(c.dim('  Keeping them (they stay in the library). Re-run with --prune to remove.\n'));
      orphans.forEach(o => keepOrphan(o, entries));
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  if (!DRY) {
    fs.mkdirSync(DEST, { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify({ samples: entries }, null, 2) + '\n');
  }

  // ---- report ------------------------------------------------------------
  console.log(c.b('Imported'));
  console.log(`  ${c.g(String(entries.length))} sample(s) in the library   ${c.dim(`(${copied} copied, ${unchanged} already current)`)}`);
  console.log(`  ${c.dim(mb(bytes) + ' of audio')}`);
  if (guessed) console.log(c.dim(`  ${guessed} had no note in the filename → root note C4 (edit manifest.json to correct)`));
  if (unsupported.length) {
    console.log('\n' + c.y(`Skipped ${unsupported.length} file(s) in formats browsers cannot decode:`));
    [...new Set(unsupported.map(u => u.unsupported))].forEach(e => console.log(c.dim('    ' + e)));
    console.log(c.dim('    Convert to .wav or .mp3 to include them.'));
  }
  if (DRY) console.log('\n' + c.y('Dry run — samples/ and manifest.json were not modified.'));

  // Loading is LAZY: an entry is registered (so it shows up in every voice
  // picker) but nothing is fetched until it is selected, referenced by the
  // stored project, or played. So library SIZE is no longer a boot cost — only
  // what you actually use gets downloaded.
  console.log('\n' + c.b('Loading'));
  console.log(c.dim(`  Registered, not preloaded — nothing is fetched until a sample is selected,`));
  console.log(c.dim(`  used by the open project, or played. Library size does not slow the boot.`));
  console.log(c.dim(`  ${entries.length} entries, ${mb(bytes)} on disk (shipped with the app).`));
  console.log('\n' + c.dim('  Live locally now (npm start). Reaches production on the next deploy —') );
  console.log(c.dim('  deploy.sh already ships ./samples.\n'));
})();

// Remove directories left empty by a prune. Depth-first, and never the root.
function pruneEmptyDirs(dir, top = true) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), false);
  if (top) return;
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (e) {}
}
// A file already in samples/ that the source no longer has still deserves a
// manifest entry, or it would ship but be unreachable.
function keepOrphan(rel, entries) {
  const id = rel.replace(/\.[^.]+$/, '');
  if (entries.some(e => e.id === id)) return;
  entries.push({ id, file: rel, name: prettyName(rel), rootNote: rootNoteOf(rel) || 'C4' });
}
