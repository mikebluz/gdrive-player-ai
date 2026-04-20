class UserSongCache {
    constructor() {
        this.STORAGE_KEY = 'gdrive-player-user-cache';
    }

    getAll() {
        try {
            return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
        } catch {
            return [];
        }
    }

    isCached(trackId) {
        return this.getAll().some(t => t.id === trackId);
    }

    save(track) {
        const cached = this.getAll();
        if (!cached.some(t => t.id === track.id)) {
            cached.push({ id: track.id, name: track.name });
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(cached));
        }
    }

    remove(trackId) {
        const filtered = this.getAll().filter(t => t.id !== trackId);
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(filtered));
    }

    toggle(track) {
        if (this.isCached(track.id)) {
            this.remove(track.id);
            return false;
        }
        this.save(track);
        return true;
    }

    clear() {
        localStorage.removeItem(this.STORAGE_KEY);
    }
}
