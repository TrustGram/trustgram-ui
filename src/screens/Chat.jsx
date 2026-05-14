import React, { useEffect, useRef, useState } from "react"
import { Spinner, Placeholder } from "@telegram-apps/telegram-ui"
import { initiateSession, encryptMessage, decryptMessage, acceptSession } from "../crypto"
import { fetchBundle, fetchInbox, sendMessage, deleteMessage } from "../api"
import { getConvState, setConvState } from "../convState"
import { removePendingRequest } from "../pendingRequests"

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
    const [showCloseConfirm, setShowCloseConfirm] = useState(false)
    const convStateRef = useRef(convState)
    const bottomRef = useRef(null)
    const inputRef = useRef(null)
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
                    removePendingRequest(contactId)
                    await deleteMessage(msg.id, initData)
                    continue
                }
                if (payload.type === "session_declined") {
                    updateConvState("declined")
                    await deleteMessage(msg.id, initData)
                    continue
                }
                if (payload.type === "session_closed") {
                    updateConvState("closed")
                    await deleteMessage(msg.id, initData)
                    continue
                }
                if (payload.type === "session_request") {
                    if (convStateRef.current !== "accepted") updateConvState("request_received")
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
            if (decrypted.length > 0) setMessages(prev => [...prev, ...decrypted])
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

    async function acceptRequest() {
        setSending(true)
        try {
            await sendEncryptedControl("session_accepted")
            updateConvState("accepted")
        } catch (e) { setError(e.message) }
        finally { setSending(false) }
    }

    async function declineRequest() {
        setSending(true)
        try {
            await sendEncryptedControl("session_declined")
            updateConvState("declined")
        } catch (e) { setError(e.message) }
        finally { setSending(false) }
    }

    async function closeSession() {
        setShowCloseConfirm(false)
        setSending(true)
        try {
            await sendEncryptedControl("session_closed")
            updateConvState("closed")
            setConvState(contactId, "new")
            convStateRef.current = "new"
            removePendingRequest(contactId)
            onBack()
        } catch (e) { setError(e.message) }
        finally { setSending(false) }
    }

    async function handleSend() {
        if (!input.trim()) return
        setSending(true)
        setError(null)
        const text = input.trim()
        setInput("")
        inputRef.current?.focus()
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
        } catch (e) { setError(e.message) }
        finally { setSending(false) }
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
                {convState === "accepted" && (
                    <button
                        onClick={() => setShowCloseConfirm(true)}
                        style={{ background: "none", border: "none", color: "#708499", fontSize: 20, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
                        title="Close session"
                    >
                        ⋮
                    </button>
                )}
            </div>

            {/* Close session confirm */}
            {showCloseConfirm && (
                <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
                    <div style={{ background: "#1f2b38", borderRadius: 14, padding: 24, width: "100%", maxWidth: 300 }}>
                        <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Close session?</div>
                        <div style={{ color: "#708499", fontSize: 13, marginBottom: 20 }}>
                            The other person will be notified. You can start a new session anytime.
                        </div>
                        <div style={{ display: "flex", gap: 10 }}>
                            <button onClick={() => setShowCloseConfirm(false)} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#2a3a4a", color: "#fff", fontSize: 14, cursor: "pointer" }}>
                                Cancel
                            </button>
                            <button onClick={closeSession} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#c0392b", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {loading ? (
                    <div style={{ display: "flex", justifyContent: "center", marginTop: 40 }}><Spinner size="l" /></div>
                ) : convState === "request_received" ? (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div style={{ background: "#1f2b38", borderRadius: 16, padding: 24, maxWidth: 280, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center" }}>
                            <div style={{ width: 60, height: 60, borderRadius: "50%", background: "#2b5278", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>🔐</div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>{displayName}</div>
                                <div style={{ color: "#708499", fontSize: 13 }}>wants to start an encrypted chat</div>
                            </div>
                            <div style={{ display: "flex", gap: 10, width: "100%" }}>
                                <button onClick={declineRequest} disabled={sending} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "none", background: "#c0392b", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                                    Decline
                                </button>
                                <button onClick={acceptRequest} disabled={sending} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "none", background: "#27ae60", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                                    {sending ? "..." : "Accept"}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : convState === "closed" ? (
                    <Placeholder description="This session was closed. Start a new one from the chat list." />
                ) : messages.length === 0 ? (
                    <Placeholder description={
                        convState === "requested" || convState === "new" ? "Waiting for reply..." :
                        convState === "declined" ? "Chat request was declined" :
                        "No messages yet. Say hello!"
                    } />
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
            {convState === "accepted" && (
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
                        {sending ? <Spinner size="s" /> : "↑"}
                    </button>
                </div>
            )}

            {(convState === "new" || convState === "requested") && (
                <div style={{ padding: 14, background: "#1f2b38", textAlign: "center" }}>
                    <span style={{ color: "#708499", fontSize: 13 }}>Waiting for {displayName} to accept...</span>
                </div>
            )}
        </div>
    )
}
