#!/usr/bin/env node
/**
 * Build Bloops.app — the desktop shell, as a real application.
 *
 *   npm run desktop:build
 *
 * WHY THIS EXISTS. `npm run desktop` already gives you a shell whose renderer
 * never throttles, so a Bloom keeps playing while the window is behind
 * something else or minimised. But it has to be started from a terminal, in
 * this directory, with the repo present — which is not "an app you leave
 * running". This produces dist/Bloops.app, which you can put in /Applications
 * and launch like anything else.
 *
 * WHAT GETS COPIED. Everything the embedded server might serve, and nothing
 * else: no node_modules, no .git, no tools, no test baselines. The list is
 * explicit rather than an ignore-list, because an ignore-list silently ships
 * whatever gets added to the repo later.
 *
 * SIGNING. The app is unsigned. macOS will refuse it on first launch — the fix
 * is right-click → Open, once. Notarising needs a paid Apple Developer account
 * ($99/yr) and is not worth it for a personal tool.
 */

// v18.3.6, not the current release: 19+ require Node >= 22.12 and this machine
// runs 18. It is CommonJS, so it comes in through createRequire rather than a
// named import.
import { createRequire } from 'node:module';
const { packager } = createRequire(import.meta.url)('@electron/packager');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STAGE = path.join(ROOT, '.desktop-stage');
const OUT = path.join(ROOT, 'dist');

// Exactly what the app needs to run offline. Kept in step with deploy.sh's
// staging line by hand — if a new top-level asset dir appears there, it
// belongs here too.
const INCLUDE = [
  'bloops.html', 'player.html', 'tracks.html', 'artwork.html', 'game.html', 'index.html',
  'css', 'js', 'img', 'audio', 'samples', 'vendor', 'artwork',
  'banner.jpg', 'me2026.jpg',
];

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mb = (p) => {
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else n += fs.statSync(f).size; } };
  fs.statSync(p).isDirectory() ? walk(p) : (n = fs.statSync(p).size);
  return (n / 1e6).toFixed(0) + ' MB';
};

console.log('Staging app files…');
rm(STAGE);
fs.mkdirSync(path.join(STAGE, 'electron'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'electron', 'main.cjs'), path.join(STAGE, 'electron', 'main.cjs'));

let missing = [];
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) { missing.push(item); continue; }
  fs.cpSync(src, path.join(STAGE, item), { recursive: true });
}
if (missing.length) console.log('  (not present, skipped: ' + missing.join(', ') + ')');

// js/config.js holds Google API credentials and is gitignored. It is fine for
// it to be inside a LOCAL build — that is how Drive sign-in works at all — but
// say so out loud, because this .app is shareable and that would share them.
if (fs.existsSync(path.join(STAGE, 'js', 'config.js'))) {
  console.log('  ⚠ js/config.js is bundled — it carries your Google API keys.');
  console.log('    Fine for your own machine. Do NOT hand this .app to anyone else.');
}

// A minimal package.json so Electron knows the entry point.
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
  name: 'bloops', productName: 'Bloops', version: '1.0.0',
  main: 'electron/main.cjs',
}, null, 2));

console.log('Staged ' + mb(STAGE) + '. Packaging…');
rm(OUT);

const built = await packager({
  dir: STAGE,
  out: OUT,
  overwrite: true,
  asar: true,
  name: 'Bloops',
  appBundleId: 'com.mikeluz.bloops',
  appCategoryType: 'public.app-category.music',
  // The whole point of the shell: the OS must not suspend us, and the mic
  // prompt needs a reason string or macOS kills the request outright.
  extendInfo: {
    NSMicrophoneUsageDescription:
      'Bloops records audio takes from your microphone or line input.',
    LSMinimumSystemVersion: '10.15',
  },
  // Electron copies `dir` to Resources/app; main.cjs resolves ROOT there.
  prune: true,
});

rm(STAGE);
const appPath = path.join(built[0], 'Bloops.app');
console.log('\n✓ ' + appPath + '  (' + mb(appPath) + ')');
console.log('\nFirst launch: right-click → Open, then confirm. It is unsigned, so a');
console.log('double-click will be refused. After that it opens normally.');
console.log('\nBackgrounded playback is the point — leave a Bloom running and switch away.');
