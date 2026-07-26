// electron/main.cjs — the desktop shell.
//
//   npm run desktop        SELF-CONTAINED (Phase B core): serves the app from
//                          this repo's files on an embedded local server —
//                          no dev server needed. http:// origin (not file://)
//                          so wasm/worklets/fetch/IndexedDB behave exactly
//                          like the site.
//   BLOOPS_URL=http://localhost:3001/bloops.html npm run desktop
//                          → the Phase-A dev-server mode (edit→refresh dev).
//
// Purpose: DAW-ballpark playback robustness on desktop:
//   • backgroundThrottling: false  — renderer timers NEVER throttle, hidden,
//     minimized, or occluded.
//   • powerSaveBlocker 'prevent-app-suspension' — macOS App Nap can't suspend
//     the app while it's open (standard DAW behavior).
//   • mic permission granted (Track recording); macOS still shows its own
//     one-time system prompt for the Electron binary.
// Phase C (later): media keys / tray / packaged .app via electron-builder.
//
// Smoke mode (CI/headless-ish): BLOOPS_SMOKE=1 npm run desktop
//   → loads the page hidden, verifies the Bloops DOM booted, exits 0/1.
const { app, BrowserWindow, powerSaveBlocker, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SMOKE = !!process.env.BLOOPS_SMOKE;
const ROOT = path.resolve(__dirname, '..');   // repo root (packaged later: resources dir)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain' };
// Embedded static server — loopback only, random port, no-store (matches the
// dev server's no-cache policy so a rebuilt shell never serves stale JS).
function startEmbeddedServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
        if (p === '/' || p === '') p = '/bloops.html';
        const file = path.normalize(path.join(ROOT, p));
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }   // no path escape
        fs.readFile(file, (err, data) => {
          if (err) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0' });
          res.end(data);
        });
      } catch (e) { try { res.writeHead(500); res.end(); } catch (e2) {} }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let win = null;
function createWindow(url) {
  win = new BrowserWindow({
    width: 1360, height: 940,
    show: !SMOKE,
    backgroundColor: '#0b0b12',
    title: 'Bloops',
    webPreferences: {
      backgroundThrottling: false,   // THE point of the shell
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(url).catch(() => {});
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;   // subresource / aborted → not fatal
    if (SMOKE) { console.error('SMOKE: did-fail-load', code, desc); app.exit(1); return; }
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#0b0b12;font-family:sans-serif;color:#eee;padding:40px">' +
      '<h2>Couldn’t load the app</h2>' +
      '<p style="color:#aaa">' + desc + ' ' + code + ' — ' + url + '<br>' +
      '(If you launched dev mode with BLOOPS_URL, make sure that server is running.)</p></body>'));
  });
  if (SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const title = await win.webContents.executeJavaScript('document.title');
        const ok = await win.webContents.executeJavaScript('!!document.getElementById("mix-bloom-host")');
        console.log('SMOKE: loaded', JSON.stringify({ title, bloomHost: ok, url }));
        app.exit(ok ? 0 : 1);
      } catch (e) { console.error('SMOKE: eval failed', e.message); app.exit(1); }
    });
  }
}

app.whenReady().then(async () => {
  // Auto-grant mic/camera-class requests (Track recording) — no Chromium
  // permission bar; the OS-level mic prompt still governs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  powerSaveBlocker.start('prevent-app-suspension');
  // SELF-CONTAINED by default: serve the app from our own files. BLOOPS_URL
  // overrides for dev-server mode (edit → plain refresh).
  let url = process.env.BLOOPS_URL || '';
  if (!url) {
    const { port } = await startEmbeddedServer();
    url = 'http://127.0.0.1:' + port + '/bloops.html';
  }
  createWindow(url);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(url); });
});
app.on('window-all-closed', () => app.quit());
