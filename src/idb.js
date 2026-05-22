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
