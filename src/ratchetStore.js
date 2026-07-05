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
// Alongside each contact's ratchet state we persist a bounded set of already-
// processed message ids (key `${id}:processed`). It makes inbox processing
// idempotent: if a server delete fails or a message is re-delivered, we re-ack
// it without re-decrypting against an already-advanced ratchet (which would
// fail and surface a false "couldn't decrypt" placeholder).
//
// Cross-tab safety: withLock guards load→advance→save so two tabs can't both
// read state v_n, advance independently, and race to overwrite. withLock also
// serializes within a single tab (a promise chain per lock name), so it holds
// even on browsers without navigator.locks.

import { openDB, idbGet, idbPut, idbDelete, idbClear, idbPutMany, withLock, STORES } from "./idb"

// Cap on the persisted processed-id ring. The re-delivery window is tiny (the
// server deletes acked messages and TTL-reaps the rest within ~1h), so the most
// recent PROCESSED_MAX ids are more than enough to catch a duplicate.
const PROCESSED_MAX = 256

function processedKey(contactId) {
    return `${contactId}:processed`
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

/**
 * Persist ratchet state AND the processed-id set for `contactId` in a single
 * transaction. They are two faces of one fact ("these messages were consumed,
 * the chain advanced") — writing them separately risks a crash desyncing them.
 * `processedIds` is trimmed to the most recent PROCESSED_MAX.
 */
export async function saveRatchetAndProcessed(contactId, state, processedIds) {
    const db = await openDB()
    const trimmed = processedIds.length > PROCESSED_MAX ? processedIds.slice(-PROCESSED_MAX) : processedIds
    await idbPutMany(db, STORES.RATCHET, [
        [String(contactId), state],
        [processedKey(contactId), trimmed],
    ])
}

/** Load the persisted processed-message-id list for `contactId` (or []). */
export async function loadProcessedIds(contactId) {
    const db = await openDB()
    const ids = await idbGet(db, STORES.RATCHET, processedKey(contactId))
    return Array.isArray(ids) ? ids : []
}

/** Drop persisted state — used when a chat is deleted or keys are reset. */
export async function clearRatchet(contactId) {
    const db = await openDB()
    await idbDelete(db, STORES.RATCHET, String(contactId))
    await idbDelete(db, STORES.RATCHET, processedKey(contactId))
}

/** Drop all persisted ratchet state. Used on identity reset. */
export async function clearAllRatchets() {
    const db = await openDB()
    await idbClear(db, STORES.RATCHET)
}

/**
 * Run `fn` exclusively for this contact — serialized within this tab AND across
 * tabs. The lock name (`tg-ratchet-${contactId}`) is shared by the receive
 * pipeline (processContactInbox) and the send path (withRatchetLock) so an
 * inbound decrypt and an outbound encrypt for the same contact never interleave
 * on the ratchet state. `fn` is responsible for its own load/save.
 */
export function withContactLock(contactId, fn) {
    return withLock(`tg-ratchet-${contactId}`, fn)
}

/**
 * Thin load→fn→save wrapper for the send path: read current state, let `fn`
 * advance it (encrypt), persist the returned state. Shares withContactLock so
 * it's mutually exclusive with the receive pipeline. `fn` may return null to
 * leave the state unchanged.
 */
export function withRatchetLock(contactId, fn) {
    return withContactLock(contactId, async () => {
        const current = await loadRatchet(contactId)
        const next = await fn(current)
        if (next !== undefined && next !== null) {
            await saveRatchet(contactId, next)
        }
        return next
    })
}
