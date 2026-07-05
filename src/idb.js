// Single source of truth for the IndexedDB schema. Both storage.js and
// messageStore.js call openDB() from here so the version + onupgradeneeded
// stay consistent — opening the same DB at different versions from different
// modules would cause VersionError races.

const DB_NAME = "trustgram"
const DB_VERSION = 4

export const STORES = {
    IDENTITY: "identity",
    MESSAGES: "messages",
    RATCHET: "ratchet",
    FINGERPRINTS: "fingerprints",
}

export function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = e => {
            const db = e.target.result
            // v1 created `identity`; v2 added `messages`; v3 added `ratchet`;
            // v4 added `fingerprints` (TOFU-pinned safety numbers per contact).
            // createObjectStore throws if the store already exists, so always guard.
            if (!db.objectStoreNames.contains(STORES.IDENTITY)) db.createObjectStore(STORES.IDENTITY)
            if (!db.objectStoreNames.contains(STORES.MESSAGES)) db.createObjectStore(STORES.MESSAGES)
            if (!db.objectStoreNames.contains(STORES.RATCHET)) db.createObjectStore(STORES.RATCHET)
            if (!db.objectStoreNames.contains(STORES.FINGERPRINTS)) db.createObjectStore(STORES.FINGERPRINTS)
        }
        req.onsuccess = e => resolve(e.target.result)
        req.onerror = e => reject(e.target.error)
    })
}

export function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).get(key)
        req.onsuccess = e => resolve(e.target.result ?? null)
        req.onerror = e => reject(e.target.error)
    })
}

export function idbPut(db, store, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite")
        tx.objectStore(store).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
    })
}

export function idbDelete(db, store, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite")
        tx.objectStore(store).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
    })
}

export function idbClear(db, store) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite")
        tx.objectStore(store).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
    })
}

// ── Concurrency helpers ───────────────────────────────────────

// Serialize async critical sections by `name` — across tabs (navigator.locks)
// AND within this tab (a per-name promise chain, which also covers browsers
// that don't expose navigator.locks, where request() would otherwise no-op).
// Used for the per-contact ratchet/history locks and the identity lock. Names
// are bounded (per contact + a few globals) so the chain map stays small.
const _chains = new Map()
export function withLock(name, fn) {
    const prev = _chains.get(name) ?? Promise.resolve()
    const acquire = () => (navigator.locks?.request ? navigator.locks.request(name, fn) : fn())
    // Run after the previous holder settles, regardless of its outcome.
    const run = prev.then(acquire, acquire)
    // The stored tail swallows errors so one rejection can't break the chain.
    _chains.set(name, run.then(() => {}, () => {}))
    return run
}

// Single-transaction read-modify-write of one key. `mutator(current)` MUST be
// synchronous — a non-IDB await between get and put auto-closes the IDB
// transaction (TransactionInactiveError). Return `undefined` to leave the
// record unchanged.
export function idbUpdate(db, store, key, mutator) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite")
        const os = tx.objectStore(store)
        const g = os.get(key)
        g.onsuccess = () => {
            let next
            try {
                next = mutator(g.result ?? null)
            } catch (e) {
                tx.abort()
                return reject(e)
            }
            if (next !== undefined) os.put(next, key)
        }
        g.onerror = e => reject(e.target.error)
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
        tx.onabort = () => reject(tx.error)
    })
}

// Put several [key, value] pairs into one store atomically (all-or-nothing in a
// single transaction). Used to persist ratchet state and its processed-id set
// together — a partial write would desync the two.
export function idbPutMany(db, store, entries) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite")
        const os = tx.objectStore(store)
        for (const [key, value] of entries) os.put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
        tx.onabort = () => reject(tx.error)
    })
}
