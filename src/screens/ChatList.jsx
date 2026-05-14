import React, { useEffect, useState } from "react"
import { List, Cell, Avatar, Button, Spinner, Modal, Placeholder } from "@telegram-apps/telegram-ui"
import { fetchInbox, fetchBundleByUsername, fetchBundle, getPendingSessions, initSession, acceptSessionBackend, declineSessionBackend, sendMessage } from "../api"
import { initiateSession, encryptMessage } from "../crypto"
import { setConvState } from "../convState"
import { addPendingRequest, removePendingRequest, getPendingRequests } from "../pendingRequests"

function getInitData() {
    return window.Telegram?.WebApp?.initData || null
}

function groupByContact(messages) {
    const map = new Map()
    for (const msg of messages) {
        const id = msg.sender_id
        if (!map.has(id) || new Date(msg.timestamp) > new Date(map.get(id).timestamp)) {
            map.set(id, msg)
        }
    }
    return Array.from(map.values()).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
}

export default function ChatList({ identity, onOpenChat, onResetKeys }) {
    const [conversations, setConversations] = useState([])
    const [incomingRequests, setIncomingRequests] = useState([])
    const [outgoingRequests, setOutgoingRequests] = useState(() => getPendingRequests())
    const [loading, setLoading] = useState(true)
    const [newChatOpen, setNewChatOpen] = useState(false)
    const [recipientInput, setRecipientInput] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [newChatError, setNewChatError] = useState("")
    const [acceptingId, setAcceptingId] = useState(null)

    useEffect(() => {
        loadAll()
        const interval = setInterval(loadAll, 5000)
        return () => clearInterval(interval)
    }, [])

    async function loadAll() {
        const initData = getInitData()
        const [inboxData, pendingData] = await Promise.allSettled([
            fetchInbox(initData),
            getPendingSessions(initData),
        ])

        if (inboxData.status === "fulfilled") {
            setConversations(groupByContact(inboxData.value.messages))
        }
        if (pendingData.status === "fulfilled") {
            setIncomingRequests(pendingData.value.requests)
        }
        setOutgoingRequests(getPendingRequests())
        setLoading(false)
    }

    async function handleNewChat() {
        const input = recipientInput.trim()
        if (!input) return
        setSubmitting(true)
        setNewChatError("")

        try {
            const initData = getInitData()
            let contactId, contactName

            const isUsername = isNaN(input.replace(/^@/, ""))
            if (isUsername) {
                const bundle = await fetchBundleByUsername(input, initData)
                contactId = bundle.telegram_id
                contactName = `@${input.replace(/^@/, "")}`
            } else {
                contactId = parseInt(input, 10)
                contactName = input
            }

            await initSession(contactId, initData)
            addPendingRequest(contactId, contactName)
            setOutgoingRequests(getPendingRequests())
            setNewChatOpen(false)
            setRecipientInput("")
        } catch {
            setNewChatError("User not found or error sending request")
        } finally {
            setSubmitting(false)
        }
    }

    async function handleAccept(req) {
        setAcceptingId(req.from_id)
        try {
            const initData = getInitData()
            const contactName = req.from_username ? `@${req.from_username}` : String(req.from_id)

            // Remove from backend
            await acceptSessionBackend(req.from_id, initData)

            // Send encrypted session_accepted to Alice's inbox
            const bundle = await fetchBundle(req.from_id, initData)
            const { state: sessionState, senderInfo } = await initiateSession(identity, {
                identityKey: bundle.identity_key,
                signedPreKey: bundle.signed_pre_key,
                oneTimePreKey: bundle.one_time_key?.public_key ?? null,
            })
            const { message } = await encryptMessage(sessionState, "session_accepted")
            await sendMessage(req.from_id, JSON.stringify({ type: "session_accepted", senderInfo, message }), initData)

            // Mark accepted locally and open chat
            setConvState(req.from_id, "accepted")
            setIncomingRequests(prev => prev.filter(r => r.from_id !== req.from_id))
            onOpenChat({ id: req.from_id, name: contactName })
        } catch (e) {
            alert("Failed to accept: " + e.message)
        } finally {
            setAcceptingId(null)
        }
    }

    async function handleDecline(req) {
        try {
            await declineSessionBackend(req.from_id, getInitData())
            setIncomingRequests(prev => prev.filter(r => r.from_id !== req.from_id))
        } catch {}
    }

    const pendingIds = new Set(outgoingRequests.map(r => r.contactId))
    const incomingIds = new Set(incomingRequests.map(r => r.from_id))
    const regularConvs = conversations.filter(c => !pendingIds.has(c.sender_id) && !incomingIds.has(c.sender_id))

    const isEmpty = incomingRequests.length === 0 && outgoingRequests.length === 0 && regularConvs.length === 0

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 20, fontWeight: 600 }}>TrustGram</span>
                <div style={{ display: "flex", gap: 8 }}>
                    <Button size="s" mode="outline" onClick={onResetKeys}>Reset keys</Button>
                    <Button size="s" onClick={() => { setNewChatError(""); setNewChatOpen(true) }}>New chat</Button>
                </div>
            </div>

            {loading ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Spinner size="l" />
                </div>
            ) : isEmpty ? (
                <Placeholder header="No chats yet" description="Start a new conversation by pressing 'New chat'" />
            ) : (
                <div style={{ flex: 1, overflowY: "auto" }}>
                    {/* Incoming requests */}
                    {incomingRequests.map(req => {
                        const name = req.from_username ? `@${req.from_username}` : String(req.from_id)
                        const isAccepting = acceptingId === req.from_id
                        return (
                            <div key={req.from_id} style={{ margin: "8px 12px", background: "#1e2936", borderRadius: 14, padding: 16, borderLeft: "3px solid #2196f3" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                                    <div style={{ width: 42, height: 42, borderRadius: "50%", background: "#2b5278", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
                                        🔐
                                    </div>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
                                        <div style={{ fontSize: 12, color: "#708499", marginTop: 2 }}>wants to start an encrypted chat</div>
                                    </div>
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                        onClick={() => handleDecline(req)}
                                        disabled={isAccepting}
                                        style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: "none", background: "#c0392b", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                                    >
                                        Decline
                                    </button>
                                    <button
                                        onClick={() => handleAccept(req)}
                                        disabled={isAccepting}
                                        style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: "none", background: "#27ae60", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                                    >
                                        {isAccepting ? "..." : "Accept"}
                                    </button>
                                </div>
                            </div>
                        )
                    })}

                    {/* Outgoing pending requests */}
                    {outgoingRequests.length > 0 && (
                        <List>
                            {outgoingRequests.map(req => (
                                <Cell
                                    key={req.contactId}
                                    before={<Avatar>{String(req.contactName).slice(-2)}</Avatar>}
                                    subtitle="⏳ Waiting for response..."
                                    onClick={() => onOpenChat({ id: req.contactId, name: req.contactName })}
                                >
                                    {req.contactName}
                                </Cell>
                            ))}
                        </List>
                    )}

                    {/* Regular conversations */}
                    {regularConvs.length > 0 && (
                        <List>
                            {regularConvs.map(msg => {
                                const displayName = msg.sender_username ? `@${msg.sender_username}` : String(msg.sender_id)
                                return (
                                    <Cell
                                        key={msg.sender_id}
                                        before={<Avatar>{displayName.slice(-2)}</Avatar>}
                                        subtitle={new Date(msg.timestamp).toLocaleString()}
                                        onClick={() => onOpenChat({ id: msg.sender_id, name: displayName })}
                                    >
                                        {displayName}
                                    </Cell>
                                )
                            })}
                        </List>
                    )}
                </div>
            )}

            <Modal open={newChatOpen} onOpenChange={setNewChatOpen} header={<Modal.Header>New chat</Modal.Header>}>
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                    <p style={{ margin: 0, color: "#708499", fontSize: 13 }}>
                        Enter a Telegram username or ID. They must have TrustGram open at least once.
                    </p>
                    <input
                        type="text"
                        placeholder="@username or Telegram ID"
                        value={recipientInput}
                        onChange={e => setRecipientInput(e.target.value)}
                        style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #444", background: "#1a1a1a", color: "#fff", fontSize: 16, boxSizing: "border-box" }}
                    />
                    {newChatError && <p style={{ margin: 0, color: "#ff6b6b", fontSize: 13 }}>{newChatError}</p>}
                    <Button onClick={handleNewChat} disabled={submitting}>
                        {submitting ? <Spinner size="s" /> : "Send request"}
                    </Button>
                </div>
            </Modal>
        </div>
    )
}
