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
        this._prefetchCache = new Map(); // trackId -> blobUrl

        this.initializeElements();
        this.bindEvents();
        this.setVolume(this.volume);
    }

    initializeElements() {
        this.playPauseBtn = document.getElementById('play-pause-btn');
        this.prevBtn = document.getElementById('prev-btn');
        this.nextBtn = document.getElementById('next-btn');

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

        this.audio.pause();

        // Clear src before revoking; _blobUrl being null suppresses spurious error events
        this.audio.src = '';
        if (this._blobUrl) {
            URL.revokeObjectURL(this._blobUrl);
            this._blobUrl = null;
        }

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
        if (!track || this._prefetchCache.has(track.id)) return;
        try {
            // Load from persistent blob cache if available — avoids network round-trip
            if (this.blobCache) {
                const blobUrl = await this.blobCache.getBlobUrl(track.id);
                if (blobUrl) {
                    this._prefetchCache.set(track.id, blobUrl);
                    document.dispatchEvent(new CustomEvent('prefetchCacheUpdated'));
                    return;
                }
            }

            const token = this.gDrive.accessToken;
            if (!token) return;
            const url = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`;
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (!response.ok) return;
            const blob = await response.blob();
            this._prefetchCache.set(track.id, URL.createObjectURL(blob));
            document.dispatchEvent(new CustomEvent('prefetchCacheUpdated'));
        } catch (e) {
            // prefetch failure is non-fatal
        }
    }

    // Persist a track's blob to blobCache for offline playback.
    // Reuses the already-loaded blob if the track is currently playing or prefetched,
    // avoiding a redundant network fetch.
    async persistTrack(track) {
        if (!track || !this.blobCache) return;
        if (await this.blobCache.has(track.id)) return;

        let sourceBlobUrl = null;
        if (this.currentTrack?.id === track.id && this._blobUrl) {
            sourceBlobUrl = this._blobUrl;
        } else if (this._prefetchCache.has(track.id)) {
            sourceBlobUrl = this._prefetchCache.get(track.id);
        }

        try {
            if (sourceBlobUrl) {
                const blob = await (await fetch(sourceBlobUrl)).blob();
                await this.blobCache.store(track.id, blob);
            } else {
                // Not in memory — fetch from Drive
                const token = this.gDrive.accessToken;
                if (!token) return;
                const url = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`;
                const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (!response.ok) return;
                const blob = await response.blob();
                await this.blobCache.store(track.id, blob);
            }
        } catch {}
    }

    clearPrefetchCache() {
        for (const url of this._prefetchCache.values()) URL.revokeObjectURL(url);
        this._prefetchCache.clear();
    }

    isPrefetched(trackId) {
        return this._prefetchCache.has(trackId);
    }

    evictPrefetchExcept(keepIds) {
        for (const [id, url] of this._prefetchCache) {
            if (!keepIds.has(id)) {
                URL.revokeObjectURL(url);
                this._prefetchCache.delete(id);
            }
        }
    }

    async play() {
        if (!this.currentTrack) return;
        try {
            // If we don't have a blob URL yet, fetch the file with the auth header
            if (!this._blobUrl) {
                // Use prefetched blob if available — avoids async gap on iOS so play() fires synchronously
                const prefetched = this._prefetchCache.get(this.currentTrack.id);
                if (prefetched) {
                    this._blobUrl = prefetched;
                    this._prefetchCache.delete(this.currentTrack.id);
                    this.audio.src = this._blobUrl;
                } else {
                    // Check persistent blob cache before going to network
                    const persisted = this.blobCache
                        ? await this.blobCache.getBlobUrl(this.currentTrack.id)
                        : null;
                    if (persisted) {
                        this._blobUrl = persisted;
                        this.audio.src = this._blobUrl;
                    } else {
                    // No cached blob and no auth token — can't play offline
                    if (!this.gDrive.accessToken) {
                        this.playPauseBtn.textContent = '▶️';
                        return;
                    }
                    // Unlock iOS audio via a throw-away element so the page-level
                    // user-activation is preserved across the async fetch, without
                    // firing ended/pause/play events on the main audio element.
                    new Audio(SILENT_WAV).play().catch(() => {});

                    this.playPauseBtn.textContent = '⏳';
                    this.playPauseBtn.disabled = true;

                    const url = `https://www.googleapis.com/drive/v3/files/${this.currentTrack.id}?alt=media`;
                    let response = await fetch(url, {
                        headers: { Authorization: `Bearer ${this.gDrive.accessToken}` }
                    });

                    if (response.status === 401) {
                        await this.gDrive.refreshTokenSilently();
                        response = await fetch(url, {
                            headers: { Authorization: `Bearer ${this.gDrive.accessToken}` }
                        });
                    }

                    if (!response.ok) {
                        throw new Error(`Drive fetch failed: ${response.status} ${response.statusText}`);
                    }

                    const blob = await response.blob();
                    this._blobUrl = URL.createObjectURL(blob);
                    this.audio.src = this._blobUrl;

                    this.playPauseBtn.disabled = false;
                    } // end network fetch else
                } // end blobCache else
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

    handleKeyboardControls(event) {
        if (event.target.tagName === 'INPUT') return;
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
