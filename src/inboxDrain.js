// Single source of truth for inbox processing.
//
// Both the open Chat's 4-second poll and the pre-SPK-rotation batch drain call
// processContactInbox, so there is exactly ONE fetch→decrypt→persist→ack
// pipeline (no divergent copies). Everything for a contact happens inside that
// contact's lock, in a crash-safe commit order:
//
//   history (appendMessages) → ratchet + processed-ids (one tx) → consumeOTK → delete
//
// Rationale for the order (see DESIGN_message_queue.md §2.4):
//   - History before ratchet: if the ratchet advanced but history didn't persist,
//     the message is "eaten" (won't replay) yet invisible to the user = loss.
//   - consumeOTK/delete after the ratchet commit: keep the OPK private key around
//     until the ratchet is durable, so a crash can still re-bootstrap the first
//     message; delete last so a re-delivery is re-acked, never re-decrypted.

import { acceptSessionAndDecryptFirstMessage, decryptMessage } from "./crypto"
import { fetchInbox, deleteMessage } from "./api"
import { appendMessages } from "./messageStore"
import { consumeOTK } from "./storage"
import { withContactLock, loadRatchet, saveRatchetAndProcessed, loadProcessedIds } from "./ratchetStore"

// Bounded retry for genuinely undecryptable blobs: after this many failed
// attempts in a session we stop re-trying a given id every poll (the server's
// post-fetch TTL is the ultimate reaper). In-memory on purpose — a reload
// grants each message one fresh attempt.
const MAX_DECRYPT_ATTEMPTS = 2
const _attempts = new Map() // msgId -> count

const KNOWN_TYPES = new Set(["message", "file", "message_zip"])

async function decompressText(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const stream = new DecompressionStream("deflate-raw")
    const w = stream.writable.getWriter()
    w.write(bytes); w.close()
    const chunks = []
    const r = stream.readable.getReader()
    for (;;) {
        const { done, value } = await r.read()
        if (done) break
        chunks.push(value)
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return new TextDecoder().decode(out)
}

/**
 * Decrypt one payload, driving/advancing `state`.
 *   - No state → X3DH bootstrap (acceptSessionAndDecryptFirstMessage tries the
 *     current SPK and each retired one, covering a sender that cached our
 *     pre-rotation bundle).
 *   - State → symmetric decrypt; if that fails but the sender shipped senderInfo,
 *     they likely restarted the session → re-bootstrap.
 * Returns { plaintext, nextState, consumedOtk }. consumedOtk (the OPK public key,
 * or null) is deferred by the caller to after the ratchet commit.
 */
async function decryptOne(state, payload, identity) {
    if (!state) {
        const res = await acceptSessionAndDecryptFirstMessage(identity, payload.senderInfo, payload.message)
        return { plaintext: res.plaintext, nextState: res.state, consumedOtk: payload.senderInfo?.oneTimePreKeyId ?? null }
    }
    try {
        const res = await decryptMessage(state, payload.message)
        return { plaintext: res.plaintext, nextState: res.state, consumedOtk: null }
    } catch (e) {
        if (payload.senderInfo) {
            const res = await acceptSessionAndDecryptFirstMessage(identity, payload.senderInfo, payload.message)
            return { plaintext: res.plaintext, nextState: res.state, consumedOtk: payload.senderInfo.oneTimePreKeyId ?? null }
        }
        throw e
    }
}

async function toUiMessage(msg, payload, plaintext) {
    if (payload.type === "file") {
        return { id: msg.id, from: "them", file: JSON.parse(plaintext), text: null, timestamp: msg.timestamp }
    }
    if (payload.type === "message_zip") {
        return { id: msg.id, from: "them", text: await decompressText(plaintext), timestamp: msg.timestamp }
    }
    return { id: msg.id, from: "them", text: plaintext, timestamp: msg.timestamp }
}

/**
 * Process one contact's inbox end-to-end inside a single per-contact critical
 * section. Returns the freshly-decrypted UI messages (including placeholders for
 * failures) so an open Chat can merge them into memory — the durable
 * persistence has already happened here.
 *
 * @param contactId sender/recipient telegram id
 * @param ctx { identity, storageKey, initData, onDebug? }
 */
export async function processContactInbox(contactId, ctx) {
    const { identity, storageKey, initData, onDebug } = ctx
    const decryptedUi = []

    await withContactLock(contactId, async () => {
        const state0 = await loadRatchet(contactId)
        const processed = new Set(await loadProcessedIds(contactId))

        // Fetch INSIDE the lock: any probe the caller did may be stale by now.
        // Whoever holds the lock deletes its messages before the next holder
        // fetches, so the same ciphertext is never decrypted twice.
        const inbox = await fetchInbox(initData)
        const mine = inbox.messages.filter(m => m.sender_id === contactId)
        if (inbox.messages.length > 0) onDebug?.(`inbox: ${inbox.messages.length} msg, mine: ${mine.length}`)

        let state = state0
        let changed = false
        const toPersist = []    // successful 'them' messages → durable history
        const otkToConsume = [] // OPK public keys → consumeOTK AFTER ratchet commit
        const ack = []          // message ids to delete — only after persist

        for (const msg of mine) {
            if (processed.has(msg.id)) { ack.push(msg.id); continue }          // already eaten → just re-ack
            if ((_attempts.get(msg.id) ?? 0) >= MAX_DECRYPT_ATTEMPTS) continue // gave up → leave to server TTL

            let payload
            try {
                payload = JSON.parse(msg.encrypted_payload)
            } catch {
                ack.push(msg.id); continue // not our envelope → deliberate discard
            }

            // Deliberate discards (delete is correct — never processable):
            if (payload.type && !KNOWN_TYPES.has(payload.type)) { ack.push(msg.id); continue }
            if (!state && !payload.senderInfo) { ack.push(msg.id); continue }

            try {
                const { plaintext, nextState, consumedOtk } = await decryptOne(state, payload, identity)
                state = nextState
                changed = true
                const ui = await toUiMessage(msg, payload, plaintext)
                decryptedUi.push(ui)
                toPersist.push(ui)
                processed.add(msg.id)
                ack.push(msg.id)
                if (consumedOtk) otkToConsume.push(consumedOtk)
                onDebug?.(`✓ decrypt #${msg.id}`)
            } catch (err) {
                _attempts.set(msg.id, (_attempts.get(msg.id) ?? 0) + 1)
                onDebug?.(`✗ decrypt #${msg.id}: ${err?.message?.slice(0, 40) ?? "?"}`)
                // Keep on the server (may be recoverable). Show a placeholder in
                // memory ONLY — persisting it would poison dedupe for the real
                // message on the same id, and a reload retries anyway.
                decryptedUi.push({
                    id: msg.id, from: "them",
                    text: `🔒 [не удалось расшифровать: ${err?.message?.slice(0, 50) ?? "?"}]`,
                    timestamp: msg.timestamp,
                })
            }
        }

        // ── Commit in crash-safe order ──
        if (toPersist.length) await appendMessages(contactId, toPersist, storageKey)
        if (changed) await saveRatchetAndProcessed(contactId, state, [...processed])
        for (const opk of otkToConsume) await consumeOTK(opk)
        for (const id of ack) await deleteMessage(id, initData).catch(() => {})
    })

    return decryptedUi
}

/**
 * Drain every sender's inbox (call before rotating the SPK so no messages are
 * left pending under the old key). Probe once to discover senders, then run each
 * through the same per-contact pipeline.
 *
 * @param ctx { identity, storageKey, initData }
 */
export async function drainAllInbox(ctx) {
    const probe = await fetchInbox(ctx.initData)
    if (!probe.messages.length) return
    const senderIds = [...new Set(probe.messages.map(m => m.sender_id))]
    for (const senderId of senderIds) {
        await processContactInbox(senderId, ctx)
    }
}
