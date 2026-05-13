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

export async function saveIdentity(identity) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite")
        tx.objectStore(STORE).put(identity, "identity")
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
    })
}

export async function loadIdentity() {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly")
        const req = tx.objectStore(STORE).get("identity")
        req.onsuccess = e => resolve(e.target.result ?? null)
        req.onerror = e => reject(e.target.error)
    })
}

export async function clearIdentity() {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite")
        tx.objectStore(STORE).delete("identity")
        tx.oncomplete = () => resolve()
        tx.onerror = e => reject(e.target.error)
    })
}
