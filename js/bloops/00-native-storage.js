// 00-native-storage.js — project-safety mirroring for the native (Capacitor)
// shell. WKWebView localStorage is evictable under storage pressure; the iOS
// Documents directory is not (and is iCloud-backed). So in the shell, the keys
// that hold the user's actual work are mirrored to a JSON file in Documents,
// and restored at boot if localStorage comes up empty.
//
// Inert everywhere but the shell (needs Capacitor's Filesystem plugin, which
// only exists there). Restore is ASYNC while the app reads localStorage
// synchronously at boot — so a restore that changed anything reloads the page
// ONCE (sessionStorage guard) rather than pretending the app saw the data.
(function () {
  'use strict';

  const KEYS = ['bloops-workspace', 'sounds-saved'];   // the user's work
  const FILE = 'bloops-backup.json';
  const log = (m) => { try { console.log('[native-storage] ' + m); } catch (e) {} };

  function fsPlugin() {
    try {
      if (!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return null;
      return (window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
    } catch (e) { return null; }
  }
  // SOAK HYGIENE (learned the hard way — test runs appended layers to the
  // user's real project): a soak build stashes the live workspace before the
  // harness touches it, and the next NON-soak boot restores the stash.
  try {
    if (window.__BLOOPS_SOAK) {
      if (localStorage.getItem('__presoak') == null) {
        localStorage.setItem('__presoak', localStorage.getItem('bloops-workspace') || '');
        log('soak build — stashed the real workspace');
      }
    } else if (localStorage.getItem('__presoak') != null) {
      const stash = localStorage.getItem('__presoak');
      if (stash) localStorage.setItem('bloops-workspace', stash);
      else localStorage.removeItem('bloops-workspace');
      localStorage.removeItem('__presoak');
      log('restored the pre-soak workspace');
    }
  } catch (e) {}

  const FS = fsPlugin();
  if (!FS) return;

  const snapshot = () => {
    const o = {};
    for (const k of KEYS) { try { const v = localStorage.getItem(k); if (v != null) o[k] = v; } catch (e) {} }
    return o;
  };
  const sig = (o) => { let n = 0; for (const k in o) n += o[k].length; return Object.keys(o).join(',') + ':' + n; };

  let lastSig = null;
  async function mirror(why) {
    const snap = snapshot();
    if (!Object.keys(snap).length) return;           // nothing to save — never overwrite a backup with emptiness
    const s = sig(snap);
    if (s === lastSig) return;
    try {
      await FS.writeFile({
        path: FILE, directory: 'DOCUMENTS',
        data: JSON.stringify({ at: Date.now(), keys: snap }),
        encoding: 'utf8',
      });
      lastSig = s;
      log('mirrored ' + Object.keys(snap).length + ' key(s) (' + why + ')');
    } catch (e) { log('mirror failed: ' + (e && e.message)); }
  }

  async function restoreIfPurged() {
    // Only when the workspace is genuinely absent — a present-but-different
    // workspace is the user's current state, never to be clobbered.
    let have = null;
    try { have = localStorage.getItem('bloops-workspace'); } catch (e) {}
    if (have) return false;
    let raw;
    try { raw = (await FS.readFile({ path: FILE, directory: 'DOCUMENTS', encoding: 'utf8' })).data; }
    catch (e) { return false; }                       // no backup — fresh install
    try {
      const b = JSON.parse(raw);
      let n = 0;
      for (const k in (b.keys || {})) { localStorage.setItem(k, b.keys[k]); n++; }
      if (!n) return false;
      log('RESTORED ' + n + ' key(s) from Documents backup (' + new Date(b.at).toISOString() + ')');
      return true;
    } catch (e) { log('restore failed: ' + (e && e.message)); return false; }
  }

  (async () => {
    const guard = '_nativeStorageReloaded';
    let reloaded = false;
    try { reloaded = sessionStorage.getItem(guard) === '1'; } catch (e) {}
    if (!reloaded && await restoreIfPurged()) {
      try { sessionStorage.setItem(guard, '1'); } catch (e) {}
      log('reloading so the app boots on the restored data');
      location.reload();
      return;
    }
    mirror('boot');
    setInterval(() => mirror('interval'), 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') mirror('background');
    });
    window.addEventListener('pagehide', () => { mirror('pagehide'); });
  })();
})();
