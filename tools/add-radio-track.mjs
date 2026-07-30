#!/usr/bin/env node
/**
 * Install a Bloom capture as a channel on the home page radio.
 *
 *   npm run radio                 # pick up every radio--*.wav in ~/Downloads
 *   npm run radio -- path/to.wav  # or name files explicitly
 *   npm run radio -- --list       # show what is installed
 *   npm run radio -- --rm NAME    # remove a channel
 *
 * THE PIPELINE, and why it has a local step at all:
 *
 *   Bloops (Harvest 📻 / Tracks 📻)  →  ~/Downloads/radio--<name>.wav
 *   this script                      →  audio/<name>.m4a + audio/radio.json
 *   ./deploy.sh                      →  visitors hear it
 *
 * The radio plays files that SHIP WITH THE SITE. A capture living in the
 * browser — IndexedDB, Drive, anywhere — is audible to exactly one person, so
 * publishing has to put a real file in the project directory. The browser
 * cannot encode AAC, and a WAV mixdown is tens of megabytes, so the encode has
 * to happen here: `afconvert` is macOS-native, so there is nothing to install.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AUDIO = path.join(ROOT, 'audio');
const MANIFEST = path.join(AUDIO, 'radio.json');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const BITRATE = 157000;                    // matches the single already on the site

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const files = argv.filter((a) => !a.startsWith('--'));

const readManifest = () => {
  try { const j = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); return Array.isArray(j.tracks) ? j : { tracks: [] }; }
  catch { return { tracks: [] }; }
};
const writeManifest = (m) => {
  fs.mkdirSync(AUDIO, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
};
const mb = (p) => (fs.statSync(p).size / 1e6).toFixed(1) + ' MB';

// ── --list ────────────────────────────────────────────────────────────────
if (has('--list')) {
  const m = readManifest();
  if (!m.tracks.length) { console.log('No radio channels installed.'); process.exit(0); }
  console.log('Radio channels (' + m.tracks.length + '):');
  for (const t of m.tracks) {
    const f = path.join(AUDIO, t.file);
    console.log('  ' + t.name.padEnd(20) + t.file.padEnd(34) +
      (fs.existsSync(f) ? mb(f) : 'MISSING — file is gone'));
  }
  process.exit(0);
}

// ── --rm NAME ─────────────────────────────────────────────────────────────
if (has('--rm')) {
  const want = (argv[argv.indexOf('--rm') + 1] || '').toLowerCase();
  if (!want) { console.error('--rm needs a channel name. Try --list.'); process.exit(1); }
  const m = readManifest();
  const hit = m.tracks.find((t) => t.name.toLowerCase() === want || t.file.toLowerCase() === want);
  if (!hit) { console.error('No channel called "' + want + '". Try --list.'); process.exit(1); }
  m.tracks = m.tracks.filter((t) => t !== hit);
  try { fs.unlinkSync(path.join(AUDIO, hit.file)); } catch {}
  writeManifest(m);
  console.log('Removed "' + hit.name + '" and deleted ' + hit.file);
  console.log('Run ./deploy.sh to take it off the live site.');
  process.exit(0);
}

// ── find the takes ────────────────────────────────────────────────────────
let sources = files.map((f) => path.resolve(f));
if (!sources.length) {
  try {
    sources = fs.readdirSync(DOWNLOADS)
      .filter((f) => /^radio--.+\.wav$/i.test(f))
      .map((f) => path.join(DOWNLOADS, f))
      // oldest first, so a batch installs in the order it was exported
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  } catch { sources = []; }
}
if (!sources.length) {
  console.log('Nothing to install.\n');
  console.log('  In Bloops:  Harvest → 📻 on a capture,  or  Tracks → 📻 To radio');
  console.log('  That downloads radio--<name>.wav to ~/Downloads. Then run this again.');
  console.log('  Or name a file directly:  npm run radio -- some-take.wav');
  process.exit(0);
}

// afconvert is macOS-only; say so plainly rather than failing with a cryptic ENOENT
try { execFileSync('which', ['afconvert'], { stdio: 'ignore' }); }
catch {
  console.error('afconvert not found. It ships with macOS; on another platform use\n' +
                'ffmpeg to make audio/<name>.m4a by hand and add it to audio/radio.json.');
  process.exit(1);
}

const manifest = readManifest();
fs.mkdirSync(AUDIO, { recursive: true });
let installed = 0;

for (const src of sources) {
  if (!fs.existsSync(src)) { console.error('✗ missing: ' + src); continue; }
  const base = path.basename(src).replace(/\.wav$/i, '').replace(/^radio--/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'take';
  const out = path.join(AUDIO, slug + '.m4a');
  const name = slug.replace(/-/g, ' ').toUpperCase();

  try {
    execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', String(BITRATE), '-s', '1', src, out],
                 { stdio: 'ignore' });
  } catch (e) {
    console.error('✗ encode failed for ' + path.basename(src)); continue;
  }

  // Same name twice = replace it, not a second channel playing the same thing.
  const prev = manifest.tracks.findIndex((t) => t.file === slug + '.m4a');
  const entry = { name, file: slug + '.m4a' };
  if (prev >= 0) manifest.tracks[prev] = entry; else manifest.tracks.push(entry);

  console.log('✓ ' + name.padEnd(18) + path.basename(src) + ' (' + mb(src) + ')  →  audio/' +
              slug + '.m4a (' + mb(out) + ')' + (prev >= 0 ? '   [replaced]' : ''));
  installed++;
}

if (!installed) process.exit(1);
writeManifest(manifest);
console.log('\n' + manifest.tracks.length + ' channel' + (manifest.tracks.length === 1 ? '' : 's') +
            ' in audio/radio.json. The radio picks them up on the next page load.');
console.log('Run ./deploy.sh when you want them live.');
