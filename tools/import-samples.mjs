#!/usr/bin/env node
// Import a folder of audio files into the app's shipped sample library.
//
//   npm run samples                     # prompts for the folder
//   npm run samples -- ~/Sounds/Kit     # or pass it
//   npm run samples -- ~/Sounds --prune # also remove samples no longer in the source
//   npm run samples -- ~/Sounds --dry   # show what would happen, touch nothing
//   npm run samples -- samples/sounds   # IN PLACE: source already inside samples/
//
// IN-PLACE MODE. If the source folder is INSIDE ./samples (dropping packs into
// samples/sounds/, say), nothing is copied — the audio is already where it needs
// to be, so it is registered at its existing path and your folder structure is
// preserved. Copying would otherwise write a second copy and ship every file
// twice. The one thing you lose is the filename slugging, so in-place warns
// about characters a URL cannot carry (`#`, `?`, `%`, `\\`) rather than
// silently producing entries that 404.
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

// ---- KIND: does this sample carry its own TEMPO? -------------------------
// The distinction that matters is NOT "can I pitch it" (you can pitch anything)
// but "does it bring a tempo with it". A LOOP does, so the project tempo has to
// reconcile with it and a note must not transpose it; a TUNED sample does not,
// so a note is free to transpose it. Before this, every manifest entry was
// registered as a Tone.Sampler rooted at C4 — a 7-second 130 bpm drum loop was
// an "instrument", and playing it at C5 ran it at double speed.
//
// Three signals, in precedence order. An explicit path folder beats everything
// (sample packs are organised by exactly this distinction), then duration, then
// a bpm in the name. Duration is only available for WAV without pulling in a
// decoder, which is why it is not the primary signal.
const LOOP_MIN_SEC = 1.6;      // longest one-shot measured in real packs: 0.62s
const ONESHOT_MAX_SEC = 1.0;

// RIFF/WAVE header only — no dependency, and every pack ships wav. Other formats
// fall back to the path/name signals, which is honest rather than guessing.
function wavDurationSec(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    if (n < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, rate = 0, byteRate = 0;
    while (off + 8 <= n) {
      const id = buf.toString('ascii', off, off + 4);
      const sz = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') { rate = buf.readUInt32LE(off + 12); byteRate = buf.readUInt32LE(off + 16); }
      else if (id === 'data') {
        const bytes = (sz > 0 && sz !== 0xffffffff) ? sz : (fs.statSync(file).size - (off + 8));
        if (byteRate > 0) return bytes / byteRate;
        return null;
      }
      off += 8 + sz + (sz & 1);
    }
    return null;
  } catch (e) { return null; }
}

// A tempo stated in the filename — "drum125", "_130_", "128bpm". Bounded to a
// musically plausible range so a catalogue number or a year cannot masquerade
// as one. This is what makes a loop USABLE: without it the engine cannot
// rate-match the loop to the project and it drifts against everything else.
function bpmOf(rel) {
  const base = path.basename(rel).replace(/\.[^.]+$/, '');
  const withUnit = base.match(/(\d{2,3})\s*bpm/i);
  if (withUnit) { const v = +withUnit[1]; if (v >= 60 && v <= 200) return v; }
  const cands = (base.match(/\d{2,3}/g) || []).map(Number).filter(v => v >= 60 && v <= 200);
  return cands.length ? cands[0] : null;
}

function classify(rel, durSec) {
  const low = rel.toLowerCase().split(path.sep).join('/');
  const bpm = bpmOf(rel);
  const inOneShot = /(^|\/)(one[_ -]?shots?|oneshot|hits?|drum_hits)(\/|$)/.test(low) || /one[_ -]?shot/.test(path.basename(low));
  const inLoops = /(^|\/)([a-z_]*loops?)(\/|$)/.test(low) || /(^|[_-])loop([_-]|$)/.test(path.basename(low));
  // Precedence: the pack's own folders, then duration, then a bpm in the name.
  let kind = null, why = '';
  if (inOneShot && !inLoops) { kind = 'tuned'; why = 'one-shot folder'; }
  else if (inLoops) { kind = 'loop'; why = 'loop folder'; }
  // A NOTE IN THE FILENAME IS AN EXPLICIT STATEMENT OF PITCH — "pad C3.wav" is a
  // tuned instrument however long it is, and long sustained samples (pads,
  // strings, organ) are exactly the ones duration alone would misfile as loops.
  else if (rootNoteOf(rel)) { kind = 'tuned'; why = 'note in the name'; }
  else if (durSec != null && durSec >= LOOP_MIN_SEC) { kind = 'loop'; why = durSec.toFixed(1) + 's long'; }
  else if (durSec != null && durSec <= ONESHOT_MAX_SEC) { kind = 'tuned'; why = durSec.toFixed(2) + 's short'; }
  else if (bpm) { kind = 'loop'; why = 'bpm in name'; }
  else { kind = 'tuned'; why = 'default'; }
  return { kind, bpm: kind === 'loop' ? bpm : null, why, durSec };
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

  // IN-PLACE MODE. When the source folder lives INSIDE samples/ — dropping packs
  // straight into samples/sounds/ — copying would write a second copy at
  // samples/<slug>/… and ship every file twice. There is nothing to copy: the
  // audio is already where it needs to be. So register it where it lies and keep
  // the folder structure the user built, deriving ids from the path relative to
  // samples/ (ids must describe where the file actually is, since a project
  // stores `sample:<id>`).
  const _rel = path.relative(DEST, src);
  const INPLACE = _rel === '' || (!_rel.startsWith('..') && !path.isAbsolute(_rel));
  if (INPLACE) {
    console.log(c.dim('  mode:   in place — the source is inside samples/, so nothing is copied;'));
    console.log(c.dim('          files are registered where they already are, structure preserved.\n'));
  }

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
  const changedList = [];
  const entries = [], seen = new Map();
  let added = 0, updated = 0, unchanged = 0, bytes = 0, guessed = 0;
  const kinds = {}, classified = [];
  for (const f of files) {
    // In place: the path is what it already is under samples/ (NOT slugged — the
    // file is not being renamed, so the manifest must point at the real name).
    // Copy mode: the slug IS the destination filename, so id and path agree.
    const _inRel = INPLACE ? path.join(_rel, f.rel).split(path.sep).join('/') : null;
    const relSlug = slugPath(f.rel);
    let id = INPLACE ? slugPath(path.join(_rel, f.rel)).replace(/\.[^.]+$/, '')
                     : relSlug.replace(/\.[^.]+$/, '');
    if (seen.has(id)) { let n = 2; while (seen.has(id + '-' + n)) n++; id = id + '-' + n; }
    seen.set(id, f.rel);

    const destRel = INPLACE ? _inRel : (id + path.extname(f.rel).toLowerCase());
    const destAbs = path.join(DEST, destRel);
    // Re-copy only what actually changed, so re-running on a big library is
    // cheap. Size alone is NOT enough: an audio file edited in place — gain
    // normalised, a different take of the same length, a re-render — keeps its
    // byte count exactly, so a size-only check left the app serving the OLD
    // audio forever (reproduced: 440 Hz replaced by 880 Hz, same 22094 bytes,
    // never recopied). So: size differs → copy; size matches but the source is
    // newer → hash both and copy only if the bytes really differ, which keeps a
    // merely-touched file from being recopied.
    let need = true, existed = false;
    if (INPLACE) { unchanged++; bytes += f.size; }
    else {
    try {
      const st = fs.statSync(destAbs);
      existed = true;
      if (st.size !== f.size) need = true;
      else if (f.mtime > st.mtimeMs + 1) need = !sameBytes(f.full, destAbs);
      else need = false;
    } catch (e) { need = true; }
    if (need) {
      if (!DRY) { fs.mkdirSync(path.dirname(destAbs), { recursive: true }); fs.copyFileSync(f.full, destAbs); }
      // NEW vs UPDATED is the distinction you want when re-running on a library
      // you have been editing — "3 new" and "3 updated" mean very different
      // things, and one lumped "copied" count hides which happened.
      if (existed) { updated++; changedList.push(['~', destRel]); }
      else { added++; changedList.push(['+', destRel]); }
    } else unchanged++;
    bytes += f.size;
    }

    const cls = classify(f.rel, f.full ? wavDurationSec(f.full) : null);
    kinds[cls.kind] = (kinds[cls.kind] || 0) + 1;
    classified.push({ rel: destRel, ...cls });
    const rn = rootNoteOf(f.rel);
    const e = { id, file: destRel, name: prettyName(f.rel), kind: cls.kind };
    if (cls.kind === 'loop') {
      // No rootNote: a loop is not played AT a note, so inventing C4 is the very
      // fiction this change removes. bpm/seconds are what a loop needs instead.
      if (cls.bpm) e.bpm = cls.bpm;
      if (cls.durSec) e.seconds = +cls.durSec.toFixed(3);
    } else {
      if (!rn) guessed++;
      e.rootNote = rn || 'C4';
    }
    entries.push(e);
  }

  {
    const parts = Object.keys(kinds).sort().map(k => c.b(String(kinds[k])) + ' ' + k);
    if (parts.length) console.log('\n' + c.b('Kinds') + '   ' + parts.join(c.dim('  ·  ')));
    const loops = classified.filter(x => x.kind === 'loop');
    if (loops.length) {
      loops.slice(0, 8).forEach(x => console.log(c.dim('    loop   ' + (x.bpm ? (x.bpm + ' bpm') : c.y('bpm unknown')) + '   ' + x.rel + c.dim('   (' + x.why + ')'))));
      if (loops.length > 8) console.log(c.dim(`    …and ${loops.length - 8} more`));
      const noBpm = loops.filter(x => !x.bpm).length;
      if (noBpm) console.log(c.y(`  ${noBpm} loop(s) have no bpm in the filename — add one (e.g. "…_124.wav") so they can be tempo-matched.`));
    }
    console.log(c.dim('  Loops are not played at a note; tuned samples are. Override by editing "kind" in manifest.json.\n'));
  }

  // IN-PLACE ONLY: copy mode SLUGS every filename, which is what quietly removes
  // characters a URL cannot carry (`#` is the fragment delimiter — a file called
  // `kick#2.wav` is fetched as `kick` and 404s). In place we keep the real name,
  // so that safety net is gone and the tool has to say so instead.
  if (INPLACE) {
    const hostile = entries.filter(e => /[#?%\\]/.test(e.file));
    if (hostile.length) {
      console.log(c.y(`${hostile.length} file(s) contain characters a URL cannot carry (# ? % \\):`));
      hostile.slice(0, 8).forEach(e => console.log(c.dim('    ' + e.file)));
      console.log(c.dim('  These will 404 in the app. Rename them in samples/ and re-run —'));
      console.log(c.dim('  in-place mode keeps your filenames, so it cannot fix this for you.\n'));
    }
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
  const verb = DRY ? 'would be ' : '';
  console.log(c.b('Imported'));
  if (added)   console.log(`  ${c.g(String(added))} new       ${c.dim(verb + 'copied in')}`);
  if (updated) console.log(`  ${c.y(String(updated))} updated   ${c.dim(verb + 'changed since the last run')}`);
  if (unchanged) console.log(`  ${c.dim(String(unchanged) + ' unchanged   already current, not copied')}`);
  if (changedList.length && changedList.length <= 20) {
    changedList.forEach(([mk, rel]) => console.log(c.dim(`      ${mk} ${rel}`)));
  } else if (changedList.length) {
    changedList.slice(0, 12).forEach(([mk, rel]) => console.log(c.dim(`      ${mk} ${rel}`)));
    console.log(c.dim(`      …and ${changedList.length - 12} more`));
  }
  console.log(`  ${c.b(String(entries.length))} sample(s) in the library   ${c.dim(mb(bytes) + ' of audio')}`);
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

// Content compare, for the "same size, newer mtime" case. Streams in chunks so a
// long sample is not held in memory twice.
function sameBytes(a, b) {
  let fa = null, fb = null;
  try {
    fa = fs.openSync(a, 'r'); fb = fs.openSync(b, 'r');
    const A = Buffer.alloc(65536), B = Buffer.alloc(65536);
    for (;;) {
      const na = fs.readSync(fa, A, 0, A.length, null);
      const nb = fs.readSync(fb, B, 0, B.length, null);
      if (na !== nb) return false;
      if (na === 0) return true;
      if (!A.subarray(0, na).equals(B.subarray(0, nb))) return false;
    }
  } catch (e) { return false; }               // unreadable → treat as different, i.e. re-copy
  finally { try { if (fa !== null) fs.closeSync(fa); } catch (e) {} try { if (fb !== null) fs.closeSync(fb); } catch (e) {} }
}
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
