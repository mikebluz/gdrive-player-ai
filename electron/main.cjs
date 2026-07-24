// electron/main.cjs — Phase A desktop dev shell.
//
//   npm run desktop        (dev server must be running: npm start)
//
// Purpose: DAW-ballpark playback robustness on desktop. The browser throttles
// hidden-tab timers (the reason Stage 0's worker ticker exists); this shell
// removes the whole class of problem:
//   • backgroundThrottling: false  — renderer timers NEVER throttle, hidden,
//     minimized, or occluded.
//   • powerSaveBlocker 'prevent-app-suspension' — macOS App Nap can't suspend
//     the app while it's open (standard DAW behavior).
//   • mic permission granted (Track recording); macOS still shows its own
//     one-time system prompt for the Electron binary.
// Phase A loads the SAME dev server as browser dev (edit → refresh unchanged).
// Phase B will bundle files + electron-builder; Phase C media keys / tray.
//
// Smoke mode (CI/headless-ish): BLOOPS_SMOKE=1 npm run desktop
//   → loads the page hidden, verifies the Bloops DOM booted, exits 0/1.
const { app, BrowserWindow, powerSaveBlocker, session } = require('electron');

const DEV_URL = process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html';
const SMOKE = !!process.env.BLOOPS_SMOKE;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let win = null;
function createWindow() {
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
  win.loadURL(DEV_URL).catch(() => {});
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;   // subresource / aborted → not fatal
    if (SMOKE) { console.error('SMOKE: did-fail-load', code, desc); app.exit(1); return; }
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#0b0b12;font-family:sans-serif;color:#eee;padding:40px">' +
      '<h2>Dev server not reachable</h2>' +
      '<p style="color:#aaa">Start it with <code>npm start</code>, then relaunch the app.<br>' +
      '<small>(' + desc + ' ' + code + ' — ' + DEV_URL + ')</small></p></body>'));
  });
  if (SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const title = await win.webContents.executeJavaScript('document.title');
        const ok = await win.webContents.executeJavaScript('!!document.getElementById("mix-bloom-host")');
        console.log('SMOKE: loaded', JSON.stringify({ title, bloomHost: ok }));
        app.exit(ok ? 0 : 1);
      } catch (e) { console.error('SMOKE: eval failed', e.message); app.exit(1); }
    });
  }
}

app.whenReady().then(() => {
  // Auto-grant mic/camera-class requests (Track recording) — no Chromium
  // permission bar; the OS-level mic prompt still governs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  powerSaveBlocker.start('prevent-app-suspension');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
