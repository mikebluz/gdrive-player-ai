class BlobCache {
    constructor() {
        this._name = 'gdrive-player-blobs-v1';
    }

    _key(trackId) {
        return `https://gdrive-blob-cache/${trackId}`;
    }

    async getBlobUrl(trackId) {
        try {
            const cache = await caches.open(this._name);
            const response = await cache.match(this._key(trackId));
            if (!response) return null;
            return URL.createObjectURL(await response.blob());
        } catch { return null; }
    }

    async store(trackId, blob) {
        try {
            const cache = await caches.open(this._name);
            await cache.put(this._key(trackId), new Response(blob));
        } catch {}
    }

    async has(trackId) {
        try {
            const cache = await caches.open(this._name);
            return !!(await cache.match(this._key(trackId)));
        } catch { return false; }
    }

    async remove(trackId) {
        try {
            const cache = await caches.open(this._name);
            await cache.delete(this._key(trackId));
        } catch {}
    }

    async clear() {
        try {
            await caches.delete(this._name);
        } catch {}
    }
}
