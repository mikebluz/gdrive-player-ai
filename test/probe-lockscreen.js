// PROBE — the Player drives the phone's lock screen / Control Centre.
//
// user: "Properly wire Player up to phone lock screen controls" — the Now
// Playing card read "Player — Mike Luz" (the PAGE TITLE) over blank artwork,
// with ←10s / 10s→ buttons instead of ⏮ / ⏭.
//
// All three were one absence: nothing in the Player ever touched
// `navigator.mediaSession`, so iOS fell back to `document.title`, had no
// artwork to show, and — with no `previoustrack`/`nexttrack` handler — offered
// seek buttons, because seeking is all an unaided <audio> element can promise.
//
// iOS decides WHICH TRANSPORT BUTTONS TO DRAW from which actions are
// registered, so the handler list is not plumbing behind the UI, it IS the UI.
// That is what this checks, along with the metadata matching the card, the
// artwork being a data: URL (iOS does not reliably fetch a blob: one for Now
// Playing, and fails silently — the blank square that was reported), the state
// following the element's own events, and the position bar getting numbers.
//
//   node test/probe-lockscreen.js        (needs `npm start`; BLOOPS_URL to retarget)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PLAYER_URL ||
  (process.env.BLOOPS_URL || 'http://localhost:3001/bloops.html').replace(/[^/]*$/, 'player.html');
const zz = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'], protocolTimeout: 300000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // the app boots without sign-in and publishes the player before any auth
  await page.waitForFunction(() => !!window.musicPlayer, { timeout: 30000 });
  await zz(400);

  // ── THE SPY. The handlers are registered in the constructor, which ran
  // before this — so the real `mediaSessionInit` is called AGAIN through the
  // spy rather than a copy of it being asserted about.
  await page.evaluate(() => {
    const ms = navigator.mediaSession;
    window.__ms = { actions: [], pos: null, posN: 0 };
    const realSet = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (name, fn) => {
      window.__ms.actions = window.__ms.actions.filter((a) => a !== name);
      if (fn) window.__ms.actions.push(name);
      (window.__msFns = window.__msFns || {})[name] = fn;
      return realSet(name, fn);
    };
    if (ms.setPositionState) {
      const realPos = ms.setPositionState.bind(ms);
      ms.setPositionState = (st) => { window.__ms.pos = st; window.__ms.posN++; return realPos(st); };
    }
    window.musicPlayer.mediaSessionInit();
  });

  const acts = await page.evaluate(() => window.__ms.actions.slice());
  console.log('\n  registered actions: ' + JSON.stringify(acts) + '\n');
  ok('the transport actions are registered',
    ['play', 'pause', 'previoustrack', 'nexttrack'].every((a) => acts.indexOf(a) >= 0),
    JSON.stringify(acts));
  // THE WHOLE REASON THE BUTTONS WERE ±10s. iOS draws seek buttons when these
  // are registered and prev/next when they are not; registering both gets the
  // seek pair back, so their ABSENCE is a contract.
  ok('…and the ±10s seek pair is deliberately NOT, so ⏮/⏭ take its place',
    acts.indexOf('seekbackward') < 0 && acts.indexOf('seekforward') < 0,
    JSON.stringify(acts));
  ok('…while the scrubber is, so the bar can be dragged', acts.indexOf('seekto') >= 0,
    JSON.stringify(acts));

  // ── WHAT THE CARD SAYS vs WHAT THE PAGE SAYS ────────────────────────────
  const meta = await page.evaluate(() => {
    const h = document.getElementById('playlist-heading-name');
    if (h) h.textContent = 'Night Drive';
    window.musicPlayer.defaultArtist = 'Test Artist';
    window.musicPlayer.loadTrack({ id: 'probe-1', name: 'Second Sun' });
    const m = navigator.mediaSession.metadata;
    return {
      title: m && m.title, artist: m && m.artist, album: m && m.album,
      cardTitle: (document.getElementById('current-track-title') || {}).textContent,
      cardArtist: (document.getElementById('current-track-artist') || {}).textContent,
      docTitle: document.title,
    };
  });
  console.log('  metadata: ' + JSON.stringify({ t: meta.title, a: meta.artist, al: meta.album }));
  console.log('  the card: ' + JSON.stringify({ t: meta.cardTitle, a: meta.cardArtist }));
  console.log('  page title: ' + JSON.stringify(meta.docTitle) + '\n');

  ok('the lock screen names the TRACK, not the page',
    meta.title === 'Second Sun' && meta.title !== meta.docTitle,
    JSON.stringify({ metadata: meta.title, docTitle: meta.docTitle }));
  ok('…and it is the very string the card shows',
    meta.title === meta.cardTitle && meta.artist === meta.cardArtist,
    JSON.stringify(meta));
  ok('…with the playlist as the album', meta.album === 'Night Drive', JSON.stringify(meta.album));

  // ── ARTWORK — a data: URL, downscaled ───────────────────────────────────
  // Fed a data: URL here so the check needs no network; the code path from a
  // blob: URL is the same <img> decode.
  const art = await page.evaluate(async () => {
    // a 2x2 red PNG, so the re-encode has something real to draw
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z4AATAxQMLwYAAAA//8DAAKZAQm5xJsAAAAAAElFTkSuQmCC';
    window.musicPlayer.setArtwork(src);
    for (let i = 0; i < 60; i++) {
      const m = navigator.mediaSession.metadata;
      const a = m && m.artwork && m.artwork[0];
      if (a && a.src) return { src: String(a.src).slice(0, 24), sizes: a.sizes, type: a.type,
                               len: String(a.src).length };
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  });
  console.log('  artwork: ' + JSON.stringify(art) + '\n');
  ok('the sleeve reaches the lock screen', !!art, 'no artwork on the metadata');
  // A blob: URL is what the page's <img> uses and is NOT reliably fetched by
  // iOS for Now Playing — and it fails silently, which is the blank square.
  ok('…as a data: URL rather than the blob: one the page shows',
    !!art && /^data:image\/jpeg/.test(art.src), JSON.stringify(art && art.src));
  ok('…redrawn to a 512 square, not shipped at full size',
    !!art && art.sizes === '512x512', JSON.stringify(art && art.sizes));

  // ── THE BUTTONS ACTUALLY DO SOMETHING ───────────────────────────────────
  // A registered handler that no-ops is worse than none: the button is drawn
  // and the press is swallowed.
  const wired = await page.evaluate(async () => {
    const seen = [];
    const on = (n) => document.addEventListener(n, () => seen.push(n));
    on('requestNextTrack'); on('requestPreviousTrack');
    window.__msFns.nexttrack();
    window.__msFns.previoustrack();
    await new Promise((r) => setTimeout(r, 60));
    return seen;
  });
  ok('⏭ and ⏮ reach the playlist',
    wired.indexOf('requestNextTrack') >= 0 && wired.indexOf('requestPreviousTrack') >= 0,
    JSON.stringify(wired));

  // ── STATE AND POSITION follow the element's own events ──────────────────
  const play = await page.evaluate(async () => {
    // three seconds of 8-bit silence, so `duration` is real — the silent WAV
    // the player ships for gesture-unlocking has an EMPTY data chunk and a
    // duration of 0, which `setPositionState` would (rightly) refuse
    const rate = 8000, secs = 3, n = rate * secs;
    const buf = new ArrayBuffer(44 + n), dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    str(36, 'data'); dv.setUint32(40, n, true);
    const bytes = new Uint8Array(buf); for (let i = 0; i < n; i++) bytes[44 + i] = 128;
    let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const a = document.getElementById('audio-player');
    a.loop = true;
    a.src = 'data:audio/wav;base64,' + btoa(bin);
    window.__ms.posN = 0;
    try { await a.play(); } catch (e) { return { err: String(e && e.message) }; }
    // A LONG ENOUGH WINDOW TO TELL THE TWO APART: over ~3s a once-a-second
    // report is ~5 (two fixed, at `play` and at `loadedmetadata`, plus three
    // ticks) where one per `timeupdate` is ~14. At 1.4s the two overlapped.
    await new Promise((r) => setTimeout(r, 3100));
    const playing = navigator.mediaSession.playbackState;
    const pos = window.__ms.pos && { d: Math.round(window.__ms.pos.duration * 100) / 100,
                                     p: Math.round(window.__ms.pos.position * 100) / 100,
                                     r: window.__ms.pos.playbackRate };
    a.pause();
    await new Promise((r) => setTimeout(r, 250));
    return { playing, paused: navigator.mediaSession.playbackState, pos, posN: window.__ms.posN,
             dur: Math.round(a.duration * 100) / 100 };
  });
  console.log('  playbackState: playing→' + play.playing + ', paused→' + play.paused);
  console.log('  position reports: ' + play.posN + ', last ' + JSON.stringify(play.pos) +
              ' (element duration ' + play.dur + ')\n');

  ok('playing the element says so on the lock screen', play.playing === 'playing',
    JSON.stringify(play));
  ok('…and pausing it says that', play.paused === 'paused', JSON.stringify(play));
  ok('the position bar gets a real duration and a position inside it',
    !!play.pos && play.pos.d > 2.5 && play.pos.p >= 0 && play.pos.p <= play.pos.d,
    JSON.stringify(play.pos));
  // ONCE A SECOND, not per `timeupdate` (~4/s) — the phone interpolates.
  ok('…reported about once a second, not on every tick',
    play.posN >= 3 && play.posN <= 8, play.posN + ' reports in ~3.1s');

  // …and the scrubber moves the audio.
  const sought = await page.evaluate(async () => {
    const a = document.getElementById('audio-player');
    window.__msFns.seekto({ seekTime: 2 });
    await new Promise((r) => setTimeout(r, 120));
    return Math.round(a.currentTime * 10) / 10;
  });
  ok('…and dragging it moves the track', Math.abs(sought - 2) < 0.4, 'currentTime ' + sought);

  // ── ONE CARD, ONE OWNER ────────────────────────────────────
  // `bloops.html` loads this file AND Bloom's native audio, which drives the
  // same Now Playing card for the generative mix. Two writers on one card, and
  // without a rule the last one to speak wins whether or not it is the thing
  // making the sound — a Drive track's name over a generative piece.
  const owner = await page.evaluate(async () => {
    const p2 = window.musicPlayer;
    const before = navigator.mediaSession.metadata && navigator.mediaSession.metadata.title;
    // somebody else takes the card, exactly as Bloom does when its mix arms
    window.__mediaSessionOwner = 'bloops';
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Bloops', artist: 'generative music' });
    p2.loadTrack({ id: 'probe-2', name: 'Should Not Appear' });
    p2.mediaSessionState('playing');
    const held = navigator.mediaSession.metadata && navigator.mediaSession.metadata.title;
    // …and the Player takes it back when it is the one sounding
    p2.mediaSessionClaim();
    p2.mediaSessionMeta();
    const back = navigator.mediaSession.metadata && navigator.mediaSession.metadata.title;
    return { before, held, back, owner: window.__mediaSessionOwner };
  });
  console.log('\n  card title — player: ' + JSON.stringify(owner.before) +
              ', while Bloom holds it: ' + JSON.stringify(owner.held) +
              ', after the Player claims: ' + JSON.stringify(owner.back) + '\n');
  ok('the Player leaves the card alone while something else owns it',
    owner.held === 'Bloops', JSON.stringify(owner));
  ok('…and takes it back when it is the one sounding',
    owner.back === 'Should Not Appear' && owner.owner === 'player', JSON.stringify(owner));

  if (errs.length) console.log('\npage errors:\n  ' + errs.slice(0, 8).join('\n  '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
