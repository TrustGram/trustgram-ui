// Per-contact encrypted message history.
//
// Storage moved from localStorage → IndexedDB. The IDB store gives us a much
// larger quota (localStorage caps at ~5 MB across the whole origin) and one
// consistent backend for all sensitive material.
//
// XSS in this same origin can still read both stores — moving to IDB is NOT
// a defence against attacker JS. Payload encryption (AES-GCM under the
// storage key) is what actually protects message bodies.
//
// Legacy localStorage rows are migrated lazily on first load.

import { openDB, idbGet, idbPut, idbDelete, idbClear, STORES } from "./idb"

const LS_PREFIX = "tg_msgs_"

function toBase64(bytes) {
    return btoa(String.fromCharCode(...bytes))
}

function fromBase64(str) {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}

async function migrateFromLocalStorage(db, contactId) {
    const lsKey = LS_PREFIX + contactId
    const stored = localStorage.getItem(lsKey)
    if (!stored) return null
    try {
        const blob = JSON.parse(stored)
        await idbPut(db, STORES.MESSAGES, String(contactId), blob)
        return blob
    } finally {
        localStorage.removeItem(lsKey)
    }
}

async function readEnvelope(db, contactId) {
    const found = await idbGet(db, STORES.MESSAGES, String(contactId))
    if (found) return found
    return migrateFromLocalStorage(db, contactId)
}

export async function loadMessages(contactId, storageKey) {
    const db = await openDB()
    const envelope = await readEnvelope(db, contactId)
    if (!envelope) return []
    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(envelope.iv) },
            storageKey,
            fromBase64(envelope.data)
        )
        return JSON.parse(new TextDecoder().decode(decrypted))
    } catch {
        return []
    }
}

export async function saveMessages(contactId, messages, storageKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        storageKey,
        new TextEncoder().encode(JSON.stringify(messages))
    )
    const db = await openDB()
    await idbPut(db, STORES.MESSAGES, String(contactId), {
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(encrypted)),
    })
}

export async function clearMessages(contactId) {
    const db = await openDB()
    await idbDelete(db, STORES.MESSAGES, String(contactId))
    localStorage.removeItem(LS_PREFIX + contactId)
}

export async function clearAllMessages() {
    const db = await openDB()
    await idbClear(db, STORES.MESSAGES)
    Object.keys(localStorage)
        .filter(k => k.startsWith(LS_PREFIX))
        .forEach(k => localStorage.removeItem(k))
}
