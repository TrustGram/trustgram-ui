// Per-contact Double Ratchet state persistence.
//
// Each chat has its own RatchetState — a small object containing:
//   - Two ECDH P-256 KeyPair objects (current DH ratchet send key + recv pub)
//   - Three HKDF CryptoKey objects (rootKey, sendChainKey, recvChainKey)
//   - An array of skipped AES-GCM message keys (for out-of-order delivery)
//   - Plain-number counters
//
// All key material is non-extractable. IndexedDB's structured-clone algorithm
// preserves CryptoKey identity across put/get without ever exposing raw bytes
// to JS, so the state survives page reloads but cannot be exfiltrated from a
// disk dump of the IDB.
//
// Cross-tab safety: navigator.locks guards load→advance→save so two tabs
// can't both read state v_n, advance independently, and race to overwrite.

import { openDB, idbGet, idbPut, idbDelete, idbClear, STORES } from "./idb"

function ratchetLockName(contactId) {
    return `tg-ratchet-${contactId}`
}

/**
 * Load the persisted ratchet state for `contactId`, or null if none exists yet
 * (first message of a session — caller must run X3DH).
 */
export async function loadRatchet(contactId) {
    const db = await openDB()
    return idbGet(db, STORES.RATCHET, String(contactId))
}

/** Persist `state` for `contactId`. */
export async function saveRatchet(contactId, state) {
    const db = await openDB()
    await idbPut(db, STORES.RATCHET, String(contactId), state)
}

/** Drop persisted state — used when a chat is deleted or keys are reset. */
export async function clearRatchet(contactId) {
    const db = await openDB()
    await idbDelete(db, STORES.RATCHET, String(contactId))
}

/** Drop all persisted ratchet state. Used on identity reset. */
export async function clearAllRatchets() {
    const db = await openDB()
    await idbClear(db, STORES.RATCHET)
}

/**
 * Run `fn(currentState)` exclusively for this contact — no other tab/poll can
 * read or write the state until fn resolves. `fn` returns the new state
 * (or null to leave unchanged); the new state is persisted before the lock is
 * released.
 *
 * Falls back to direct execution in environments without navigator.locks
 * (very old browsers) — those won't have cross-tab safety but the same-tab
 * race is already avoided by the await-chain.
 */
export async function withRatchetLock(contactId, fn) {
    const run = async () => {
        const current = await loadRatchet(contactId)
        const next = await fn(current)
        if (next !== undefined && next !== null) {
            await saveRatchet(contactId, next)
        }
        return next
    }
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
        return navigator.locks.request(ratchetLockName(contactId), run)
    }
    return run()
}
