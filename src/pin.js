// PIN verification + protection of the storage key is owned by storage.js
// (the PIN's job is to unwrap the storage-key blob). This module is now
// just lock-policy state: when to lock, when last activity was, etc.

const INTERVAL_KEY = "tg_lock_interval"
const LAST_ACTIVITY_KEY = "tg_last_activity"

// Re-export hasPin from storage so existing imports keep working.
import { hasPin as _hasPin } from "./storage"
export const hasPin = _hasPin

// null = never lock, 0 = immediately, N = milliseconds.
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

export function clearLockState() {
    localStorage.removeItem(INTERVAL_KEY)
    localStorage.removeItem(LAST_ACTIVITY_KEY)
}

export function shouldLockOnOpen() {
    if (!_hasPin()) return false
    const interval = getLockInterval()
    if (interval === null) return false
    if (interval === 0) return true
    const last = parseInt(localStorage.getItem(LAST_ACTIVITY_KEY) || "0", 10)
    return Date.now() - last > interval
}
