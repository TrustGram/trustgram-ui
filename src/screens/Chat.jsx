import React, { useEffect, useRef, useState } from "react"
import { Button, Input, Spinner, Placeholder } from "@telegram-apps/telegram-ui"
import { initiateSession, encryptMessage, decryptMessage, acceptSession } from "../crypto"
import { fetchBundle, fetchInbox, sendMessage, deleteMessage } from "../api"
import { isMockBot, mockBotName, mockReply } from "../mockBots"

function getInitData() {
    return window.Telegram?.WebApp?.initData || null
}

export default function Chat({ identity, contactId, contactName, onBack }) {
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState(null)
    const bottomRef = useRef(null)
    const ratchetState = useRef(null)  // CryptoKey objects — kept in memory only
    const initData = getInitData()

    useEffect(() => {
        if (!isMockBot(contactId)) loadMessages()
        else setLoading(false)
    }, [])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    async function loadMessages() {
        setLoading(true)
        try {
            const inbox = await fetchInbox(initData)
            const mine = inbox.messages.filter(m => m.sender_id === contactId)

            const decrypted = []

            for (const msg of mine) {
                try {
                    const payload = JSON.parse(msg.encrypted_payload)
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

            setMessages(prev => [...prev, ...decrypted])
        } catch (e) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }

    async function handleSend() {
        if (!input.trim()) return
        setSending(true)
        setError(null)
        const text = input.trim()
        setInput("")
        try {
            setMessages(prev => [...prev, { id: Date.now(), from: "me", text, timestamp: new Date().toISOString() }])

            if (isMockBot(contactId)) {
                const reply = await mockReply(contactId, text)
                setMessages(prev => [...prev, reply])
                return
            }

            const bundle = await fetchBundle(contactId, initData)
            const { state: sessionState, senderInfo } = await initiateSession(identity, {
                identityKey: bundle.identity_key,
                signedPreKey: bundle.signed_pre_key,
                oneTimePreKey: bundle.one_time_key?.public_key ?? null,
            })
            const { message } = await encryptMessage(sessionState, text)
            const payload = JSON.stringify({ senderInfo, message })
            await sendMessage(contactId, payload, initData)
        } catch (e) {
            setError(e.message)
        } finally {
            setSending(false)
        }
    }

    function handleKeyDown(e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
            {/* Header */}
            <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid #333" }}>
                <Button size="s" mode="plain" onClick={onBack}>← Back</Button>
                <span style={{ fontWeight: 600 }}>{contactName ?? (isMockBot(contactId) ? mockBotName(contactId) : String(contactId))}</span>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                {loading ? (
                    <div style={{ display: "flex", justifyContent: "center", marginTop: 40 }}>
                        <Spinner size="l" />
                    </div>
                ) : messages.length === 0 ? (
                    <Placeholder description="No messages yet. Say hello!" />
                ) : (
                    messages.map(msg => (
                        <div key={msg.id} style={{
                            alignSelf: msg.from === "me" ? "flex-end" : "flex-start",
                            background: msg.from === "me" ? "#2b5278" : "#333",
                            borderRadius: 12,
                            padding: "8px 12px",
                            maxWidth: "75%",
                        }}>
                            <div>{msg.text}</div>
                            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2, textAlign: "right" }}>
                                {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </div>
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>

            {/* Error */}
            {error && (
                <div style={{ padding: "6px 16px", color: "#ff6b6b", fontSize: 13 }}>{error}</div>
            )}

            {/* Input */}
            <div style={{ padding: "8px 16px 16px", display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid #333" }}>
                <div style={{ flex: 1 }}>
                    <Input
                        placeholder="Message..."
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={sending}
                    />
                </div>
                <Button onClick={handleSend} disabled={sending || !input.trim()} style={{ flexShrink: 0 }}>
                    {sending ? <Spinner size="s" /> : "Send"}
                </Button>
            </div>
        </div>
    )
}
