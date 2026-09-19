// PROBE — the sign-in gate is a WEB-ONLY door.
//
// Deployed web: no token -> the full-screen #signin-gate covers Bloops, and the
// Player shows "Connect to Google Drive" with no player chrome.
// Native shell: no token -> Bloops opens into the instrument with Sign in in
// the project bar, and the Player opens on whatever playlist is cached, ready
// to play (loaded, NOT playing).
//
// "Deployed" is simulated by resolving a non-local hostname at 127.0.0.1, so
// window.BLOOPS_LOCAL is false exactly as it is on the real site. "Native" is
// simulated with localStorage bloopsNativeShell='1' (the documented override
// for window.BLOOPS_NATIVE). Needs a server on :3001 (or PROBE_PORT).
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST = process.env.PROBE_HOST || 'bloops.test';
const PORT = process.env.PROBE_PORT || '3001';
const BASE = `http://${HOST}:${PORT}`;
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  — ' + (detail || '')); }
};

// One cached playlist for the Player to boot from. Two tracks, neither with
// bytes in IndexedDB — enough to prove the list renders and the first track
// loads; playing an unsaved track is the "Sign in to play this track" path.
const CACHED = {
  name: 'bloops/exports',
  artist: 'Mercy Wizard',
  tracks: [
    { id: 'probe-track-1', name: 'First Cached Song.mp3', size: 1234, modifiedMs: 2000 },
    { id: 'probe-track-2', name: 'Second Cached Song.mp3', size: 5678, modifiedMs: 1000 },
  ],
};

// Measured, not queried: a 0x0 rect or a null offsetParent is the documented
// tell for "in the DOM but not on screen".
const vis = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return { found: false, on: false };
  const r = el.getBoundingClientRect();
  return { found: true, w: Math.round(r.width), h: Math.round(r.height),
           // checkVisibility, not offsetParent: the gate is position:fixed, and
           // a fixed element's offsetParent is null even when it covers the
           // screen. This still reports false for a display:none ancestor.
           on: (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : !!el.offsetParent)
               && r.width > 0 && r.height > 0,
           text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) };
}, sel);

// AudioWorkletNode needs a secure context; this probe deliberately runs on a
// non-localhost hostname over http to make BLOOPS_LOCAL false, so the audio
// core's worklet path throws every time. Environmental, not a regression.
const realErrors = (errs) => errs.filter((e) => !/AudioWorkletNode is only available in a secure context/.test(e));

async function openPage(browser, path, { native = false, cached = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // Seed BEFORE any page script runs, and wipe any token so every run starts
  // signed out regardless of what a previous run left behind.
  await page.evaluateOnNewDocument((native, cached, CACHED) => {
    try {
      localStorage.removeItem('mw_drive_auth_v1');
      localStorage.removeItem('gdrivePlayerOffline');
      if (native) localStorage.setItem('bloopsNativeShell', '1');
      else localStorage.removeItem('bloopsNativeShell');
      if (cached) localStorage.setItem('gdrivePlayerLastPlaylist', JSON.stringify(CACHED));
      else localStorage.removeItem('gdrivePlayerLastPlaylist');
    } catch (e) {}
  }, native, cached, CACHED);
  await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 });
  return { page, errs };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required',
           `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
           // The hostname has to be NON-local for BLOOPS_LOCAL to be false, but
           // a non-local http origin is INSECURE, so AudioWorkletNode throws on
           // every voice — and bloops.html's boot guard answers the first
           // unhandled rejection with a one-shot `?fresh=` reload, which
           // detaches the frame mid-probe. Treat the origin as secure and the
           // audio core boots normally, as it does on https in the real world.
           `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${PORT}`,
           `--user-data-dir=${process.env.TMPDIR || '/tmp'}/bloops-probe-signin-gate`],
    protocolTimeout: 240000,
  });

  // ---- 1. BLOOPS on the deployed web, signed out: the gate stands ---------
  console.log('\nbloops · web · signed out');
  {
    const { page } = await openPage(browser, '/bloops.html');
    await zz(2500);
    const flags = await page.evaluate(() => ({
      local: !!window.BLOOPS_LOCAL, native: !!window.BLOOPS_NATIVE,
      noGate: !!window.BLOOPS_NO_GATE, required: document.body.classList.contains('signin-required'),
    }));
    ok('hostname reads as deployed (BLOOPS_LOCAL false)', flags.local === false, JSON.stringify(flags));
    ok('BLOOPS_NATIVE false', flags.native === false, JSON.stringify(flags));
    ok('body.signin-required is set', flags.required === true, JSON.stringify(flags));
    const gate = await vis(page, '#signin-gate');
    ok('the full-screen gate is on screen', gate.found && gate.on && gate.h > 400, JSON.stringify(gate));
    const grid = await vis(page, '#grid');
    ok('the instrument behind it is hidden', !grid.on, JSON.stringify(grid));
    await page.close();
  }

  // ---- 2. BLOOPS in the native shell, signed out: straight into the app ---
  console.log('\nbloops · native · signed out');
  {
    const { page, errs } = await openPage(browser, '/bloops.html', { native: true });
    await zz(3000);
    const flags = await page.evaluate(() => ({
      local: !!window.BLOOPS_LOCAL, native: !!window.BLOOPS_NATIVE,
      noGate: !!window.BLOOPS_NO_GATE, required: document.body.classList.contains('signin-required'),
      noGoogle: document.body.classList.contains('no-google'),
    }));
    ok('BLOOPS_NATIVE true via the override', flags.native === true, JSON.stringify(flags));
    ok('body.signin-required is NOT set', flags.required === false, JSON.stringify(flags));
    ok('body.no-google still dims the Drive controls', flags.noGoogle === true, JSON.stringify(flags));
    const gate = await vis(page, '#signin-gate');
    ok('the gate is not on screen', !gate.on, JSON.stringify(gate));
    const grid = await vis(page, '#grid');
    ok('the instrument IS on screen', grid.found && grid.on && grid.h > 50, JSON.stringify(grid));
    // The door, measured in the view the user actually has open.
    const btn = await vis(page, '#signin-toggle-btn');
    ok('Sign in button is reachable', btn.found && btn.on, JSON.stringify(btn));
    ok('…and reads "Sign in"', /sign in/i.test(btn.text || ''), JSON.stringify(btn));
    // Drive-only controls stay off: the gate went, the gating did not.
    const dimmed = await page.evaluate(() => {
      const el = document.getElementById('project-save-opt');
      return el ? getComputedStyle(el).pointerEvents : 'missing';
    });
    ok('Save project is still pointer-dead while signed out', dimmed === 'none', dimmed);
    ok('no page errors', realErrors(errs).length === 0, realErrors(errs).join(' | '));
    await page.close();
  }

  // ---- 3. PLAYER on the deployed web, signed out: unchanged --------------
  console.log('\nplayer · web · signed out (must be unchanged)');
  {
    const { page } = await openPage(browser, '/player.html', { cached: true });
    await zz(2500);
    const main = await vis(page, '#main-content');
    ok('main content stays hidden', !main.on, JSON.stringify(main));
    const auth = await vis(page, '#authorize-btn');
    ok('the Connect header is what you get', auth.found && auth.on, JSON.stringify(auth));
    const rows = await page.evaluate(() => document.querySelectorAll('.playlist-item').length);
    ok('no cached playlist is rendered', rows === 0, 'rows=' + rows);
    await page.close();
  }

  // ---- 4. PLAYER in the native shell, signed out: opens ready to play ----
  console.log('\nplayer · native · signed out, one cached playlist');
  {
    const { page, errs } = await openPage(browser, '/player.html', { native: true, cached: true });
    await zz(2500);
    const main = await vis(page, '#main-content');
    ok('main content is on screen', main.found && main.on, JSON.stringify(main));
    const auth = await vis(page, '#authorize-btn');
    ok('the Sign in door is still offered', auth.found && auth.on, JSON.stringify(auth));
    const heading = await page.evaluate(() => document.getElementById('playlist-heading-name')?.textContent);
    ok('the cached playlist name is shown', heading === CACHED.name, String(heading));
    const rows = await page.evaluate(() => document.querySelectorAll('.playlist-item').length);
    ok('both cached tracks are listed', rows === CACHED.tracks.length, 'rows=' + rows);
    const first = await vis(page, '.playlist-item');
    ok('a track row is actually on screen', first.found && first.on && first.h > 10, JSON.stringify(first));
    const title = await page.evaluate(() => document.getElementById('current-track-title')?.textContent);
    ok('the first track is loaded and named', title === 'First Cached Song.mp3', String(title));
    const st = await page.evaluate(() => ({
      paused: document.getElementById('audio-player')?.paused,
      playDisabled: document.getElementById('sb-play-pause-btn')?.disabled,
      search: getComputedStyle(document.querySelector('.search-section')).display,
      signout: getComputedStyle(document.getElementById('signout-btn')).display,
    }));
    ok('READY to play, not playing', st.paused === true, JSON.stringify(st));
    ok('play button is live', st.playDisabled === false, JSON.stringify(st));
    ok('folder picker is hidden (nothing to pick signed out)', st.search === 'none', JSON.stringify(st));
    ok('Sign out is hidden', st.signout === 'none', JSON.stringify(st));
    // "Make available offline" needs Drive — it must not offer to save bytes
    // it cannot fetch.
    const off = await page.evaluate(() => {
      const b = document.getElementById('offline-btn');
      return b ? { disabled: b.disabled, title: b.title } : null;
    });
    ok('offline save is disabled and says why', off && off.disabled === true && /sign in/i.test(off.title), JSON.stringify(off));
    // Press play for real: the track has no bytes here and there is no token,
    // so it must EXPLAIN itself rather than silently not start.
    await page.tap('#sb-play-pause-btn');
    await zz(900);
    const toast = await page.evaluate(() => {
      const t = [...document.querySelectorAll('.toast')].map((e) => e.textContent.trim());
      return { toasts: t, paused: document.getElementById('audio-player')?.paused };
    });
    ok('pressing play on an unsaved track asks for sign-in',
       toast.toasts.some((t) => /sign in to play this track/i.test(t)), JSON.stringify(toast));
    ok('…and nothing started', toast.paused === true, JSON.stringify(toast));
    ok('no page errors', realErrors(errs).length === 0, realErrors(errs).join(' | '));
    await page.close();
  }

  console.log('\nprobe: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
