const KEY = "tg_contacts"

function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]") } catch { return [] }
}

// Add or update a contact by id+name
export function saveContact(id, name) {
    const contacts = load()
    const existing = contacts.findIndex(c => c.id === id)
    if (existing >= 0) {
        contacts[existing].name = name
    } else {
        contacts.push({ id, name })
    }
    localStorage.setItem(KEY, JSON.stringify(contacts))
}

export function getContacts() {
    return load()
}

export function getContactName(id) {
    const found = load().find(c => c.id === id)
    return found ? found.name : String(id)
}
