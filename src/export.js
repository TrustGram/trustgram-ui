import { getContacts, saveContact } from "./contacts"
import { loadMessages, saveMessages } from "./messageStore"

// Chunked to avoid RangeError on mobile for large backups (file-bearing chats).
function to64(b) {
    let binary = ""
    const CHUNK = 8192
    for (let i = 0; i < b.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK))
    }
    return btoa(binary)
}
const from64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

function generateBackupCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    let digits = ""
    for (const byte of bytes) digits += byte.toString().padStart(3, "0")
    return digits.slice(0, 30)
}

export function formatCode(raw) {
    return raw.replace(/\s/g, "").match(/.{5}/g)?.join(" ") ?? raw
}

// Match storage.js — the same PBKDF2 cost the runtime is already willing to
// pay on unlock. The previous 100k was both lower than that and used a hard-
// coded salt, so a single rainbow table would have covered every TrustGram
// backup ever made.
const EXPORT_PBKDF2_ITERATIONS = 600_000
// Legacy parameters — only used to decrypt backups created by builds before
// the random-salt change. New exports always use a per-payload random salt.
const LEGACY_SALT = new TextEncoder().encode("trustgram_backup_v1")
const LEGACY_ITERATIONS = 100_000

async function codeToKey(raw, usage, salt, iterations) {
    const code = raw.replace(/\s/g, "")
    const keyMaterial = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]
    )
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        [usage]
    )
}

async function buildEncryptedPayload(bundle) {
    const code = generateBackupCode()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const key = await codeToKey(code, "encrypt", salt, EXPORT_PBKDF2_ITERATIONS)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(bundle)
    )

    // version: 2 — adds explicit salt + iterations alongside iv/data. Older
    // backups (version: 1) are still importable via the legacy params below.
    const payload = JSON.stringify({
        version: 2,
        iv: to64(iv),
        data: to64(new Uint8Array(encrypted)),
        salt: to64(salt),
        iterations: EXPORT_PBKDF2_ITERATIONS,
    })
    return { payload, code: formatCode(code) }
}

export async function exportSingleChat(contactId, contactName, storageKey) {
    const msgs = await loadMessages(contactId, storageKey)
    const bundle = JSON.stringify({
        version: 1,
        exported_at: new Date().toISOString(),
        contacts: [{ id: contactId, name: contactName }],
        messages: msgs.length > 0 ? { [String(contactId)]: msgs } : {},
    })
    return buildEncryptedPayload(bundle)
}

export async function exportChats(storageKey) {
    const contacts = getContacts()
    const messages = {}
    for (const contact of contacts) {
        const msgs = await loadMessages(contact.id, storageKey)
        if (msgs.length > 0) messages[String(contact.id)] = msgs
    }
    const bundle = JSON.stringify({
        version: 1,
        exported_at: new Date().toISOString(),
        contacts,
        messages,
    })
    return buildEncryptedPayload(bundle)
}

export async function importChats(payload, codeRaw, storageKey) {
    const parsed = JSON.parse(payload)
    const { iv, data } = parsed
    // v2 payloads carry their own salt + iteration count. v1 (legacy) must
    // be decrypted with the original hardcoded params or the user's old
    // backups won't import after the upgrade.
    const useV2 = parsed.version === 2 && typeof parsed.salt === "string"
    const salt = useV2 ? from64(parsed.salt) : LEGACY_SALT
    const iterations = useV2 && Number.isInteger(parsed.iterations)
        ? parsed.iterations
        : LEGACY_ITERATIONS
    const key = await codeToKey(codeRaw, "decrypt", salt, iterations)

    let decrypted
    try {
        decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: from64(iv) },
            key,
            from64(data)
        )
    } catch {
        throw new Error("Wrong backup code or corrupted file")
    }

    const bundle = JSON.parse(new TextDecoder().decode(decrypted))
    if (!bundle.version || !bundle.contacts || !bundle.messages) throw new Error("Invalid backup file")

    for (const contact of bundle.contacts) saveContact(contact.id, contact.name)
    for (const [contactId, msgs] of Object.entries(bundle.messages)) {
        await saveMessages(parseInt(contactId, 10), msgs, storageKey)
    }

    return bundle.contacts.length
}
