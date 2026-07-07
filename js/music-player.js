// Minimal silent WAV — used to activate the iOS audio element synchronously
// within a user gesture before an async fetch breaks the gesture chain.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

class MusicPlayer {
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
        // Monotonic load generation — bumped on every loadTrack(). play() captures
        // it at entry and bails before assigning audio.src if it has moved, so a
        // slow fetch for a track you've since skipped past can't clobber the
        // current track's audio (the "wrong song plays" race).
        this._loadSeq = 0;

        this.initializeElements();
        this.bindEvents();
        this.setVolume(this.volume);
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
                    this._prefetchCache.set(track.id, blob);
                    document.dispatchEvent(new CustomEvent('prefetchCacheUpdated'));
                    this._probeBlobDuration(blob, track.id);
                    return 'cached';
                }
            }

            const token = this.gDrive.accessToken;
            if (!token) return 'skipped';
            const url = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`;
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (!response.ok) return 'failed';
            const blob = await response.blob();
            this._prefetchCache.set(track.id, blob);
            if (this.blobCache) this.blobCache.store(track.id, blob);
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
        if (this.currentTrack?.id === track.id && this._blob) {
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
                const url = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`;
                const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (!response.ok) return;
                await this.blobCache.store(track.id, await response.blob());
            }
        } catch {}
    }

    clearPrefetchCache() {
        this._prefetchCache.clear(); // blobs are GC'd automatically, no URLs to revoke
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
        try {
            if (!this._blobUrl) {
                const prefetchedBlob = this._prefetchCache.get(this.currentTrack.id);

                if (prefetchedBlob) {
                    // 1. In-memory prefetch — fully synchronous, preserves iOS gesture chain
                    this._blob = prefetchedBlob;
                    this._prefetchCache.delete(this.currentTrack.id);
                    this._blobUrl = URL.createObjectURL(this._blob);
                    this.audio.src = this._blobUrl;

                } else {
                    // All other paths require at least one await. Unlock iOS audio NOW,
                    // synchronously while the gesture chain is still intact, before any
                    // await breaks it (blobCache.getBlob, fetch, refreshToken, etc.).
                    new Audio(SILENT_WAV).play().catch(() => {});

                    const persistedBlob = this.blobCache
                        ? await this.blobCache.getBlob(this.currentTrack.id)
                        : null;
                    if (superseded()) return;   // skipped to another track during the lookup

                    if (persistedBlob) {
                        // 2. Persistent blob cache — user-saved tracks, works offline
                        this._blob = persistedBlob;
                        this._blobUrl = URL.createObjectURL(this._blob);
                        this.audio.src = this._blobUrl;

                    } else if (!this.gDrive.accessToken) {
                        // 3. No cached blob and no token — can't play offline
                        this.playPauseBtn.textContent = '▶️';
                        return;

                    } else {
                        // 4. Fetch from Drive
                        this.playPauseBtn.textContent = '⏳';
                        this.playPauseBtn.disabled = true;

                        const url = `https://www.googleapis.com/drive/v3/files/${this.currentTrack.id}?alt=media`;
                        let response = await fetch(url, {
                            headers: { Authorization: `Bearer ${this.gDrive.accessToken}` }
                        });
                        if (superseded()) { this.playPauseBtn.disabled = false; return; }

                        if (response.status === 401) {
                            await this.gDrive.refreshTokenSilently();
                            response = await fetch(url, {
                                headers: { Authorization: `Bearer ${this.gDrive.accessToken}` }
                            });
                            if (superseded()) { this.playPauseBtn.disabled = false; return; }
                        }

                        if (!response.ok) {
                            throw new Error(`Drive fetch failed: ${response.status} ${response.statusText}`);
                        }

                        this._blob = await response.blob();
                        // Last and most important guard: the blob just finished
                        // downloading — if we've skipped past this track, drop it
                        // rather than assigning it over the current track's audio.
                        if (superseded()) { this.playPauseBtn.disabled = false; return; }
                        this._blobUrl = URL.createObjectURL(this._blob);
                        this.audio.src = this._blobUrl;
                        this.playPauseBtn.disabled = false;
                    }
                }
            }

            if (superseded()) return;
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
