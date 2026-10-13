// Where the page keeps its saves: IndexedDB, in this browser. A save of a
// whole world is about a megabyte, too much for localStorage.
//
// The slots: 'auto' (the autosave), '1', '2', '3' (saved by hand), and
// 'previous' (the autosave of another game, kept when a new game's first
// autosave would have taken its place: panel/saves.js). Each kept save is
// {slot, savedAt (ms since 1970), run (which game), meta (save.js saveMeta),
// page (the page's own state: who you are, the view, the speed...), data
// (the save itself, save.js)}. The list of slots reads only the small part
// (the `meta` store); the save itself is in the `data` store, read when it
// is loaded.
//
// Every access is wrapped: where storage is refused (a private window, a
// browser set to keep nothing, a full disk), each call fails with a
// StorageError whose message says so plainly, and nothing else breaks.
export const SLOTS = ['auto', 'previous', '1', '2', '3'];

const DB_NAME = 'life-simulator';
const DB_VERSION = 1;
const META = 'meta';
const DATA = 'data';

export const UNAVAILABLE = 'Saves cannot be kept in this browser (storage is turned off, full, or this is a private window). Export to a file still works.';

export class StorageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StorageError';
    }
}

// An IndexedDB request as a promise.
const done = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

// A transaction finished (or failed).
const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
});

export class SaveStore {
    // idb: the IndexedDB factory (the browser's, by default; none in node).
    constructor(idb = globalThis.indexedDB) {
        this.idb = idb ?? null;
        this.db = null;
        this.opening = null;
    }

    async open() {
        if (this.db) return this.db;
        if (!this.idb) throw new StorageError(UNAVAILABLE);
        this.opening ??= (async () => {
            try {
                const req = this.idb.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'slot' });
                    if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'slot' });
                };
                this.db = await done(req);
                this.db.onversionchange = () => {
                    this.db.close();
                    this.db = null;
                };
                return this.db;
            } catch (err) {
                throw new StorageError(`${UNAVAILABLE} (${err?.message ?? err})`);
            } finally {
                this.opening = null;
            }
        })();
        return this.opening;
    }

    // Run `work(stores)` in a transaction over both stores.
    async run(mode, work) {
        const db = await this.open();
        try {
            const tx = db.transaction([META, DATA], mode);
            const out = await work({ meta: tx.objectStore(META), data: tx.objectStore(DATA) });
            await finished(tx);
            return out;
        } catch (err) {
            if (err instanceof StorageError) throw err;
            const full = err?.name === 'QuotaExceededError';
            throw new StorageError(full ? 'There is no room left to keep this save in this browser. Delete a slot, or export to a file.' : `${UNAVAILABLE} (${err?.message ?? err})`);
        }
    }

    // Every kept slot's summary {slot, savedAt, run, meta, page}, by slot.
    async list() {
        const all = await this.run('readonly', ({ meta }) => done(meta.getAll()));
        return new Map(all.map((r) => [r.slot, r]));
    }

    // A kept save, whole (null: the slot is empty).
    async get(slot) {
        return this.run('readonly', async ({ meta, data }) => {
            const [m, d] = await Promise.all([done(meta.get(slot)), done(data.get(slot))]);
            return m && d ? { ...m, data: d.data } : null;
        });
    }

    // Keep `record` ({slot, savedAt, run, meta, page, data}) in its slot.
    async put(record) {
        const { data, ...summary } = record;
        await this.run('readwrite', ({ meta, data: store }) => {
            meta.put(summary);
            store.put({ slot: record.slot, data });
        });
    }

    async remove(slot) {
        await this.run('readwrite', ({ meta, data }) => {
            meta.delete(slot);
            data.delete(slot);
        });
    }

    // Move what is in slot `from` to slot `to` (in one go; nothing there: nothing done).
    async move(from, to) {
        await this.run('readwrite', async ({ meta, data }) => {
            const [m, d] = await Promise.all([done(meta.get(from)), done(data.get(from))]);
            if (!m || !d) return;
            meta.put({ ...m, slot: to });
            data.put({ ...d, slot: to });
            meta.delete(from);
            data.delete(from);
        });
    }
}
