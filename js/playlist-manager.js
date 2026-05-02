class PlaylistManager {
    constructor(musicPlayer, userCache = null) {
        this.musicPlayer = musicPlayer;
        this.userCache = userCache;
        this.tracks = [];
        this.currentIndex = -1;
        this.shuffled = false;
        this.originalOrder = [];

        this.playlistContainer = document.getElementById('playlist-container');
        this.playlistCount = document.getElementById('playlist-count');
        // sb- prefix avoids collision with Bloops's own #shuffle-btn /
        // #loop-btn inside the unified page.
        this.shuffleBtn = document.getElementById('sb-shuffle-btn');
        this.loopBtn    = document.getElementById('sb-loop-btn');
        this.loopMode = 'off'; // 'off' | 'track' | 'playlist'

        this.bindEvents();
    }

    bindEvents() {
        this.shuffleBtn.addEventListener('click', () => this.toggleShuffle());
        this.loopBtn?.addEventListener('click', () => this.cycleLoopMode());

        // Listen for player events
        document.addEventListener('trackEnded', () => this.onTrackEnded());
        document.addEventListener('requestNextTrack', () => this.playNext());
        document.addEventListener('requestPreviousTrack', () => this.playPrevious());
        document.addEventListener('prefetchCacheUpdated', () => this.refreshCacheIndicators());
    }

    setTracks(tracks) {
        this.musicPlayer.clearPrefetchCache();
        this.tracks = [...tracks];
        this.originalOrder = [...tracks];
        this.currentIndex = -1;
        this.renderPlaylist();
        this.updatePlaylistInfo();
        // Pre-load the first track but don't auto-play. The dropdown-change
        // path runs through multiple awaits before the play call would fire,
        // and iOS denies any audio.play() that isn't triggered directly
        // within the original user gesture — the failed call also left the
        // audio element in a state where the play button stayed unresponsive
        // until the user clicked a song chip (a fresh gesture). Loading
        // without auto-play keeps the element clean, so the first tap on
        // the play button is the gesture that starts playback.
        if (this.tracks.length > 0) {
            this.currentIndex = 0;
            this.musicPlayer.loadTrack(this.tracks[0]);
            this.updateActiveTrack();
            this._buildPrefetchWindow(0);
        }
    }

    addTrack(track) {
        this.tracks.push(track);
        this.originalOrder.push(track);
        this.renderPlaylist();
        this.updatePlaylistInfo();
    }

    removeTrack(index) {
        if (index === this.currentIndex) {
            this.musicPlayer.stop();
            this.currentIndex = -1;
        } else if (index < this.currentIndex) {
            this.currentIndex--;
        }

        this.tracks.splice(index, 1);
        this.originalOrder = this.originalOrder.filter(track => 
            track.id !== this.tracks[index]?.id
        );
        
        this.renderPlaylist();
        this.updatePlaylistInfo();
    }

    playTrack(index, resetCache = false) {
        if (index < 0 || index >= this.tracks.length) return;

        this.currentIndex = index;
        const track = this.tracks[index];
        this.musicPlayer.loadTrack(track);
        this.musicPlayer.play();
        this.updateActiveTrack();

        // Full reset on explicit user selection; sliding evict for autoplay
        if (resetCache) this.musicPlayer.clearPrefetchCache();

        const windowIds = this._buildPrefetchWindow(index);
        if (!resetCache) this.musicPlayer.evictPrefetchExcept(windowIds);
    }

    _buildPrefetchWindow(index) {
        const windowIds = new Set();
        const candidates = [];
        for (let i = 1; i <= 4; i++) {
            const nextIndex = (index + i) % this.tracks.length;
            if (nextIndex !== index) {
                const track = this.tracks[nextIndex];
                windowIds.add(track.id);
                candidates.push(track);
            }
        }
        // prefetchTrack hydrates _prefetchCache from blobCache when available
        // and only hits the network as a last resort.
        Promise.all(candidates.map(t => this.musicPlayer.prefetchTrack(t)));
        return windowIds;
    }

    playNext() {
        if (this.tracks.length === 0) return;

        let nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.tracks.length) {
            nextIndex = 0;
        }

        this.playTrack(nextIndex);
    }

    onTrackEnded() {
        if (this.loopMode === 'track') {
            if (this.currentIndex >= 0) this.playTrack(this.currentIndex);
        } else if (this.loopMode === 'playlist') {
            this.playNext();
        } else {
            // 'off': advance through playlist, stop at end without looping
            if (this.currentIndex < this.tracks.length - 1) {
                this.playTrack(this.currentIndex + 1);
            }
        }
    }

    cycleLoopMode() {
        const modes = ['off', 'track', 'playlist'];
        this.loopMode = modes[(modes.indexOf(this.loopMode) + 1) % modes.length];
        this._updateLoopBtn();
    }

    _updateLoopBtn() {
        if (!this.loopBtn) return;
        const config = {
            off:      { icon: '🔁', cls: 'loop-off' },
            track:    { icon: '🔂', cls: 'loop-track' },
            playlist: { icon: '🔁', cls: 'loop-playlist' },
        };
        const { icon, cls } = config[this.loopMode];
        this.loopBtn.textContent = icon;
        this.loopBtn.className = `control-btn loop-btn ${cls}`;
    }

    playPrevious() {
        if (this.tracks.length === 0) return;

        let prevIndex = this.currentIndex - 1;
        if (prevIndex < 0) {
            prevIndex = this.tracks.length - 1; // Loop to end
        }

        this.playTrack(prevIndex);
    }

    toggleShuffle() {
        this.musicPlayer.stop();
        this.currentIndex = -1;
        this.shuffled = !this.shuffled;

        if (this.shuffled) {
            this.shuffleBtn.textContent = '🔀 Shuffled';
            this.shuffleBtn.style.background = 'linear-gradient(135deg, #5a67d8, #667eea)';
            this.shuffleBtn.style.color = 'white';
            this.shuffleTracks();
        } else {
            this.shuffleBtn.textContent = '🔀 Shuffle';
            this.shuffleBtn.style.background = '';
            this.shuffleBtn.style.color = '';
            this.restoreOriginalOrder();
        }

        this.renderPlaylist();
        if (this.tracks.length > 0) this.playTrack(0);
    }

    shuffleTracks() {
        const currentTrack = this.currentIndex >= 0 ? this.tracks[this.currentIndex] : null;
        
        // Fisher-Yates shuffle algorithm
        for (let i = this.tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
        }

        // Update current index if there was a playing track
        if (currentTrack) {
            this.currentIndex = this.tracks.findIndex(track => track.id === currentTrack.id);
        }
    }

    restoreOriginalOrder() {
        const currentTrack = this.currentIndex >= 0 ? this.tracks[this.currentIndex] : null;
        
        this.tracks = [...this.originalOrder];
        
        // Update current index
        if (currentTrack) {
            this.currentIndex = this.tracks.findIndex(track => track.id === currentTrack.id);
        }
    }

    moveTrack(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;

        const track = this.tracks.splice(fromIndex, 1)[0];
        this.tracks.splice(toIndex, 0, track);

        // Update current index
        if (this.currentIndex === fromIndex) {
            this.currentIndex = toIndex;
        } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
            this.currentIndex--;
        } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
            this.currentIndex++;
        }

        this.renderPlaylist();
    }

    _trackNameClass(track) {
        if (this.userCache?.isCached(track.id)) return 'track-name--user-cached';
        if (this.musicPlayer.isPrefetched(track.id)) return 'track-name--prefetched';
        return '';
    }

    refreshCacheIndicators() {
        const items = this.playlistContainer.querySelectorAll('.playlist-item');
        items.forEach((item, index) => {
            const track = this.tracks[index];
            if (!track) return;
            const nameEl = item.querySelector('.track-name');
            if (!nameEl) return;
            nameEl.className = `track-name ${this._trackNameClass(track)}`.trim();
        });
    }

    renderPlaylist() {
        if (this.tracks.length === 0) {
            this.playlistContainer.innerHTML = `
                <div class="empty-playlist">
                    <p>🎵 No tracks loaded</p>
                    <p>Enter a folder name above to load your music</p>
                </div>
            `;
            return;
        }

        const playlistHTML = this.tracks.map((track, index) => `
            <div class="playlist-item" data-index="${index}" draggable="true">
                <div class="drag-handle">⋮⋮</div>
                <div class="track-number">${index + 1}</div>
                <div class="track-details">
                    <div class="track-name ${this._trackNameClass(track)}">${track.name}</div>
                    <div class="track-duration">${this.formatFileSize(track.size)}</div>
                </div>
            </div>
        `).join('');

        this.playlistContainer.innerHTML = playlistHTML;
        this.bindPlaylistEvents();
        this.updateActiveTrack();
    }

    bindPlaylistEvents() {
        const items = this.playlistContainer.querySelectorAll('.playlist-item');

        items.forEach((item, index) => {
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('drag-handle')) {
                    const track = this.tracks[index];
                    const fastPath = this.userCache?.isCached(track.id)
                        || this.musicPlayer.isPrefetched(track.id);
                    if (fastPath) {
                        this.playTrack(index, false);
                        setTimeout(() => {
                            this.musicPlayer.clearPrefetchCache();
                            this._buildPrefetchWindow(index);
                        }, 0);
                    } else {
                        this.playTrack(index, true);
                    }
                }
            });

            item.addEventListener('dragstart', (e) => {
                this._dragIndex = index;
                e.dataTransfer.effectAllowed = 'move';
                // Defer adding the class so the drag image renders normally
                requestAnimationFrame(() => item.classList.add('dragging'));
            });

            item.addEventListener('dragenter', (e) => {
                e.preventDefault();
                if (this._dragIndex === index) return;
                this._clearDropIndicators();
                item.classList.add('drag-over');
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });

            item.addEventListener('dragleave', (e) => {
                if (!item.contains(e.relatedTarget)) {
                    item.classList.remove('drag-over');
                }
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                this._clearDropIndicators();
                if (this._dragIndex !== null && this._dragIndex !== index) {
                    this.moveTrack(this._dragIndex, index);
                }
                this._dragIndex = null;
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                this._clearDropIndicators();
                this._dragIndex = null;
            });

            this.bindTouchDrag(item, index);
        });
    }

    _clearDropIndicators() {
        this.playlistContainer.querySelectorAll('.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
    }

    bindTouchDrag(item, index) {
        item.addEventListener('touchstart', (e) => {
            if (!e.target.classList.contains('drag-handle')) return;
            e.preventDefault();

            this._dragIndex = index;
            const touch = e.touches[0];
            const rect = item.getBoundingClientRect();
            this._touchOffsetY = touch.clientY - rect.top;

            // Create floating clone
            const clone = item.cloneNode(true);
            Object.assign(clone.style, {
                position: 'fixed',
                left: rect.left + 'px',
                top: rect.top + 'px',
                width: rect.width + 'px',
                opacity: '0.85',
                pointerEvents: 'none',
                zIndex: '9999',
                boxShadow: '0 8px 25px rgba(0,0,0,0.3)',
                borderRadius: '10px',
            });
            document.body.appendChild(clone);
            this._touchClone = clone;
            item.classList.add('dragging');

            const onMove = (e) => {
                e.preventDefault();
                const t = e.touches[0];
                this._touchClone.style.top = (t.clientY - this._touchOffsetY) + 'px';

                // Hide clone to hit-test underneath it
                this._touchClone.style.visibility = 'hidden';
                const el = document.elementFromPoint(t.clientX, t.clientY);
                this._touchClone.style.visibility = '';

                const targetItem = el?.closest('.playlist-item');
                this._clearDropIndicators();
                if (targetItem) {
                    const targetIndex = parseInt(targetItem.dataset.index);
                    if (targetIndex !== this._dragIndex) {
                        targetItem.classList.add('drag-over');
                        this._touchDropTarget = targetIndex;
                    } else {
                        this._touchDropTarget = null;
                    }
                } else {
                    this._touchDropTarget = null;
                }
            };

            const onEnd = () => {
                this._touchClone?.remove();
                this._touchClone = null;
                item.classList.remove('dragging');
                this._clearDropIndicators();

                if (this._touchDropTarget !== null && this._touchDropTarget !== this._dragIndex) {
                    this.moveTrack(this._dragIndex, this._touchDropTarget);
                }

                this._dragIndex = null;
                this._touchDropTarget = null;
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
            };

            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        }, { passive: false });
    }

    updateActiveTrack() {
        const items = this.playlistContainer.querySelectorAll('.playlist-item');
        items.forEach((item, index) => {
            if (index === this.currentIndex) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    updatePlaylistInfo() {
        const count = this.tracks.length;
        const text = count === 1 ? '1 track' : `${count} tracks`;
        this.playlistCount.textContent = text;
    }

    formatFileSize(bytes) {
        if (!bytes) return 'Unknown size';
        
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 Bytes';
        
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    clear() {
        this.tracks = [];
        this.originalOrder = [];
        this.currentIndex = -1;
        this.shuffled = false;
        this.renderPlaylist();
        this.updatePlaylistInfo();
        
        // Reset shuffle button
        this.shuffleBtn.textContent = '🔀 Shuffle';
        this.shuffleBtn.style.background = '';
        this.shuffleBtn.style.color = '';
    }
}
