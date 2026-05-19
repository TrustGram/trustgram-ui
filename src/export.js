import { getContacts, saveContact } from "./contacts"
import { loadMessages, saveMessages } from "./messageStore"

const to64 = b => btoa(String.fromCharCode(...b))
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

async function codeToKey(raw, usage) {
    const code = raw.replace(/\s/g, "")
    const keyMaterial = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]
    )
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: new TextEncoder().encode("trustgram_backup_v1"), iterations: 100000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        [usage]
    )
}

export async function exportSingleChat(contactId, contactName, storageKey) {
    const msgs = await loadMessages(contactId, storageKey)

    const bundle = JSON.stringify({
        version: 1,
        exported_at: new Date().toISOString(),
        contacts: [{ id: contactId, name: contactName }],
        messages: msgs.length > 0 ? { [String(contactId)]: msgs } : {},
    })

    const code = generateBackupCode()
    const key = await codeToKey(code, "encrypt")
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(bundle)
    )

    const payload = JSON.stringify({ version: 1, iv: to64(iv), data: to64(new Uint8Array(encrypted)) })
    return { payload, code: formatCode(code) }
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

    const code = generateBackupCode()
    const key = await codeToKey(code, "encrypt")
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(bundle)
    )

    const payload = JSON.stringify({ version: 1, iv: to64(iv), data: to64(new Uint8Array(encrypted)) })
    return { payload, code: formatCode(code) }
}

export async function importChats(payload, codeRaw, storageKey) {
    const key = await codeToKey(codeRaw, "decrypt")
    const { iv, data } = JSON.parse(payload)

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
