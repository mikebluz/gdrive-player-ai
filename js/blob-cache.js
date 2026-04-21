class BlobCache {
    constructor() {
        this._dbName = 'gdrive-player-blobs';
        this._storeName = 'blobs';
        this._db = null;
    }

    async _open() {
        if (this._db) return this._db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this._dbName, 1);
            req.onupgradeneeded = e => {
                e.target.result.createObjectStore(this._storeName);
            };
            req.onsuccess = e => {
                this._db = e.target.result;
                resolve(this._db);
            };
            req.onerror = () => reject(req.error);
        });
    }

    async store(trackId, blob) {
        try {
            const db = await this._open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readwrite');
                tx.objectStore(this._storeName).put(blob, trackId);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch {}
    }

    async getBlob(trackId) {
        try {
            const db = await this._open();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readonly');
                const req = tx.objectStore(this._storeName).get(trackId);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch { return null; }
    }

    async getBlobUrl(trackId) {
        const blob = await this.getBlob(trackId);
        return blob ? URL.createObjectURL(blob) : null;
    }

    async has(trackId) {
        try {
            const db = await this._open();
            return new Promise(resolve => {
                const tx = db.transaction(this._storeName, 'readonly');
                const req = tx.objectStore(this._storeName).getKey(trackId);
                req.onsuccess = () => resolve(req.result !== undefined);
                req.onerror = () => resolve(false);
            });
        } catch { return false; }
    }

    async remove(trackId) {
        try {
            const db = await this._open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readwrite');
                tx.objectStore(this._storeName).delete(trackId);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch {}
    }

    async clear() {
        try {
            const db = await this._open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readwrite');
                tx.objectStore(this._storeName).clear();
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch {}
    }
}
