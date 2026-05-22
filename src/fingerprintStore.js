// TOFU (Trust On First Use) fingerprint pinning.
//
// The signed_pre_key bundle the server hands us is only trustworthy if we
// already know the contact's long-term identity. Without pinning, a malicious
// server could swap any new contact's bundle for an attacker-controlled one
// (same shape, different keys) and we'd happily encrypt under it. The SPK
// ECDSA signature only proves "whoever wrote this bundle controls *some*
// signingKey" — the attacker's own, in that case.
//
// Defence: on the first session with a contact, compute the fingerprint of
// (their identityKey + their signingKey), pin it under contactId. On every
// subsequent session, recompute and compare. Mismatch = either the contact
// rotated identity (reinstall / "reset keys"), or someone is MITM-ing — the
// caller must require explicit user re-confirmation before proceeding.
//
// We pin only on outgoing-first sessions, because senderInfo on incoming
// messages contains identityKey but *not* signingKey — we'd need an extra
// bundle fetch to compute the full fingerprint. Inbound-only contacts get
// pinned the first time the user opens Safety Numbers or replies. This is
// a deliberate trade-off: the FP-comparison-on-send blocks the highest-impact
// attack (server swaps Bob's bundle for Mallory's when Alice reaches out).

import { openDB, idbGet, idbPut, idbDelete, idbClear, STORES } from "./idb"

export async function loadFingerprint(contactId) {
    const db = await openDB()
    return idbGet(db, STORES.FINGERPRINTS, String(contactId))
}

export async function saveFingerprint(contactId, fingerprintHex) {
    const db = await openDB()
    await idbPut(db, STORES.FINGERPRINTS, String(contactId), {
        fingerprint: fingerprintHex,
        pinnedAt: Date.now(),
    })
}

export async function clearFingerprint(contactId) {
    const db = await openDB()
    await idbDelete(db, STORES.FINGERPRINTS, String(contactId))
}

export async function clearAllFingerprints() {
    const db = await openDB()
    await idbClear(db, STORES.FINGERPRINTS)
}

/**
 * Compare `computedHex` to the pinned fingerprint for `contactId`.
 *
 * Returns one of:
 *   "new"                                     — nothing pinned yet
 *   "match"                                   — pin matches
 *   { mismatch: true, pinned, pinnedAt }      — pin exists but differs
 *
 * The caller decides what to do with each result. The intended flow is:
 *   "new"      → pin silently, proceed
 *   "match"    → proceed
 *   "mismatch" → block, surface a modal, only update pin on explicit user OK
 */
export async function verifyFingerprint(contactId, computedHex) {
    const stored = await loadFingerprint(contactId)
    if (!stored) return "new"
    if (stored.fingerprint === computedHex) return "match"
    return { mismatch: true, pinned: stored.fingerprint, pinnedAt: stored.pinnedAt }
}
