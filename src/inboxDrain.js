import { acceptSession, decryptMessage } from "./crypto"
import { fetchInbox, deleteMessage } from "./api"
import { loadMessages, saveMessages } from "./messageStore"
import { consumeOTK } from "./storage"

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

function dedupKey(m) {
    return `${m.id}|${m.timestamp}`
}

// Stable order: ms timestamp first, then id (numeric-aware) as tie-breaker.
// See compareMessages in screens/Chat.jsx for rationale.
function compareMessages(x, y) {
    const dt = new Date(x.timestamp) - new Date(y.timestamp)
    if (dt !== 0) return dt
    return String(x.id).localeCompare(String(y.id), undefined, { numeric: true })
}

function mergeDedupe(a, b) {
    const seen = new Set(a.map(dedupKey))
    return [...a, ...b.filter(m => !seen.has(dedupKey(m)))].sort(compareMessages)
}

/**
 * Fetches all pending inbox messages, decrypts them with the current identity,
 * saves them to localStorage, and deletes them from the server.
 *
 * Call this before rotating the SPK so that no in-flight messages are lost.
 */
export async function drainInbox(identity, storageKey, initData) {
    const inbox = await fetchInbox(initData)
    if (!inbox.messages.length) return

    const bySender = {}
    for (const msg of inbox.messages) {
        if (!bySender[msg.sender_id]) bySender[msg.sender_id] = []
        bySender[msg.sender_id].push(msg)
    }

    for (const [senderIdStr, msgs] of Object.entries(bySender)) {
        const senderId = parseInt(senderIdStr, 10)
        const decrypted = []

        for (const msg of msgs) {
            try {
                const payload = JSON.parse(msg.encrypted_payload)
                if (payload.type && payload.type !== "message" && payload.type !== "file" && payload.type !== "message_zip") {
                    await deleteMessage(msg.id, initData).catch(() => {})
                    continue
                }
                const sessionState = await acceptSession(
                    identity,
                    payload.senderInfo.oneTimePreKeyId,
                    payload.senderInfo.identityKey,
                    payload.senderInfo.ephemeralKey,
                )
                const { plaintext } = await decryptMessage(sessionState, payload.message)
                if (payload.type === "file") {
                    const file = JSON.parse(plaintext)
                    decrypted.push({ id: msg.id, from: "them", file, text: null, timestamp: msg.timestamp })
                } else if (payload.type === "message_zip") {
                    const text = await decompressText(plaintext)
                    decrypted.push({ id: msg.id, from: "them", text, timestamp: msg.timestamp })
                } else {
                    decrypted.push({ id: msg.id, from: "them", text: plaintext, timestamp: msg.timestamp })
                }
                if (payload.senderInfo.oneTimePreKeyId) {
                    consumeOTK(payload.senderInfo.oneTimePreKeyId).catch(() => {})
                }
            } catch {}
            await deleteMessage(msg.id, initData).catch(() => {})
        }

        if (decrypted.length > 0 && storageKey) {
            const existing = await loadMessages(senderId, storageKey)
            await saveMessages(senderId, mergeDedupe(existing, decrypted), storageKey)
        }
    }
}
