class MusicPlayer {
    constructor(gDrive) {
        this.gDrive = gDrive;
        this.audio = document.getElementById('audio-player');
        this.currentTrack = null;
        this.isPlaying = false;
        this.volume = 0.7;

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

    async play() {
        if (!this.currentTrack) return;
        try {
            // If we don't have a blob URL yet, fetch the file with the auth header
            if (!this._blobUrl) {
                this.playPauseBtn.textContent = '⏳';
                this.playPauseBtn.disabled = true;

                const token = this.gDrive.accessToken;
                const url = `https://www.googleapis.com/drive/v3/files/${this.currentTrack.id}?alt=media`;
                const response = await fetch(url, {
                    headers: { Authorization: `Bearer ${token}` }
                });

                if (!response.ok) {
                    throw new Error(`Drive fetch failed: ${response.status} ${response.statusText}`);
                }

                const blob = await response.blob();
                this._blobUrl = URL.createObjectURL(blob);
                this.audio.src = this._blobUrl;

                this.playPauseBtn.disabled = false;
            }

            await this.audio.play();
        } catch (error) {
            console.error('Error playing audio:', error);
            this.playPauseBtn.disabled = false;
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
