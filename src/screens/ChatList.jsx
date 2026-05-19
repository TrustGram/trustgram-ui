import React, { useEffect, useRef, useState } from "react"
import { Button, Spinner, Modal, Placeholder } from "@telegram-apps/telegram-ui"
import { fetchInbox, fetchBundle, fetchBundleByUsername } from "../api"
import { saveContact, getContacts, getContactName, removeContact } from "../contacts"
import { hasPin } from "../pin"
import { clearMessages } from "../messageStore"

function DeleteButton({ id, deleteTarget, setDeleteTarget, onDelete }) {
    if (deleteTarget === id) {
        return (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }} onClick={e => e.stopPropagation()}>
                <button onClick={() => onDelete(id)} style={{ background: "#c0392b", border: "none", color: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>Delete</button>
                <button onClick={() => setDeleteTarget(null)} style={{ background: "none", border: "none", color: "#708499", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
        )
    }
    return (
        <button onClick={e => { e.stopPropagation(); setDeleteTarget(id) }} style={{ background: "none", border: "none", color: "#708499", cursor: "pointer", padding: "4px", display: "flex", alignItems: "center" }}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" /></svg>
        </button>
    )
}

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

export default function ChatList({ onOpenChat, onResetKeys, onPinSettings, onExport }) {
    const [inboxContacts, setInboxContacts] = useState([])
    const [savedContacts, setSavedContacts] = useState(() => getContacts())
    const [loading, setLoading] = useState(true)
    const [newChatOpen, setNewChatOpen] = useState(false)
    const [recipientInput, setRecipientInput] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [newChatError, setNewChatError] = useState("")
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [deleteTarget, setDeleteTarget] = useState(null)

    function handleDeleteChat(id) {
        clearMessages(id)
        removeContact(id)
        setInboxContacts(prev => prev.filter(m => m.sender_id !== id))
        setSavedContacts(prev => prev.filter(c => c.id !== id))
        setDeleteTarget(null)
    }
    const settingsRef = useRef(null)

    useEffect(() => {
        function handleClickOutside(e) {
            if (settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false)
        }
        document.addEventListener("mousedown", handleClickOutside)
        return () => document.removeEventListener("mousedown", handleClickOutside)
    }, [])

    useEffect(() => {
        loadInbox()
        const interval = setInterval(loadInbox, 5000)
        return () => clearInterval(interval)
    }, [])

    async function loadInbox() {
        try {
            const data = await fetchInbox(getInitData())
            const grouped = groupByContact(data.messages)
            for (const msg of grouped) {
                if (msg.sender_username) saveContact(msg.sender_id, `@${msg.sender_username}`)
            }
            setInboxContacts(grouped)
        } catch {}
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
                contactName = bundle.telegram_username ? `@${bundle.telegram_username}` : `@${input.replace(/^@/, "")}`
            } else {
                contactId = parseInt(input, 10)
                const bundle = await fetchBundle(String(contactId), initData)
                contactName = bundle.telegram_username ? `@${bundle.telegram_username}` : getContactName(contactId)
            }

            saveContact(contactId, contactName)
            setSavedContacts(getContacts())
            setNewChatOpen(false)
            setRecipientInput("")
            onOpenChat({ id: contactId, name: contactName })
        } catch {
            setNewChatError("User not found or error. Make sure they have opened TrustGram.")
        } finally {
            setSubmitting(false)
        }
    }

    const inboxIds = new Set(inboxContacts.map(m => m.sender_id))
    const extraSaved = savedContacts.filter(c => !inboxIds.has(c.id))
    const isEmpty = inboxContacts.length === 0 && extraSaved.length === 0

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 20, fontWeight: 600 }}>TrustGram</span>
                <div ref={settingsRef} style={{ display: "flex", gap: 8, alignItems: "center", position: "relative" }}>
                    <Button size="s" onClick={() => { setNewChatError(""); setNewChatOpen(true) }}>New chat</Button>
                    <button onClick={() => setSettingsOpen(o => !o)} style={{ background: "none", border: "none", color: "#708499", cursor: "pointer", padding: "4px", display: "flex", alignItems: "center" }}>
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
                    </button>
                    {settingsOpen && (
                        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "#1f2b38", border: "1px solid #2a3a4a", borderRadius: 8, zIndex: 10, minWidth: 160, boxShadow: "0 4px 12px rgba(0,0,0,0.4)" }}>
                            {!hasPin() && (
                                <button onClick={() => { setSettingsOpen(false); onPinSettings("setup") }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#a0b8cc", cursor: "pointer", fontSize: 14, textAlign: "left", borderBottom: "1px solid #2a3a4a" }}>
                                    Set PIN
                                </button>
                            )}
                            {hasPin() && (
                                <>
                                    <button onClick={() => { setSettingsOpen(false); onPinSettings("change") }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#a0b8cc", cursor: "pointer", fontSize: 14, textAlign: "left", borderBottom: "1px solid #2a3a4a" }}>
                                        Change PIN
                                    </button>
                                    <button onClick={() => { setSettingsOpen(false); onPinSettings("disable") }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#a0b8cc", cursor: "pointer", fontSize: 14, textAlign: "left", borderBottom: "1px solid #2a3a4a" }}>
                                        Disable PIN
                                    </button>
                                </>
                            )}
                            <button onClick={() => { setSettingsOpen(false); onExport() }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#a0b8cc", cursor: "pointer", fontSize: 14, textAlign: "left", borderBottom: "1px solid #2a3a4a" }}>
                                Backup &amp; Restore
                            </button>
                            <button onClick={() => { setSettingsOpen(false); onResetKeys() }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#ff6b6b", cursor: "pointer", fontSize: 14, textAlign: "left" }}>
                                Reset keys
                            </button>
                        </div>
                    )}
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
                    {[
                        ...inboxContacts.map(msg => ({
                            id: msg.sender_id,
                            name: msg.sender_username ? `@${msg.sender_username}` : getContactName(msg.sender_id),
                            subtitle: new Date(msg.timestamp).toLocaleString(),
                        })),
                        ...extraSaved.map(c => ({ id: c.id, name: c.name, subtitle: "No messages yet" })),
                    ].map(({ id, name, subtitle }) => (
                        <div key={id} style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #1a2536", gap: 12 }}>
                            <div
                                onClick={() => onOpenChat({ id, name })}
                                style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, cursor: "pointer" }}
                            >
                                <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#2b5278", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, flexShrink: 0 }}>
                                    {String(name).replace(/^@/, "").slice(0, 2).toUpperCase()}
                                </div>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                                    <div style={{ fontSize: 12, color: "#708499", marginTop: 2 }}>{subtitle}</div>
                                </div>
                            </div>
                            <DeleteButton id={id} deleteTarget={deleteTarget} setDeleteTarget={setDeleteTarget} onDelete={handleDeleteChat} />
                        </div>
                    ))}
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
                        onKeyDown={e => e.key === "Enter" && handleNewChat()}
                        style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #444", background: "#1a1a1a", color: "#fff", fontSize: 16, boxSizing: "border-box" }}
                    />
                    {newChatError && <p style={{ margin: 0, color: "#ff6b6b", fontSize: 13 }}>{newChatError}</p>}
                    <Button onClick={handleNewChat} disabled={submitting}>
                        {submitting ? <Spinner size="s" /> : "Open chat"}
                    </Button>
                </div>
            </Modal>
        </div>
    )
}
