const API_URL = import.meta.env.VITE_API_URL

function headers(initData) {
    return {
        "Content-Type": "application/json",
        ...(initData ? { "X-Init-Data": initData } : {}),
    }
}

export async function registerBundle(bundle, initData) {
    const res = await fetch(`${API_URL}/api/v1/keys/register`, {
        method: "POST",
        headers: headers(initData),
        body: JSON.stringify(bundle),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export async function fetchBundle(telegramId, initData) {
    const res = await fetch(`${API_URL}/api/v1/keys/${telegramId}`, {
        headers: headers(initData),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export async function fetchInbox(initData) {
    const res = await fetch(`${API_URL}/api/v1/chat/inbox`, {
        headers: headers(initData),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export async function sendMessage(recipientId, encryptedPayload, initData) {
    const res = await fetch(`${API_URL}/api/v1/chat/send`, {
        method: "POST",
        headers: headers(initData),
        body: JSON.stringify({ recipient_id: recipientId, encrypted_payload: encryptedPayload }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export async function deleteMessage(messageId, initData) {
    const res = await fetch(`${API_URL}/api/v1/chat/message/${messageId}`, {
        method: "DELETE",
        headers: headers(initData),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}
