const KEY = "tg_contacts"

function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}") } catch { return {} }
}

function save(contacts) {
    localStorage.setItem(KEY, JSON.stringify(contacts))
}

export function saveContact(telegramId, username) {
    if (!username) return
    const contacts = load()
    contacts[telegramId] = username
    save(contacts)
}

export function getContactName(telegramId) {
    const contacts = load()
    return contacts[telegramId] ? `@${contacts[telegramId]}` : String(telegramId)
}
