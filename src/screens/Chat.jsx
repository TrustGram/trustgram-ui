import React, { useEffect, useRef, useState } from "react"
import { Spinner, Placeholder } from "@telegram-apps/telegram-ui"
import { initiateSession, encryptMessage, decryptMessage, acceptSession } from "../crypto"
import { fetchBundle, fetchInbox, sendMessage, deleteMessage, refillOTKs } from "../api"
import { loadMessages, saveMessages } from "../messageStore"
import { appendOTKsToIdentity } from "../storage"

function getInitData() {
    return window.Telegram?.WebApp?.initData || null
}

function parseTs(ts) {
    const d = new Date(ts)
    return isNaN(d) ? 0 : d.getTime()
}

function dedupKey(m) {
    return `${m.id}|${m.timestamp}`
}

function mergeDedupe(a, b) {
    const seen = new Set(a.map(dedupKey))
    const novel = b.filter(m => !seen.has(dedupKey(m)))
    return [...a, ...novel].sort((x, y) => parseTs(x.timestamp) - parseTs(y.timestamp))
}

export default function Chat({ identity, storageKey, contactId, contactName, onBack, onIdentityRefresh }) {
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState(null)
    const [debugLog, setDebugLog] = useState([])
    const bottomRef = useRef(null)
    const inputRef = useRef(null)
    const messagesRef = useRef([])
    const identityRef = useRef(identity)
    const refillInProgress = useRef(false)
    const initData = getInitData()

    function pushDebug(line) {
        setDebugLog(prev => [...prev.slice(-9), `${new Date().toLocaleTimeString()} ${line}`])
    }

    useEffect(() => { identityRef.current = identity }, [identity])

    async function maybeRefillOTKs() {
        if (refillInProgress.current) return
        const OTK_BATCH = 10
        const OTK_THRESHOLD_KEY = "tg_otk_remaining"
        const remaining = parseInt(localStorage.getItem(OTK_THRESHOLD_KEY) ?? "10", 10)
        if (remaining > 3) {
            localStorage.setItem(OTK_THRESHOLD_KEY, String(remaining - 1))
            return
        }
        refillInProgress.current = true
        try {
            const pairs = await Promise.all(
                Array.from({ length: OTK_BATCH }, () =>
                    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"])
                )
            )
            const oneTimeKeys = await Promise.all(
                pairs.map(async (kp, i) => {
                    const raw = await crypto.subtle.exportKey("raw", kp.publicKey)
                    const pub = btoa(String.fromCharCode(...new Uint8Array(raw)))
                    return { key_id: `${Date.now()}_${i}`, public_key: pub, keyPair: kp }
                })
            )
            await refillOTKs(oneTimeKeys.map(({ key_id, public_key }) => ({ key_id, public_key })), initData)
            await appendOTKsToIdentity(oneTimeKeys.map(({ keyPair }) => keyPair))
            localStorage.setItem(OTK_THRESHOLD_KEY, String(OTK_BATCH))
            if (onIdentityRefresh) await onIdentityRefresh()
        } catch {}
        refillInProgress.current = false
    }

    function updateMessages(msgs) {
        messagesRef.current = msgs
        setMessages(msgs)
        if (storageKey) saveMessages(contactId, msgs, storageKey).catch(() => {})
    }

    useEffect(() => {
        let interval
        loadHistory().then(() => {
            interval = setInterval(pollMessages, 4000)
        })
        return () => clearInterval(interval)
    }, [])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }, [messages])

    async function decryptInboxMessages(msgs) {
        const mine = msgs.filter(m => m.sender_id === contactId)
        if (msgs.length > 0) pushDebug(`inbox: ${msgs.length} msg, mine: ${mine.length}`)
        const decrypted = []

        for (const msg of mine) {
            const otkSnippet = (() => { try { return JSON.parse(msg.encrypted_payload)?.senderInfo?.oneTimePreKeyId?.slice(0, 8) ?? "null" } catch { return "?" } })()
            try {
                const payload = JSON.parse(msg.encrypted_payload)

                if (payload.type && payload.type !== "message") {
                    await deleteMessage(msg.id, initData).catch(() => {})
                    continue
                }

                const sessionState = await acceptSession(
                    identityRef.current,
                    payload.senderInfo.oneTimePreKeyId,
                    payload.senderInfo.identityKey,
                    payload.senderInfo.ephemeralKey,
                )
                const { plaintext } = await decryptMessage(sessionState, payload.message)
                decrypted.push({ id: msg.id, from: "them", text: plaintext, timestamp: msg.timestamp })
                pushDebug(`✓ decrypt #${msg.id} otk:${otkSnippet}`)
                await deleteMessage(msg.id, initData).catch(e => pushDebug(`del fail #${msg.id}: ${e.message?.slice(0, 30)}`))
                maybeRefillOTKs().catch(() => {})
            } catch (err) {
                console.error("[TrustGram] decrypt failed for msg", msg.id, "otk:", otkSnippet, err?.message, err)
                pushDebug(`✗ decrypt #${msg.id} otk:${otkSnippet} err:${err?.message?.slice(0, 40)}`)
                decrypted.push({ id: msg.id, from: "them", text: `🔒 [не удалось расшифровать: ${err?.message?.slice(0, 50) ?? "?"}]`, timestamp: msg.timestamp })
                await deleteMessage(msg.id, initData).catch(() => {})
            }
        }
        return decrypted
    }

    async function loadHistory() {
        setLoading(true)
        try {
            const [history, inbox] = await Promise.all([
                storageKey ? loadMessages(contactId, storageKey) : Promise.resolve([]),
                fetchInbox(initData),
            ])
            const decrypted = await decryptInboxMessages(inbox.messages)
            // Merge stored history + any messages already in state (from concurrent poll) + new inbox
            const merged = mergeDedupe(mergeDedupe(history, messagesRef.current), decrypted)
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
                updateMessages(mergeDedupe(messagesRef.current, decrypted))
            }
        } catch {}
    }

    async function handleSend() {
        if (!input.trim()) return
        setSending(true)
        setError(null)
        const text = input.trim()
        setInput("")
        inputRef.current?.focus()
        try {
            const optimistic = mergeDedupe(messagesRef.current, [{
                id: `me_${Date.now()}`,
                from: "me",
                text,
                timestamp: new Date().toISOString(),
            }])
            updateMessages(optimistic)

            const bundle = await fetchBundle(contactId, initData)
            const otkPub = bundle.one_time_key?.public_key
            pushDebug(`→ send otk:${otkPub?.slice(0, 8) ?? "null"}`)
            const { state: sessionState, senderInfo } = await initiateSession(identityRef.current, {
                identityKey: bundle.identity_key,
                signedPreKey: bundle.signed_pre_key,
                oneTimePreKey: otkPub ?? null,
            })
            const { message } = await encryptMessage(sessionState, text)
            await sendMessage(contactId, JSON.stringify({ type: "message", senderInfo, message }), initData)
            pushDebug(`→ send ok`)
        } catch (e) {
            console.error("[TrustGram] send failed:", e)
            pushDebug(`✗ send: ${e.message?.slice(0, 50)}`)
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
    const [debugOpen, setDebugOpen] = useState(false)

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#17212b" }}>

            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, background: "#1f2b38", borderBottom: "1px solid #2a3a4a", flexShrink: 0 }}>
                <button onClick={onBack} style={{ background: "none", border: "none", color: "#6ab3f3", fontSize: 22, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>←</button>
                <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#2b5278", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                    {initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
                    <div style={{ fontSize: 11, color: "#6ab3f3", cursor: "pointer" }} onClick={() => setDebugOpen(o => !o)}>🔒 End-to-end encrypted{debugLog.length > 0 ? ` · ${debugLog.length}` : ""}</div>
                </div>
            </div>

            {debugOpen && (
                <div style={{ background: "#0d1620", padding: "6px 10px", fontSize: 10, fontFamily: "monospace", color: "#8aa3bd", maxHeight: 140, overflowY: "auto", borderBottom: "1px solid #2a3a4a" }}>
                    {debugLog.length === 0 ? <div>no events yet</div> : debugLog.map((line, i) => <div key={i}>{line}</div>)}
                </div>
            )}

            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {loading ? (
                    <div style={{ display: "flex", justifyContent: "center", marginTop: 40 }}><Spinner size="l" /></div>
                ) : messages.length === 0 ? (
                    <Placeholder description="No messages yet. Say hello!" />
                ) : (
                    messages.map(msg => (
                        <div key={dedupKey(msg)} style={{ display: "flex", flexDirection: "column", alignItems: msg.from === "me" ? "flex-end" : "flex-start" }}>
                            <div style={{
                                background: msg.from === "me" ? "#2b5278" : "#1f2b38",
                                borderRadius: msg.from === "me" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                                padding: "9px 13px", maxWidth: "78%", fontSize: 14, lineHeight: 1.45, wordBreak: "break-word",
                            }}>
                                {msg.text}
                            </div>
                            <div style={{ fontSize: 11, color: "#708499", marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>
                                {parseTs(msg.timestamp) ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                            </div>
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>

            {error && <div style={{ padding: "4px 16px", color: "#ff6b6b", fontSize: 12, background: "#1f2b38" }}>{error}</div>}

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
                        color: "#fff", cursor: input.trim() ? "pointer" : "default",
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
