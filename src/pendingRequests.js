const KEY = "tg_pending_out"

export function addPendingRequest(contactId, contactName) {
    const reqs = getPendingRequests()
    const idx = reqs.findIndex(r => r.contactId === contactId)
    const entry = { contactId, contactName, timestamp: Date.now() }
    if (idx >= 0) reqs[idx] = entry
    else reqs.push(entry)
    localStorage.setItem(KEY, JSON.stringify(reqs))
}

export function removePendingRequest(contactId) {
    const reqs = getPendingRequests().filter(r => r.contactId !== contactId)
    localStorage.setItem(KEY, JSON.stringify(reqs))
}

export function getPendingRequests() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]") } catch { return [] }
}
