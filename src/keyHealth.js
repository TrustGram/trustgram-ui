// Shared OTK refill helper. Used both from App.jsx (boot-time health check) and
// Chat.jsx (lazy refill after consuming an OTK). Two responsibilities:
//
//   1. Cross-tab exclusion via navigator.locks. Without this, two open tabs see
//      the same low server count and both upload a fresh batch — duplicate
//      key_ids hit the UNIQUE(user_id, key_id) constraint on the server.
//   2. Collision-free key_ids. We use crypto.randomUUID() so even concurrent
//      uploads from different devices can't collide.

import { fetchOTKCount, refillOTKs } from "./api"
import { appendOTKsToIdentity } from "./storage"

const OTK_LOCK = "trustgram:otk-refill"

function makeKeyId() {
    if (crypto.randomUUID) return crypto.randomUUID()
    // Fallback for ancient browsers — still random, just not RFC-shaped.
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
}

async function generateBatch(size) {
    const pairs = await Promise.all(
        Array.from({ length: size }, () =>
            crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"])
        )
    )
    return Promise.all(
        pairs.map(async kp => {
            const raw = await crypto.subtle.exportKey("raw", kp.publicKey)
            const pub = btoa(String.fromCharCode(...new Uint8Array(raw)))
            return { key_id: makeKeyId(), public_key: pub, keyPair: kp }
        })
    )
}

/**
 * Run `task` while holding the OTK-refill web lock. If another tab already has
 * it, returns null without waiting. Falls back to running without a lock on
 * browsers that don't expose navigator.locks (older Safari).
 */
async function withOtkLock(task) {
    if (!navigator.locks) return task()
    return navigator.locks.request(OTK_LOCK, { ifAvailable: true }, async lock => {
        if (!lock) return null  // another tab is already refilling
        return task()
    })
}

/**
 * Refill the server-side OTK pool if it's below `threshold`.
 *   - cross-tab exclusive via navigator.locks
 *   - persists private keys locally BEFORE uploading public ones, so a crash
 *     mid-upload yields orphan-server-keys (recoverable) rather than orphan-
 *     local-keys (unrecoverable inbound decryption failures).
 *   - returns true if a refill actually happened, false otherwise.
 */
export async function refillIfLow({ threshold = 5, batchSize = 20, initData }) {
    return (await withOtkLock(async () => {
        const { count } = await fetchOTKCount(initData)
        if (count >= threshold) return false
        const batch = await generateBatch(batchSize)
        await appendOTKsToIdentity(batch.map(b => b.keyPair))
        await refillOTKs(batch.map(({ key_id, public_key }) => ({ key_id, public_key })), initData)
        return true
    })) ?? false
}
