import { openDB, idbGet, idbPut, idbDelete, STORES } from "./idb"

// IDB keys (in the IDENTITY store):
//   identity              — full IdentityKeyBundle
//   storage_key_raw       — Uint8Array(32), used when no PIN is set
//   storage_key_encrypted — { salt, iv, data, iterations }, used when PIN is set
//   storage_key           — legacy non-extractable CryptoKey from earlier builds
//   pending_spk           — interrupted-rotation recovery record
//   spk_rotated_at        — last-successful-SPK-rotation timestamp (number)
//   otk_last_check        — last OTK-refill-poll timestamp (number)
//   pin_attempts          — { count, lockedUntil } — survives reload, used for cooldown
//
// `tg_has_pin` is mirrored to localStorage purely so hasPin() can be a
// synchronous boolean — render paths can't await an IDB read. It's just a
// non-secret presence flag.
const LS_HAS_PIN = "tg_has_pin"
const LS_SPK_ROTATED_AT = "tg_spk_rotated_at"  // legacy — migrated to IDB
const LS_OTK_LAST_CHECK = "tg_otk_last_check"  // legacy — migrated to IDB

const IDENTITY = STORES.IDENTITY

const PBKDF2_ITERATIONS = 600000

// Chunked base64 — see messageStore.js for rationale.
function bytesToBase64(bytes) {
    let binary = ""
    const CHUNK = 8192
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
}

// ── Identity ──────────────────────────────────────────────────

export async function saveIdentity(identity) {
    const db = await openDB()
    await idbPut(db, IDENTITY, "identity", identity)
}

export async function loadIdentity() {
    const db = await openDB()
    return idbGet(db, IDENTITY, "identity")
}

export async function clearIdentity() {
    const db = await openDB()
    await idbDelete(db, IDENTITY, "identity")
    await idbDelete(db, IDENTITY, "storage_key")
    await idbDelete(db, IDENTITY, "storage_key_raw")
    await idbDelete(db, IDENTITY, "storage_key_encrypted")
    await idbDelete(db, IDENTITY, "pending_spk")
    await idbDelete(db, IDENTITY, "spk_rotated_at")
    await idbDelete(db, IDENTITY, "otk_last_check")
    await idbDelete(db, IDENTITY, "pin_attempts")
    localStorage.removeItem(LS_HAS_PIN)
    localStorage.removeItem(LS_SPK_ROTATED_AT)
    localStorage.removeItem(LS_OTK_LAST_CHECK)
}

// SPK rotation history. We keep a small window of previously-active SPK
// keypairs so messages encrypted by senders that cached our pre-rotation
// bundle can still be decrypted. Tuned to the rotation cadence:
//   SPK rotates every 7 days → 4 entries covers ~4 weeks of in-flight grace.
//
// Pruned by both count and age — a sender that cached our bundle a month ago
// has bigger problems than a missed message.
const OLD_SPK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const OLD_SPK_MAX_ENTRIES = 4

function pruneOldSpks(list) {
    const now = Date.now()
    return list
        .filter(e => e?.keyPair && now - (e.retiredAt ?? 0) < OLD_SPK_MAX_AGE_MS)
        .slice(0, OLD_SPK_MAX_ENTRIES)
}

export async function updateSPKInIdentity(newSpkKeyPair) {
    const db = await openDB()
    const identity = await idbGet(db, IDENTITY, "identity")
    if (!identity) return
    const previousSpk = identity.signedPreKey
    // Push the outgoing SPK onto the front of the history before replacing it,
    // so the next acceptSession can still try it.
    const prev = Array.isArray(identity.oldSignedPreKeys) ? identity.oldSignedPreKeys : []
    identity.oldSignedPreKeys = pruneOldSpks([
        { keyPair: previousSpk, retiredAt: Date.now() },
        ...prev,
    ])
    identity.signedPreKey = newSpkKeyPair
    await idbPut(db, IDENTITY, "identity", identity)
}

// ── Pending SPK (crash-safe rotation) ─────────────────────────
// During SPK rotation we must keep the new private key locally even if the
// server upload is interrupted — otherwise a partial rotation leaves the
// server advertising a public SPK whose private half is gone.
//
// Flow:
//   1. Generate new SPK pair + signature.
//   2. savePendingSPK(...)               ← atomic IDB write of the pair
//   3. updateSPK(server, pub, signature)  ← if this fails, we retry on next boot
//   4. updateSPKInIdentity(pair)          ← promote pending to current
//   5. clearPendingSPK()
//
// On boot, if a pending SPK exists, we retry steps 3-5.

export async function savePendingSPK(record) {
    const db = await openDB()
    await idbPut(db, IDENTITY, "pending_spk", record)
}

export async function loadPendingSPK() {
    const db = await openDB()
    return idbGet(db, IDENTITY, "pending_spk")
}

export async function clearPendingSPK() {
    const db = await openDB()
    await idbDelete(db, IDENTITY, "pending_spk")
}

// ── Rotation-cadence timestamps (moved from localStorage) ────
// Stored alongside identity material so a partial localStorage clear can't
// reset rotation cadences and force unnecessary or skipped rotations.

async function getTimestamp(db, idbKey, legacyLsKey) {
    const stored = await idbGet(db, IDENTITY, idbKey)
    if (typeof stored === "number") return stored
    // One-time migration from localStorage.
    const legacy = localStorage.getItem(legacyLsKey)
    if (!legacy) return 0
    const ts = parseInt(legacy, 10) || 0
    await idbPut(db, IDENTITY, idbKey, ts)
    localStorage.removeItem(legacyLsKey)
    return ts
}

async function setTimestamp(db, idbKey, value) {
    await idbPut(db, IDENTITY, idbKey, value)
}

export async function getSpkRotatedAt() {
    return getTimestamp(await openDB(), "spk_rotated_at", LS_SPK_ROTATED_AT)
}

export async function setSpkRotatedAt(value) {
    return setTimestamp(await openDB(), "spk_rotated_at", value)
}

export async function getOtkLastCheck() {
    return getTimestamp(await openDB(), "otk_last_check", LS_OTK_LAST_CHECK)
}

export async function setOtkLastCheck(value) {
    return setTimestamp(await openDB(), "otk_last_check", value)
}

export async function appendOTKsToIdentity(newPairs) {
    const db = await openDB()
    const identity = await idbGet(db, IDENTITY, "identity")
    if (!identity) return
    identity.oneTimePreKeys = [...identity.oneTimePreKeys, ...newPairs]
    await idbPut(db, IDENTITY, "identity", identity)
}

/**
 * Remove the local OPK that matches the given public key.
 *
 * Note: despite being called `oneTimePreKeyId` on the wire (X3DHSenderBundle),
 * the caller passes the OPK's *public key* in base64 — there is no separate ID
 * in WebCrypto for non-extractable keys. This function compares the raw
 * exported public bytes of each stored OPK against the value.
 */
export async function consumeOTK(usedPublicKeyB64) {
    const db = await openDB()
    const identity = await idbGet(db, IDENTITY, "identity")
    if (!identity) return
    const filtered = []
    for (const kp of identity.oneTimePreKeys) {
        const raw = await crypto.subtle.exportKey("raw", kp.publicKey)
        const pub = bytesToBase64(new Uint8Array(raw))
        if (pub !== usedPublicKeyB64) filtered.push(kp)
    }
    identity.oneTimePreKeys = filtered
    await idbPut(db, IDENTITY, "identity", identity)
}

// ── Storage key (message-history KEK) ─────────────────────────

async function importKeyBytes(bytes) {
    return crypto.subtle.importKey(
        "raw", bytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    )
}

async function derivePinKey(pin, salt, iterations) {
    const material = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]
    )
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    )
}

/**
 * Mode of the locally-stored storage key.
 *   "encrypted" — PIN required to unlock
 *   "raw"       — readable directly (no PIN)
 *   "legacy"    — old non-extractable CryptoKey from pre-binding builds
 *   "none"      — nothing stored yet
 */
export async function getStorageKeyMode() {
    const db = await openDB()
    if (await idbGet(db, IDENTITY, "storage_key_encrypted")) return "encrypted"
    if (await idbGet(db, IDENTITY, "storage_key_raw")) return "raw"
    if (await idbGet(db, IDENTITY, "storage_key")) return "legacy"
    return "none"
}

/**
 * Returns the storage CryptoKey for callers who don't need PIN handling
 * (i.e. there is no PIN, or we're using the legacy non-extractable key).
 * Returns null if the storage key is PIN-protected — caller must use unlockStorageKey.
 */
export async function getUnencryptedStorageKey() {
    const db = await openDB()

    const raw = await idbGet(db, IDENTITY, "storage_key_raw")
    if (raw) return { storageKey: await importKeyBytes(raw), rawBytes: raw }

    const legacy = await idbGet(db, IDENTITY, "storage_key")
    if (legacy) return { storageKey: legacy, rawBytes: null }

    if (await idbGet(db, IDENTITY, "storage_key_encrypted")) return null

    // Fresh install — generate a new random key.
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    await idbPut(db, IDENTITY, "storage_key_raw", bytes)
    return { storageKey: await importKeyBytes(bytes), rawBytes: bytes }
}

/**
 * Try to unlock the PIN-encrypted storage key.
 * @returns { storageKey, rawBytes } on success, null on wrong PIN.
 */
export async function unlockStorageKey(pin) {
    const db = await openDB()
    const blob = await idbGet(db, IDENTITY, "storage_key_encrypted")
    if (!blob) return null
    try {
        const kek = await derivePinKey(pin, blob.salt, blob.iterations || PBKDF2_ITERATIONS)
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: blob.iv },
            kek,
            blob.data
        )
        const rawBytes = new Uint8Array(plain)
        return { storageKey: await importKeyBytes(rawBytes), rawBytes }
    } catch {
        return null
    }
}

/**
 * Enable PIN protection: encrypts the provided raw storage-key bytes under a
 * PIN-derived KEK and removes the raw copy. Caller must pass the bytes from
 * the currently-unlocked session — we cannot extract them from a legacy or
 * already-encrypted key.
 *
 * `pinLength` is persisted in the blob so PinLock knows when the user has
 * finished entering — 4 by default for backward compatibility with installs
 * that pre-date the choice.
 */
export async function bindStorageKeyToPin(pin, rawBytes, pinLength = 4) {
    if (!rawBytes) throw new Error("Cannot enable PIN: storage key bytes unavailable (legacy install — please reset keys)")
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const kek = await derivePinKey(pin, salt, PBKDF2_ITERATIONS)
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, rawBytes)
    const db = await openDB()
    await idbPut(db, IDENTITY, "storage_key_encrypted", {
        salt, iv, data, iterations: PBKDF2_ITERATIONS,
        pin_length: pinLength,
    })
    await idbDelete(db, IDENTITY, "storage_key_raw")
    localStorage.setItem(LS_HAS_PIN, "1")
}

/** Re-encrypt the storage key under a new PIN (rotate). May also change length. */
export async function rebindStorageKeyToPin(newPin, rawBytes, pinLength = 4) {
    await bindStorageKeyToPin(newPin, rawBytes, pinLength)
}

/**
 * Read the length of the currently-bound PIN. Returns 4 (the historical
 * default) when no PIN is set or for blobs from builds that pre-date the
 * length being stored.
 */
export async function getPinLength() {
    const db = await openDB()
    const blob = await idbGet(db, IDENTITY, "storage_key_encrypted")
    return blob?.pin_length === 6 ? 6 : 4
}

/** Disable PIN protection: persist the raw bytes again, drop the encrypted blob. */
export async function unbindStorageKeyFromPin(rawBytes) {
    if (!rawBytes) throw new Error("Cannot disable PIN without the unlocked storage-key bytes")
    const db = await openDB()
    await idbPut(db, IDENTITY, "storage_key_raw", rawBytes)
    await idbDelete(db, IDENTITY, "storage_key_encrypted")
    await idbDelete(db, IDENTITY, "pin_attempts")
    localStorage.removeItem(LS_HAS_PIN)
}

// ── PIN brute-force cooldown ──────────────────────────────────
// React state for the attempts counter was a paper limit — a reload reset it
// to 0. Persist count + lockedUntil in IDB so an in-app brute-forcer can't
// just refresh to keep trying.
//
// Ladder (count = total failures since last success):
//   <5        — no cooldown
//   5         — 1 minute
//   6..9      — doubles each: 2m, 4m, 8m, 16m
//   10..19    — (n − 9) hours: 1h, 2h, …, 10h
//   >=20      — 24h cap
//
// Reset to 0 on successful unlock. Cleared on reset-keys / PIN-disable.

function cooldownMs(count) {
    if (count < 5) return 0
    if (count < 10) return 60_000 * Math.pow(2, count - 5)
    if (count < 20) return 3_600_000 * (count - 9)
    return 24 * 3_600_000
}

export async function getPinAttemptState() {
    const db = await openDB()
    const stored = await idbGet(db, IDENTITY, "pin_attempts")
    return stored || { count: 0, lockedUntil: 0 }
}

export async function recordPinFailure() {
    const db = await openDB()
    const prev = (await idbGet(db, IDENTITY, "pin_attempts")) || { count: 0, lockedUntil: 0 }
    const count = prev.count + 1
    const cd = cooldownMs(count)
    const state = { count, lockedUntil: cd > 0 ? Date.now() + cd : 0 }
    await idbPut(db, IDENTITY, "pin_attempts", state)
    return state
}

export async function resetPinAttempts() {
    const db = await openDB()
    await idbDelete(db, IDENTITY, "pin_attempts")
}

/**
 * Synchronous PIN-existence check used by UI guards. Backed by a localStorage
 * mirror of the IDB state — kept in sync by bind/unbind/clear.
 */
export function hasPin() {
    return localStorage.getItem(LS_HAS_PIN) === "1"
}
