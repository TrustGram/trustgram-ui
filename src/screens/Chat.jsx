import React, { useEffect, useRef, useState } from "react"
import { Spinner, Placeholder } from "@telegram-apps/telegram-ui"
import { initiateSession, encryptMessage, decryptMessage, acceptSession } from "../crypto"
import { fetchBundle, fetchInbox, sendMessage, deleteMessage } from "../api"
import { loadMessages, saveMessages } from "../messageStore"

function getInitData() {
    return window.Telegram?.WebApp?.initData || null
}

export default function Chat({ identity, storageKey, contactId, contactName, onBack }) {
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState(null)
    const bottomRef = useRef(null)
    const inputRef = useRef(null)
    const messagesRef = useRef([])
    const initData = getInitData()

    function updateMessages(msgs) {
        messagesRef.current = msgs
        setMessages(msgs)
        if (storageKey) saveMessages(contactId, msgs, storageKey).catch(() => {})
    }

    useEffect(() => {
        loadHistory().then(() => {
            const interval = setInterval(pollMessages, 4000)
            return () => clearInterval(interval)
        })
    }, [])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    async function loadHistory() {
        setLoading(true)
        try {
            const [history, inbox] = await Promise.all([
                storageKey ? loadMessages(contactId, storageKey) : Promise.resolve([]),
                fetchInbox(initData),
            ])
            const decrypted = await decryptInboxMessages(inbox.messages)
            const merged = mergeDedupe(history, decrypted)
            updateMessages(merged)
        } catch (e) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }

    async function pollMessages() {
        try {
            const inbox = await fetchInbox(initData)
            const decrypted = await decryptInboxMessages(inbox.messages)
            if (decrypted.length > 0) {
                const merged = mergeDedupe(messagesRef.current, decrypted)
                updateMessages(merged)
            }
        } catch {}
    }

    // Merge two message arrays, deduplicate by id, keep chronological order
    function mergeDedupe(existing, incoming) {
        const seen = new Set(existing.map(m => m.id))
        const novel = incoming.filter(m => !seen.has(m.id))
        return [...existing, ...novel].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    }

    async function decryptInboxMessages(msgs) {
        const mine = msgs.filter(m => m.sender_id === contactId)
        const decrypted = []

        for (const msg of mine) {
            try {
                const payload = JSON.parse(msg.encrypted_payload)

                if (payload.type && payload.type !== "message") {
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
                decrypted.push({ id: msg.id, from: "them", text: plaintext, timestamp: msg.timestamp })
                await deleteMessage(msg.id, initData)
            } catch {
                await deleteMessage(msg.id, initData).catch(() => {})
            }
        }
        return decrypted
    }

    async function handleSend() {
        if (!input.trim()) return
        setSending(true)
        setError(null)
        const text = input.trim()
        const timestamp = new Date().toISOString()
        const tempId = `me_${Date.now()}`
        setInput("")
        inputRef.current?.focus()
        try {
            const optimistic = [...messagesRef.current, { id: tempId, from: "me", text, timestamp }]
            updateMessages(optimistic)

            const bundle = await fetchBundle(contactId, initData)
            const { state: sessionState, senderInfo } = await initiateSession(identity, {
                identityKey: bundle.identity_key,
                signedPreKey: bundle.signed_pre_key,
                oneTimePreKey: bundle.one_time_key?.public_key ?? null,
            })
            const { message } = await encryptMessage(sessionState, text)
            await sendMessage(contactId, JSON.stringify({ type: "message", senderInfo, message }), initData)
        } catch (e) {
            setError(e.message)
        } finally {
            setSending(false)
        }
    }

    function handleKeyDown(e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
    }

    const displayName = contactName ?? String(contactId)
    const initials = displayName.replace(/^@/, "").slice(0, 2).toUpperCase()

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#17212b" }}>

            {/* Header */}
            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, background: "#1f2b38", borderBottom: "1px solid #2a3a4a", flexShrink: 0 }}>
                <button onClick={onBack} style={{ background: "none", border: "none", color: "#6ab3f3", fontSize: 22, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>
                    ←
                </button>
                <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#2b5278", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                    {initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
                    <div style={{ fontSize: 11, color: "#6ab3f3" }}>🔒 End-to-end encrypted</div>
                </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {loading ? (
                    <div style={{ display: "flex", justifyContent: "center", marginTop: 40 }}><Spinner size="l" /></div>
                ) : messages.length === 0 ? (
                    <Placeholder description="No messages yet. Say hello!" />
                ) : (
                    messages.map(msg => (
                        <div key={msg.id} style={{ display: "flex", flexDirection: "column", alignItems: msg.from === "me" ? "flex-end" : "flex-start" }}>
                            <div style={{
                                background: msg.from === "me" ? "#2b5278" : "#1f2b38",
                                borderRadius: msg.from === "me" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                                padding: "9px 13px",
                                maxWidth: "78%",
                                fontSize: 14,
                                lineHeight: 1.45,
                                wordBreak: "break-word",
                            }}>
                                {msg.text}
                            </div>
                            <div style={{ fontSize: 11, color: "#708499", marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>
                                {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </div>
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>

            {error && <div style={{ padding: "4px 16px", color: "#ff6b6b", fontSize: 12, background: "#1f2b38" }}>{error}</div>}

            {/* Input area */}
            <div style={{ padding: "8px 10px 12px", background: "#1f2b38", display: "flex", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
                <div style={{ flex: 1, background: "#17212b", borderRadius: 22, padding: "10px 16px", display: "flex", alignItems: "center" }}>
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Message"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={sending}
                        style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#fff", fontSize: 15, fontFamily: "inherit" }}
                    />
                </div>
                <button
                    onClick={handleSend}
                    disabled={sending || !input.trim()}
                    style={{
                        width: 44, height: 44, borderRadius: "50%", border: "none", flexShrink: 0,
                        background: input.trim() ? "#2b5278" : "#2a3a4a",
                        color: "#fff", fontSize: 18, cursor: input.trim() ? "pointer" : "default",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        transition: "background 0.15s",
                    }}
                >
                    {sending
                        ? <Spinner size="s" />
                        : <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    }
                </button>
            </div>
        </div>
    )
}
