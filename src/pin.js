const PIN_KEY = "tg_pin"
const INTERVAL_KEY = "tg_lock_interval"
const LAST_ACTIVITY_KEY = "tg_last_activity"

const from64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const to64 = b => btoa(String.fromCharCode(...b))

async function deriveKey(pin, salt, usage) {
    const keyMaterial = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]
    )
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        [usage]
    )
}

export async function setPin(pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await deriveKey(pin, salt, "encrypt")
    const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode("trustgram_unlock")
    )
    localStorage.setItem(PIN_KEY, JSON.stringify({
        salt: to64(salt), iv: to64(iv), data: to64(new Uint8Array(data)),
    }))
}

export async function verifyPin(pin) {
    const stored = JSON.parse(localStorage.getItem(PIN_KEY) || "null")
    if (!stored) return false
    try {
        const key = await deriveKey(pin, from64(stored.salt), "decrypt")
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: from64(stored.iv) },
            key,
            from64(stored.data)
        )
        return new TextDecoder().decode(decrypted) === "trustgram_unlock"
    } catch {
        return false
    }
}

export function hasPin() {
    return !!localStorage.getItem(PIN_KEY)
}

export function clearPin() {
    localStorage.removeItem(PIN_KEY)
}

// null = never lock, 0 = immediately, N = milliseconds
export function getLockInterval() {
    const val = localStorage.getItem(INTERVAL_KEY)
    if (val === null) return 0
    if (val === "never") return null
    return parseInt(val, 10)
}

export function setLockInterval(ms) {
    localStorage.setItem(INTERVAL_KEY, ms === null ? "never" : String(ms))
}

export function updateLastActivity() {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()))
}

export function shouldLockOnOpen() {
    if (!hasPin()) return false
    const interval = getLockInterval()
    if (interval === null) return false
    if (interval === 0) return true
    const last = parseInt(localStorage.getItem(LAST_ACTIVITY_KEY) || "0", 10)
    return Date.now() - last > interval
}
