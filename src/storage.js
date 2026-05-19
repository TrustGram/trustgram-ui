const DB_NAME = "trustgram"
const DB_VERSION = 1
const STORE = "identity"

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = e => {
            e.target.result.createObjectStore(STORE)
        }
        req.onsuccess = e => resolve(e.target.result)
        req.onerror = e => reject(e.target.error)
    })
}

function idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key)
        req.onsuccess = e => resolve(e.target.result ?? null)
        req.onerror = e => reject(e.target.error)
    })
}

function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite")
        tx.objectStore(STORE).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
    })
}

function idbDelete(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite")
        tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
    })
}

export async function saveIdentity(identity) {
    const db = await openDB()
    await idbPut(db, "identity", identity)
}

export async function loadIdentity() {
    const db = await openDB()
    return idbGet(db, "identity")
}

export async function getOrCreateStorageKey() {
    const db = await openDB()
    const existing = await idbGet(db, "storage_key")
    if (existing) return existing

    const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    )
    await idbPut(db, "storage_key", key)
    return key
}

export async function clearIdentity() {
    const db = await openDB()
    await idbDelete(db, "identity")
    await idbDelete(db, "storage_key")
}

export async function appendOTKsToIdentity(newPairs) {
    const db = await openDB()
    const identity = await idbGet(db, "identity")
    if (!identity) return
    identity.oneTimePreKeys = [...identity.oneTimePreKeys, ...newPairs]
    await idbPut(db, "identity", identity)
}

export async function consumeOTK(usedPublicKeyB64) {
    const db = await openDB()
    const identity = await idbGet(db, "identity")
    if (!identity) return
    const filtered = []
    for (const kp of identity.oneTimePreKeys) {
        const raw = await crypto.subtle.exportKey("raw", kp.publicKey)
        const pub = btoa(String.fromCharCode(...new Uint8Array(raw)))
        if (pub !== usedPublicKeyB64) filtered.push(kp)
    }
    identity.oneTimePreKeys = filtered
    await idbPut(db, "identity", identity)
}
