import React, { useEffect, useRef, useState } from "react"
import { Button, Input, Spinner, Placeholder } from "@telegram-apps/telegram-ui"
import { initiateSession, encryptMessage, decryptMessage, acceptSession } from "../crypto"
import { fetchBundle, fetchInbox, sendMessage, deleteMessage } from "../api"
import { getConvState, setConvState } from "../convState"

function getInitData() {
    return window.Telegram?.WebApp?.initData || null
}

export default function Chat({ identity, contactId, contactName, onBack }) {
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState(null)
    const [convState, setConvStateReact] = useState(() => getConvState(contactId))
    const convStateRef = useRef(convState)
    const bottomRef = useRef(null)
    const initData = getInitData()

    function updateConvState(s) {
        convStateRef.current = s
        setConvState(contactId, s)
        setConvStateReact(s)
    }

    useEffect(() => {
        loadMessages()
        const interval = setInterval(pollMessages, 4000)
        return () => clearInterval(interval)
    }, [])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    async function decryptInboxMessages(msgs) {
        const mine = msgs.filter(m => m.sender_id === contactId)
        const decrypted = []

        for (const msg of mine) {
            try {
                const payload = JSON.parse(msg.encrypted_payload)

                if (payload.type === "session_accepted") {
                    updateConvState("accepted")
                    await deleteMessage(msg.id, initData)
                    continue
                }

                if (payload.type === "session_declined") {
                    updateConvState("declined")
                    await deleteMessage(msg.id, initData)
                    continue
                }

                if (payload.type === "session_request") {
                    if (convStateRef.current !== "accepted") {
                        updateConvState("request_received")
                    }
                    await deleteMessage(msg.id, initData)
                    continue
                }

                const sessionState = await acceptSession(
                    identity,
                    payload.senderInfo.oneTimePreKeyId,
                    payload.senderInfo.identityKey,
                    payload.senderInfo.ephemeralKey,
                )
                const { plaintext } = await decryptMessage(sessionState, payload.message)
                if (convStateRef.current === "new") updateConvState("accepted")
                decrypted.push({ id: msg.id, from: "them", text: plaintext, timestamp: msg.timestamp })
                await deleteMessage(msg.id, initData)
            } catch {
                await deleteMessage(msg.id, initData).catch(() => {})
            }
        }
        return decrypted
    }

    async function loadMessages() {
        setLoading(true)
        try {
            const inbox = await fetchInbox(initData)
            const decrypted = await decryptInboxMessages(inbox.messages)
            setMessages(decrypted)
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
                setMessages(prev => [...prev, ...decrypted])
            }
        } catch {}
    }

    async function sendEncryptedControl(type) {
        const bundle = await fetchBundle(contactId, initData)
        const { state: sessionState, senderInfo } = await initiateSession(identity, {
            identityKey: bundle.identity_key,
            signedPreKey: bundle.signed_pre_key,
            oneTimePreKey: bundle.one_time_key?.public_key ?? null,
        })
        const { message } = await encryptMessage(sessionState, type)
        await sendMessage(contactId, JSON.stringify({ type, senderInfo, message }), initData)
    }

    async function sendSessionRequest() {
        setSending(true)
        setError(null)
        try {
            await sendEncryptedControl("session_request")
            updateConvState("requested")
        } catch (e) {
            setError(e.message)
        } finally {
            setSending(false)
        }
    }

    async function acceptRequest() {
        setSending(true)
        setError(null)
        try {
            await sendEncryptedControl("session_accepted")
            updateConvState("accepted")
        } catch (e) {
            setError(e.message)
        } finally {
            setSending(false)
        }
    }

    async function declineRequest() {
        setSending(true)
        setError(null)
        try {
            await sendEncryptedControl("session_declined")
            updateConvState("declined")
        } catch (e) {
            setError(e.message)
        } finally {
            setSending(false)
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

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid #333" }}>
                <Button size="s" mode="plain" onClick={onBack}>← Back</Button>
                <span style={{ fontWeight: 600 }}>{displayName}</span>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                {loading ? (
                    <div style={{ display: "flex", justifyContent: "center", marginTop: 40 }}><Spinner size="l" /></div>
                ) : convState === "request_received" ? (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div style={{ background: "#1e2936", borderRadius: 16, padding: 24, maxWidth: 300, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center" }}>
                            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#2b5278", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>
                                🔒
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>{displayName}</div>
                                <div style={{ color: "#708499", fontSize: 13 }}>wants to start an encrypted chat with you</div>
                            </div>
                            <div style={{ display: "flex", gap: 10, width: "100%" }}>
                                <button
                                    onClick={declineRequest}
                                    disabled={sending}
                                    style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#c0392b", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
                                >
                                    Decline
                                </button>
                                <button
                                    onClick={acceptRequest}
                                    disabled={sending}
                                    style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#27ae60", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
                                >
                                    Accept
                                </button>
                            </div>
                        </div>
                    </div>
                ) : messages.length === 0 ? (
                    <Placeholder description={
                        convState === "new" ? "Send a chat request to start" :
                        convState === "requested" ? "Waiting for reply..." :
                        convState === "declined" ? "Chat request was declined" :
                        "No messages yet. Say hello!"
                    } />
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

            {error && <div style={{ padding: "6px 16px", color: "#ff6b6b", fontSize: 13 }}>{error}</div>}

            {convState === "accepted" ? (
                <div style={{ padding: "8px 16px 16px", display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid #333" }}>
                    <div style={{ flex: 1 }}>
                        <Input placeholder="Message..." value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} disabled={sending} />
                    </div>
                    <Button onClick={handleSend} disabled={sending || !input.trim()} style={{ flexShrink: 0 }}>
                        {sending ? <Spinner size="s" /> : "Send"}
                    </Button>
                </div>
            ) : convState === "new" ? (
                <div style={{ padding: 16, borderTop: "1px solid #333", display: "flex", flexDirection: "column", gap: 8 }}>
                    <p style={{ margin: 0, color: "#708499", fontSize: 13 }}>
                        Start an encrypted conversation with {displayName}.
                    </p>
                    <Button onClick={sendSessionRequest} disabled={sending}>
                        {sending ? <Spinner size="s" /> : "Send chat request"}
                    </Button>
                </div>
            ) : convState === "requested" ? (
                <div style={{ padding: 16, borderTop: "1px solid #333" }}>
                    <p style={{ margin: 0, color: "#708499", fontSize: 13, textAlign: "center" }}>
                        Waiting for {displayName} to accept...
                    </p>
                </div>
            ) : null}
        </div>
    )
}
