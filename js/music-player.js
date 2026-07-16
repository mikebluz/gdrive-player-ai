// Minimal silent WAV — used to activate the iOS audio element synchronously
// within a user gesture before an async fetch breaks the gesture chain.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

class MusicPlayer {
    // Bump on every deploy so the "diag ready · build …" line proves whether
    // the browser loaded the fresh script or a cached old one.
    static BUILD = '20260708e';

    constructor(gDrive, blobCache = null) {
        this.gDrive = gDrive;
        this.blobCache = blobCache;
        this.audio = document.getElementById('audio-player');
        this.currentTrack = null;
        this.isPlaying = false;
        this.volume = 0.7;
        this._prefetchCache = new Map(); // trackId -> Blob
        this._blob = null;    // raw Blob for the currently loaded track
        this._blobUrl = null; // object URL for _blob, set as audio.src
        this._blobTrackId = null; // id of the track _blobUrl belongs to — asserted
                                  // against currentTrack before play so a stale blob
                                  // can never sound under the wrong title ("right
                                  // title, wrong audio").
        // Monotonic load generation — bumped on every loadTrack(). play() captures
        // it at entry and bails before assigning audio.src if it has moved, so a
        // slow fetch for a track you've since skipped past can't clobber the
        // current track's audio (the "wrong song plays" race).
        this._loadSeq = 0;

        this.initializeElements();
        this.bindEvents();
        this.setVolume(this.volume);

        // Boot confirmation for the on-screen diagnostics. ?diag=1 also STICKS
        // (persisted to localStorage) so it survives navigation; ?diag=0 clears
        // it. If you added ?diag=1 and see this "diag ready" line, the new
        // music-player.js is live and diag is on. If you see NOTHING at all,
        // the page is running a CACHED old script — hard-refresh the page.
        try {
            if (/[?&]diag=1\b/.test(location.search)) localStorage.setItem('sbDiag', '1');
            if (/[?&]diag=0\b/.test(location.search)) localStorage.removeItem('sbDiag');
        } catch (e) {}
        if (this._diagOn()) this._diag('diag ready · build ' + MusicPlayer.BUILD + ' · tap to clear');
    }

    initializeElements() {
        // sb- prefix avoids ID collision with Bloops's own play / step
        // buttons inside the unified page (Player view).
        this.playPauseBtn = document.getElementById('sb-play-pause-btn');
        this.prevBtn      = document.getElementById('sb-prev-btn');
        this.nextBtn      = document.getElementById('sb-next-btn');

        this.progressSlider = document.getElementById('progress-slider');
        this.progressFill = document.getElementById('progress-fill');
        this.currentTimeEl = document.getElementById('current-time');
        this.totalTimeEl = document.getElementById('total-time');
        this.volumeSlider = document.getElementById('volume-slider');

        this.trackTitle = document.getElementById('current-track-title');
        this.trackArtist = document.getElementById('current-track-artist');
    }

    bindEvents() {
        // Control buttons
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.prevBtn.addEventListener('click', () => this.previousTrack());
        this.nextBtn.addEventListener('click', () => this.nextTrack());

        // Progress control
        this.progressSlider.addEventListener('input', (e) => this.seek(e.target.value));

        // Volume control
        this.volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value / 100));

        // Audio element events
        this.audio.addEventListener('loadedmetadata', () => this.onLoadedMetadata());
        this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.audio.addEventListener('ended', () => this.onTrackEnded());
        this.audio.addEventListener('play', () => this.onPlay());
        this.audio.addEventListener('pause', () => this.onPause());
        this.audio.addEventListener('error', (e) => console.warn('Audio element error:', this.audio.error?.code, this.audio.error?.message));

        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyboardControls(e));
    }

    loadTrack(track) {
        if (!track) return;

        // New load generation — invalidates any in-flight play() for a prior track.
        this._loadSeq++;

        this.audio.pause();

        // Clear src before revoking; _blobUrl being null suppresses spurious error events
        this.audio.src = '';
        if (this._blobUrl) {
            URL.revokeObjectURL(this._blobUrl);
            this._blobUrl = null;
        }
        this._blob = null;
        this._blobTrackId = null;

        this.currentTrack = track;
        this.isPlaying = false;
        this._hasPlayed = false;

        this.trackTitle.textContent = track.name || 'Unknown Track';
        this.trackArtist.textContent = this.defaultArtist || this.extractArtistFromName(track.name) || 'Unknown Artist';

        this.resetProgress();
        this.enableControls();

        document.dispatchEvent(new CustomEvent('trackLoaded', { detail: { track } }));
    }

    extractArtistFromName(trackName) {
        if (!trackName) return null;
        if (trackName.includes(' - ')) {
            return trackName.split(' - ')[0].trim();
        }
        return null;
    }

    async prefetchTrack(track) {
        if (!track || this._prefetchCache.has(track.id)) return 'skipped';
        try {
            // Load from persistent blob cache if available — avoids network round-trip
            if (this.blobCache) {
                const blob = await this.blobCache.getBlob(track.id);
                if (blob) {
                    if (!this._verifyBlob(track, blob, 'idb')) {
                        this.blobCache.remove(track.id);   // poisoned entry — self-heal
                    } else {
                    this._prefetchCache.set(track.id, blob);
                    this._diag('prefetch(cache) ' + this._short(track.id) + ' ' + Math.round(blob.size / 1024) + 'KB');
                    document.dispatchEvent(new CustomEvent('prefetchCacheUpdated'));
                    this._probeBlobDuration(blob, track.id);
                    return 'cached';
                    }
                }
            }

            const token = this.gDrive.accessToken;
            if (!token) return 'skipped';
            let response = await fetch(this._driveMediaUrl(track.id), { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
            if (!response.ok) return 'failed';
            let blob = await response.blob();
            if (!this._verifyBlob(track, blob, 'prefetch')) {
                // one retry with a fresh nonce — a cross-track CDN response
                response = await fetch(this._driveMediaUrl(track.id), { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
                if (!response.ok) return 'failed';
                blob = await response.blob();
                if (!this._verifyBlob(track, blob, 'prefetch-retry')) return 'failed';
            }
            this._prefetchCache.set(track.id, blob);
            this._diag('prefetch(fetch) ' + this._short(track.id) + ' ' + Math.round(blob.size / 1024) + 'KB');
            // (No incidental persistence: only "Make available offline" writes
            // the persistent store, so it holds exactly the saved playlist.)
            document.dispatchEvent(new CustomEvent('prefetchCacheUpdated'));
            this._probeBlobDuration(blob, track.id);
            return 'fetched';
        } catch (e) {
            // prefetch failure is non-fatal
            return 'failed';
        }
    }

    // Decode just the metadata of an in-memory blob to learn its
    // duration, then dispatch trackDurationKnown so the playlist can
    // fold it into the running-time total. Costs no extra network —
    // the blob is already local. Disposed as soon as duration arrives.
    _probeBlobDuration(blob, trackId) {
        try {
            const url = URL.createObjectURL(blob);
            const probe = new Audio();
            probe.preload = 'metadata';
            const done = () => { try { URL.revokeObjectURL(url); } catch {} };
            probe.addEventListener('loadedmetadata', () => {
                const dur = probe.duration;
                done();
                if (isFinite(dur) && dur > 0) {
                    document.dispatchEvent(new CustomEvent('trackDurationKnown', {
                        detail: { trackId, durationMs: Math.round(dur * 1000) }
                    }));
                }
            }, { once: true });
            probe.addEventListener('error', done, { once: true });
            probe.src = url;
        } catch {}
    }

    // Persist a track's blob to blobCache for offline playback.
    // Uses the in-memory blob directly — no fetch() needed.
    async persistTrack(track) {
        if (!track || !this.blobCache) return;
        if (await this.blobCache.has(track.id)) return;

        let blob = null;
        // Only reuse the in-memory _blob when it PROVABLY belongs to this track
        // (_blobTrackId, not just currentTrack.id) — otherwise a stale _blob would
        // get stored under track.id and poison the cache: right title, wrong audio.
        if (this._blobTrackId === track.id && this._blob) {
            blob = this._blob;
        } else if (this._prefetchCache.has(track.id)) {
            blob = this._prefetchCache.get(track.id);
        }

        try {
            if (blob) {
                await this.blobCache.store(track.id, blob);
            } else {
                // Not in memory — fetch from Drive
                const token = this.gDrive.accessToken;
                if (!token) return;
                const url = this._driveMediaUrl(track.id);
                const response = await fetch(url, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
                if (!response.ok) return;
                const fetched = await response.blob();
                if (!this._verifyBlob(track, fetched, 'persist')) return;   // never store unverified bytes
                await this.blobCache.store(track.id, fetched);
            }
        } catch {}
    }

    clearPrefetchCache() {
        this._prefetchCache.clear(); // blobs are GC'd automatically, no URLs to revoke
    }

    // Wipe ALL cached audio — the in-memory prefetch cache AND the persistent
    // IndexedDB blob cache. Use to recover from a poisoned cache ("right title,
    // wrong audio"). The currently-loaded track keeps playing (its blob is held
    // on the audio element); everything else re-downloads on next play.
    async clearCaches() {
        this.clearPrefetchCache();
        if (this.blobCache) { try { await this.blobCache.clear(); } catch (e) {} }
    }

    // Drive media URL with a unique cache-buster. `cache:'no-store'` alone doesn't
    // reliably stop iOS Safari / the Drive CDN from serving a stale or cross-track
    // response (the real "right title, wrong audio" cause once the app caches are
    // empty) — a unique query param guarantees each request is a fresh download.
    // Drive ignores the extra param. The app's own blob caches still handle reuse.
    _driveMediaUrl(trackId) {
        const nonce = Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
        return `https://www.googleapis.com/drive/v3/files/${trackId}?alt=media&_cb=${nonce}`;
    }

    // BYTE-SIZE VERIFICATION — the last line of defense against "right title,
    // wrong audio". Drive's listing gives every file's exact byte size; if a
    // blob (from the CDN, the prefetch cache, or IndexedDB) doesn't match the
    // track's size, it is NOT this track's audio — reject it instead of
    // playing/caching it. Tracks without a known size pass (can't verify).
    // Same-size collisions remain theoretically possible; everything else is
    // caught, and rejected cache entries self-heal (removed + refetched).
    _verifyBlob(track, blob, where) {
        if (!track || !blob) return false;
        const want = Number(track.size);
        if (!Number.isFinite(want) || want <= 0) return true;   // no size known → can't verify
        if (blob.size === want) return true;
        this._diag('✗ ' + where + ' blob size ' + blob.size + ' ≠ ' + want + ' for ' + this._short(track.id) + ' — rejected', true);
        try { console.warn('[player] rejected wrong-size blob (' + where + ') for', track.name, blob.size, '≠', want); } catch {}
        return false;
    }

    // ---- On-screen diagnostics (mobile has no console) -------------------
    // Enable by adding ?diag=1 to the URL (or localStorage.sbDiag='1'). Surfaces,
    // per play: the DISPLAYED track (name/id) vs the id the blob actually came
    // from, the blob source + size, and expected-vs-actual duration — so a repro
    // shows exactly where title and audio diverge.
    _diagOn() {
        try { return /[?&]diag=1\b/.test(location.search) || localStorage.getItem('sbDiag') === '1'; } catch { return false; }
    }
    _diag(msg, warn) {
        if (!this._diagOn()) return;
        let el = document.getElementById('sb-diag');
        if (!el) {
            el = document.createElement('div');
            el.id = 'sb-diag';
            el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:42vh;overflow:auto;' +
                'background:rgba(0,0,0,0.9);color:#7fd6c4;font:11px/1.45 ui-monospace,Menlo,monospace;' +
                'padding:6px 8px;white-space:pre-wrap;border-top:1px solid #4fd1c5;';
            el.addEventListener('click', () => { el.textContent = ''; });   // tap to clear
            document.body.appendChild(el);
        }
        const t = (new Date()).toTimeString().slice(0, 8);
        const line = t + '  ' + (warn ? '⚠ ' : '') + msg;
        el.textContent = (line + '\n' + el.textContent).slice(0, 3000);
    }
    _short(id) { return id ? ('…' + String(id).slice(-6)) : '∅'; }

    // Ask Drive for the REAL filename of an id and compare it to the title we're
    // showing. If the diag says "right song" but the wrong song sounds, the most
    // likely remaining cause is a scrambled playlist mapping — the displayed name
    // paired with a DIFFERENT file's id. This is the authoritative check: same id,
    // one file. Async + non-blocking; prints when Drive answers.
    async _diagVerifyFile(id, shownName, heldBlob) {
        if (!this._diagOn() || !id) return;
        try {
            const token = this.gDrive && this.gDrive.accessToken;
            if (!token) { this._diag('verify: no token', true); return; }
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,size&_cb=${Date.now().toString(36)}`,
                { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
            if (!r.ok) { this._diag('verify HTTP ' + r.status + ' for ' + this._short(id), true); return; }
            const meta = await r.json();
            const real = (meta.name || '').slice(0, 28);
            const shown = (shownName || '').slice(0, 28);
            const norm = s => s.replace(/\.[a-z0-9]+$/i, '').trim().toLowerCase();
            const mism = norm(real) !== norm(shown);
            this._diag('VERIFY id=' + this._short(id) + ' drive="' + real + '" shown="' + shown + '"' +
                (mism ? '  ← ID POINTS TO WRONG FILE' : '  ✓ id matches title'), mism);
            // Content check: does the number of bytes we HOLD match the file's real
            // size on Drive? A mismatch means the blob under this (correct) id carries
            // the WRONG file's bytes — bad content, not a bad pointer.
            if (heldBlob && meta.size) {
                const driveKB = Math.round(Number(meta.size) / 1024);
                const heldKB = Math.round(heldBlob.size / 1024);
                const sizeBad = Math.abs(driveKB - heldKB) > 2;
                this._diag('  bytes held=' + heldKB + 'KB drive=' + driveKB + 'KB' +
                    (sizeBad ? '  ← BLOB CONTENT IS THE WRONG FILE' : '  ✓ bytes match Drive'), sizeBad);
            }
        } catch (e) {
            this._diag('verify err: ' + (e && e.message || e), true);
        }
    }

    // Decode the EXACT bytes we're about to play (independent of the <audio>
    // element) and report their true duration. If this differs from the track's
    // expected length, the blob content itself is the wrong song — even though
    // every pointer (id/blob/src) is correct.
    _diagProbeBytes(blob, expSec) {
        if (!this._diagOn() || !blob) return;
        try {
            const url = URL.createObjectURL(blob);
            const a = new Audio();
            a.preload = 'metadata';
            a.addEventListener('loadedmetadata', () => {
                const d = Math.round(a.duration || 0);
                const bad = expSec > 0 && d > 0 && Math.abs(d - expSec) > 2;
                this._diag('  bytes decode to ' + d + 's (expected ' + expSec + 's)' +
                    (expSec > 0 ? (bad ? '  ← BYTES ARE WRONG SONG' : '  ✓ bytes are right song') : ''), bad);
                try { URL.revokeObjectURL(url); } catch {}
            }, { once: true });
            a.addEventListener('error', () => { try { URL.revokeObjectURL(url); } catch {} }, { once: true });
            a.src = url;
        } catch (e) {}
    }

    async _sha(blob) {
        const buf = await blob.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // THE definitive content check: hash the bytes we're about to play against a
    // FRESH fetch of the same id from Drive. Size and duration are unreliable
    // fingerprints (same-bitrate exports of equal length match by coincidence);
    // a hash is not. If they differ, the cache holds the WRONG song's bytes under
    // a correct id — poisoned cache, the real "wrong song plays" cause.
    async _diagContentCheck(id, heldBlob) {
        if (!this._diagOn() || !id || !heldBlob) return;
        try {
            const token = this.gDrive && this.gDrive.accessToken;
            if (!token) { this._diag('content: no token', true); return; }
            const r = await fetch(this._driveMediaUrl(id),
                { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
            if (!r.ok) { this._diag('content: drive HTTP ' + r.status, true); return; }
            const fresh = await r.blob();
            const [h1, h2] = await Promise.all([this._sha(heldBlob), this._sha(fresh)]);
            const same = h1 === h2;
            this._diag('  CONTENT held#' + h1.slice(0, 8) + ' drive#' + h2.slice(0, 8) +
                ' (' + Math.round(fresh.size / 1024) + 'KB)' +
                (same ? '  ✓ same bytes' : '  ← CACHE HAS WRONG BYTES (poisoned)'), !same);
        } catch (e) {
            this._diag('content err: ' + (e && e.message || e), true);
        }
    }

    isPrefetched(trackId) {
        return this._prefetchCache.has(trackId);
    }

    evictPrefetchExcept(keepIds) {
        for (const id of this._prefetchCache.keys()) {
            if (!keepIds.has(id)) this._prefetchCache.delete(id);
        }
    }

    async play() {
        if (!this.currentTrack) return;
        // Capture the load generation. If loadTrack() runs during any await below
        // (the user skipped to another track), this play() is stale: bail before
        // touching audio.src so the newer track's play() owns the audio element.
        const seq = this._loadSeq;
        const superseded = () => this._loadSeq !== seq;
        const wantId = this.currentTrack.id;
        let src = 'held';   // diagnostic: where the blob came from
        try {
            // Resolve a fresh blob when we have none OR the one we hold belongs to a
            // DIFFERENT track (the "right title, wrong audio" guard). A stale blob is
            // revoked before re-resolving.
            if (!this._blobUrl || this._blobTrackId !== wantId) {
                if (this._blobUrl) { try { URL.revokeObjectURL(this._blobUrl); } catch {} this._blobUrl = null; }
                let prefetchedBlob = this._prefetchCache.get(wantId);
                if (prefetchedBlob && !this._verifyBlob(this.currentTrack, prefetchedBlob, 'play/prefetch')) {
                    this._prefetchCache.delete(wantId);   // wrong bytes — drop and fall through to a fresh source
                    prefetchedBlob = null;
                }

                if (prefetchedBlob) {
                    // 1. In-memory prefetch — fully synchronous, preserves iOS gesture chain
                    src = 'prefetch';
                    this._blob = prefetchedBlob;
                    this._prefetchCache.delete(wantId);
                    this._blobUrl = URL.createObjectURL(this._blob);
                    this._blobTrackId = wantId;
                    this.audio.src = this._blobUrl;

                } else {
                    // All other paths require at least one await. Unlock iOS audio NOW,
                    // synchronously while the gesture chain is still intact, before any
                    // await breaks it (blobCache.getBlob, fetch, refreshToken, etc.).
                    new Audio(SILENT_WAV).play().catch(() => {});

                    let persistedBlob = this.blobCache
                        ? await this.blobCache.getBlob(this.currentTrack.id)
                        : null;
                    if (superseded()) return;   // skipped to another track during the lookup
                    if (persistedBlob && !this._verifyBlob(this.currentTrack, persistedBlob, 'play/idb')) {
                        try { this.blobCache.remove(wantId); } catch {}   // poisoned entry — self-heal
                        persistedBlob = null;                             // fall through to a fresh fetch
                    }

                    if (persistedBlob) {
                        // 2. Persistent blob cache — user-saved tracks, works offline
                        src = 'persisted';
                        this._blob = persistedBlob;
                        this._blobUrl = URL.createObjectURL(this._blob);
                        this._blobTrackId = wantId;
                        this.audio.src = this._blobUrl;

                    } else if (!this.gDrive.accessToken) {
                        // 3. No cached blob and no token — can't play offline
                        this.playPauseBtn.textContent = '▶️';
                        return;

                    } else {
                        // 4. Fetch from Drive
                        this.playPauseBtn.textContent = '⏳';
                        this.playPauseBtn.disabled = true;

                        const url = this._driveMediaUrl(wantId);
                        let response = await fetch(url, {
                            cache: 'no-store',
                            headers: { Authorization: `Bearer ${this.gDrive.accessToken}` }
                        });
                        if (superseded()) { this.playPauseBtn.disabled = false; return; }

                        if (response.status === 401) {
                            await this.gDrive.refreshTokenSilently();
                            response = await fetch(url, {
                                cache: 'no-store',
                                headers: { Authorization: `Bearer ${this.gDrive.accessToken}` }
                            });
                            if (superseded()) { this.playPauseBtn.disabled = false; return; }
                        }

                        if (!response.ok) {
                            throw new Error(`Drive fetch failed: ${response.status} ${response.statusText}`);
                        }

                        src = 'fetch';
                        this._blob = await response.blob();
                        // Byte-size verification: a cross-track CDN response must
                        // never reach the audio element OR the caches. One retry
                        // with a fresh nonce, then give up (⏳ resets; next press
                        // retries) rather than play the wrong song.
                        if (!this._verifyBlob(this.currentTrack, this._blob, 'play/fetch')) {
                            const r2 = await fetch(this._driveMediaUrl(wantId), { cache: 'no-store', headers: { Authorization: `Bearer ${this.gDrive.accessToken}` } });
                            if (superseded()) { this.playPauseBtn.disabled = false; return; }
                            this._blob = r2.ok ? await r2.blob() : null;
                            if (!this._blob || !this._verifyBlob(this.currentTrack, this._blob, 'play/fetch-retry')) {
                                this._blob = null;
                                this.playPauseBtn.textContent = '▶️';
                                this.playPauseBtn.disabled = false;
                                return;
                            }
                        }
                        // Last and most important guard: the blob just finished
                        // downloading — if we've skipped past this track, drop it
                        // rather than assigning it over the current track's audio.
                        if (superseded()) { this.playPauseBtn.disabled = false; return; }
                        this._blobUrl = URL.createObjectURL(this._blob);
                        this._blobTrackId = wantId;
                        this.audio.src = this._blobUrl;
                        this.playPauseBtn.disabled = false;
                    }
                }
            }

            if (superseded()) return;
            // Final invariant: the audio element must be holding THIS track's blob.
            // If anything left a mismatched src (the reported "right title, wrong
            // audio"), don't play it — log and bail so the correct track's play()
            // (or a retry) owns the element instead of sounding the wrong song.
            if (this._blobTrackId !== this.currentTrack.id) {
                console.warn('MusicPlayer: blob/track mismatch — refusing to play wrong audio', { blobTrackId: this._blobTrackId, currentTrackId: this.currentTrack.id });
                this._diag('BLOCKED mismatch: want ' + this._short(this.currentTrack.id) + ' but blob ' + this._short(this._blobTrackId), true);
                return;
            }
            const _n = (this.currentTrack.name || '').slice(0, 22);
            const _kb = this._blob ? Math.round(this._blob.size / 1024) + 'KB' : '?';
            const _exp = Math.round((this.currentTrack.durationMs || 0) / 1000);
            this._diagWant = { id: wantId, name: _n, exp: _exp };   // for the loadedmetadata check
            this._diag('PLAY "' + _n + '" id=' + this._short(wantId) + ' blob=' + this._short(this._blobTrackId) + ' via=' + src + ' ' + _kb + ' exp=' + _exp + 's');
            // Does the element actually hold OUR blob URL? (catches a src that
            // never took / got reverted) and count any OTHER media still sounding.
            if (this._diagOn()) {
                const heldOurs = this.audio.src && this._blobUrl && this.audio.src === this._blobUrl;
                let others = 0;
                document.querySelectorAll('audio,video').forEach(m => { if (m !== this.audio && !m.paused && !m.ended && m.currentTime > 0) others++; });
                this._diag('  src.attr ' + (heldOurs ? 'ours ✓' : '≠ ours ⚠') + (others ? '  · ' + others + ' OTHER media playing ⚠' : ''), !heldOurs || others > 0);
                // Authoritative: is this id really the file the title claims, and do
                // the bytes we hold match that file's real size on Drive?
                this._diagVerifyFile(wantId, this.currentTrack.name, this._blob);
                // And what do the exact bytes decode to? (content, not pointer)
                this._diagProbeBytes(this._blob, _exp);
                // Definitive: hash held bytes vs a fresh Drive fetch (size/duration
                // are fooled by same-bitrate same-length songs; a hash is not).
                this._diagContentCheck(wantId, this._blob);
            }
            await this.audio.play();
        } catch (error) {
            console.error('Error playing audio:', error);
            this.playPauseBtn.disabled = false;
            this.playPauseBtn.textContent = '▶️';
            if (error.name === 'AbortError' || error.name === 'NotAllowedError') return;
            this.onError(error);
        }
    }

    pause() {
        this.audio.pause();
    }

    stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.isPlaying = false;
        this.playPauseBtn.textContent = '▶️';
        this.resetProgress();
    }

    async togglePlayPause() {
        if (!this.currentTrack) return;
        if (this.isPlaying) {
            this.pause();
        } else {
            await this.play();
        }
    }

    seek(percentage) {
        if (!this.audio.duration) return;
        this.audio.currentTime = (percentage / 100) * this.audio.duration;
    }

    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, volume));
        this.audio.volume = this.volume;
        if (this.volumeSlider) this.volumeSlider.value = this.volume * 100;
    }

    previousTrack() {
        document.dispatchEvent(new CustomEvent('requestPreviousTrack'));
    }

    nextTrack() {
        document.dispatchEvent(new CustomEvent('requestNextTrack'));
    }

    // Audio element event handlers
    onLoadedMetadata() {
        this.totalTimeEl.textContent = this.formatTime(this.audio.duration);
        this.progressSlider.disabled = false;
        // Diagnostic: does the decoded audio's LENGTH match the displayed track's
        // expected length? A mismatch means a different FILE is sounding under the
        // right title — the smoking gun for "wrong song plays".
        if (this._diagOn()) {
            const act = Math.round(this.audio.duration || 0);
            const w = this._diagWant || {};
            const exp = w.exp || 0;
            // exp===0 (Drive gave no duration) makes the ✓ meaningless — say so.
            const bad = exp > 0 && act > 0 && Math.abs(act - exp) > 2;
            const verdict = exp > 0 ? (bad ? '  ← WRONG FILE' : '  ✓') : '  (no expected dur — can\'t compare)';
            this._diag('LOADED "' + (w.name || '') + '" actual=' + act + 's expected=' + exp + 's' + verdict, bad);
            // The element's ACTUALLY-selected resource vs the blob URL we assigned.
            const sel = this.audio.currentSrc || '';
            const ours = this._blobUrl && sel === this._blobUrl;
            if (!ours) this._diag('  currentSrc ≠ our blob ⚠  (' + (sel ? sel.slice(-12) : 'empty') + ')', true);
        }
        // Surface the decoded duration so the playlist can backfill its
        // total-running-time tally for tracks Drive didn't report metadata
        // for (e.g. WAVs Drive hasn't finished probing).
        const dur = this.audio.duration;
        if (this.currentTrack && isFinite(dur) && dur > 0) {
            document.dispatchEvent(new CustomEvent('trackDurationKnown', {
                detail: { trackId: this.currentTrack.id, durationMs: Math.round(dur * 1000) }
            }));
        }
    }

    onTimeUpdate() {
        if (!this.audio.duration) return;
        const percentage = (this.audio.currentTime / this.audio.duration) * 100;
        this.progressFill.style.width = `${percentage}%`;
        this.progressSlider.value = percentage;
        this.currentTimeEl.textContent = this.formatTime(this.audio.currentTime);
    }

    onPlay() {
        this.isPlaying = true;
        this._hasPlayed = true;
        this.playPauseBtn.textContent = '⏸';
    }

    onPause() {
        this.isPlaying = false;
        this.playPauseBtn.textContent = '▶️';
    }

    onTrackEnded() {
        this.isPlaying = false;
        this.playPauseBtn.textContent = '▶️';
        document.dispatchEvent(new CustomEvent('trackEnded'));
    }

    onError(error = null) {
        if (!this._blobUrl) return;
        if (this._hasPlayed) return; // track already played successfully — ghost error from iOS, ignore
        console.error('Audio error:', error);
        this.isPlaying = false;
        this.playPauseBtn.textContent = '▶️';
        this.trackTitle.textContent = 'Error loading track';
        this.trackArtist.textContent = 'Please try another track';
    }

    resetProgress() {
        this.progressFill.style.width = '0%';
        this.progressSlider.value = 0;
        this.progressSlider.disabled = true;
        this.currentTimeEl.textContent = '0:00';
        this.totalTimeEl.textContent = '0:00';
    }

    enableControls() {
        this.playPauseBtn.disabled = false;
        this.prevBtn.disabled = false;
        this.nextBtn.disabled = false;
    }

    disableControls() {
        this.playPauseBtn.disabled = true;
        this.prevBtn.disabled = true;
        this.nextBtn.disabled = true;
        this.progressSlider.disabled = true;
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // True when the Player (Listen) is the user's active surface. In the
    // tabbed Bloops shell, that means the Listen view is showing; on the
    // standalone player.html there are no tabs (no #bloops-tab) so it's
    // always active. Used to keep the Listen panel's keyboard shortcuts
    // (Space play/pause, arrows) from firing while the user is working on
    // the Make or Mix tab.
    _isListenViewActive() {
        return document.body.classList.contains('view-serialbox')
            || !document.getElementById('bloops-tab');
    }

    handleKeyboardControls(event) {
        // Listen panel is fully disabled on other tabs — ignore its keyboard
        // shortcuts (Space, arrows, volume) unless the Listen view is active.
        if (!this._isListenViewActive()) return;
        // Don't hijack keys (Space, arrows) while the user is typing in a
        // text field or editable element — e.g. the TEXT-mode speech box.
        const t = event.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        switch (event.code) {
            case 'Space':
                event.preventDefault();
                this.togglePlayPause();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                this.previousTrack();
                break;
            case 'ArrowRight':
                event.preventDefault();
                this.nextTrack();
                break;
            case 'ArrowUp':
                event.preventDefault();
                this.setVolume(Math.min(1, this.volume + 0.1));
                break;
            case 'ArrowDown':
                event.preventDefault();
                this.setVolume(Math.max(0, this.volume - 0.1));
                break;
        }
    }
}
