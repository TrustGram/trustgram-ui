const PREFIX = "tg_msgs_"

function toBase64(bytes) {
    return btoa(String.fromCharCode(...bytes))
}

function fromBase64(str) {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}

export async function loadMessages(contactId, storageKey) {
    const stored = localStorage.getItem(PREFIX + contactId)
    if (!stored) return []
    try {
        const { iv, data } = JSON.parse(stored)
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(iv) },
            storageKey,
            fromBase64(data)
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
    localStorage.setItem(PREFIX + contactId, JSON.stringify({
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(encrypted)),
    }))
}

export function clearMessages(contactId) {
    localStorage.removeItem(PREFIX + contactId)
}

export function clearAllMessages() {
    Object.keys(localStorage)
        .filter(k => k.startsWith(PREFIX))
        .forEach(k => localStorage.removeItem(k))
}
