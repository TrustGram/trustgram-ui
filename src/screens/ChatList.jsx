import React, { useEffect, useRef, useState } from "react"
import { Button, Spinner, Modal, Placeholder } from "@telegram-apps/telegram-ui"
import { fetchInbox, fetchBundle, fetchBundleByUsername } from "../api"
import { saveContact, getContacts, getContactName } from "../contacts"
import { hasPin } from "../pin"
import { clearMessages } from "../messageStore"
import { exportSingleChat, formatCode } from "../export"

function DeleteButton({ id, deleteTarget, setDeleteTarget, onDelete }) {
    if (deleteTarget === id) {
        return (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }} onClick={e => e.stopPropagation()}>
                <button onClick={() => onDelete(id)} style={{ background: "#c0392b", border: "none", color: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>Clear</button>
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

export default function ChatList({ onOpenChat, onResetKeys, onPinSettings, onExport, onImport, storageKey }) {
    const [inboxContacts, setInboxContacts] = useState([])
    const [savedContacts, setSavedContacts] = useState(() => getContacts())
    const [loading, setLoading] = useState(true)
    const [newChatOpen, setNewChatOpen] = useState(false)
    const [recipientInput, setRecipientInput] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [newChatError, setNewChatError] = useState("")
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [deleteTarget, setDeleteTarget] = useState(null)
    const [chatExport, setChatExport] = useState(null) // null | { state, id, code, name, error }
    const [exportCopied, setExportCopied] = useState(false)
    const [verifyOpen, setVerifyOpen] = useState(false)
    const settingsRef = useRef(null)

    const commitHash = typeof __COMMIT_HASH__ !== "undefined" ? __COMMIT_HASH__ : "unknown"
    const buildTime = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : null
    const repoUrl = import.meta.env.VITE_REPO_URL || null
    const cryptoRepoUrl = import.meta.env.VITE_CRYPTO_REPO_URL || null
    const commitUrl = repoUrl ? `${repoUrl}/commit/${commitHash}` : null

    function openExternal(url) {
        if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(url)
        else window.open(url, "_blank", "noreferrer")
    }

    function handleDeleteChat(id) {
        clearMessages(id)
        setDeleteTarget(null)
    }

    async function handleExportChat(id, name) {
        setChatExport({ state: "loading", id, name })
        try {
            const { payload, code } = await exportSingleChat(id, name, storageKey)
            const blob = new Blob([payload], { type: "application/json" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            const safeName = String(name).replace(/[^a-zA-Z0-9_]/g, "_")
            a.download = `trustgram_${safeName}_${new Date().toISOString().slice(0, 10)}.trustgram`
            a.click()
            URL.revokeObjectURL(url)
            setChatExport({ state: "done", id, code, name })
        } catch (e) {
            setChatExport({ state: "error", error: e.message })
        }
    }

    async function copyExportCode() {
        if (!chatExport?.code) return
        await navigator.clipboard.writeText(chatExport.code).catch(() => {})
        setExportCopied(true)
        setTimeout(() => setExportCopied(false), 2000)
    }

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

    const allContactsForSearch = [
        ...savedContacts,
        ...inboxContacts
            .filter(m => !savedContacts.some(c => c.id === m.sender_id))
            .map(m => ({ id: m.sender_id, name: m.sender_username ? `@${m.sender_username}` : getContactName(m.sender_id) }))
    ]
    const searchQuery = recipientInput.trim().toLowerCase()
    const filteredContacts = searchQuery
        ? allContactsForSearch.filter(c => c.name.toLowerCase().includes(searchQuery))
        : allContactsForSearch

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#17212b" }}>
            <style>{`
                .chat-row { transition: background 0.12s; }
                .chat-row:hover { background: rgba(43,82,120,0.12) !important; }
                .chat-row:active { background: rgba(43,82,120,0.22) !important; }
                .contact-row { transition: background 0.1s; }
                .contact-row:hover { background: rgba(43,82,120,0.18) !important; }
                .icon-btn { transition: color 0.12s, opacity 0.12s; }
                .icon-btn:hover { color: #6ab3f3 !important; opacity: 1 !important; }
            `}</style>

            {/* Backup code modal */}
            {chatExport?.state === "done" && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
                    <div style={{ background: "#1f2b38", borderRadius: 16, padding: "28px 24px", maxWidth: 340, width: "100%", textAlign: "center" }}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
                        <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Backup downloaded</div>
                        <div style={{ fontSize: 13, color: "#708499", marginBottom: 20, lineHeight: 1.5 }}>
                            Save this code — you'll need it to restore the chat. Without it the file cannot be decrypted.
                        </div>
                        <div style={{ fontSize: 11, color: "#708499", marginBottom: 8, letterSpacing: 1 }}>BACKUP CODE</div>
                        <div style={{ fontSize: 20, fontFamily: "monospace", fontWeight: 700, letterSpacing: 2, color: "#6ab3f3", lineHeight: 2, marginBottom: 14 }}>
                            {chatExport.code.split(" ").reduce((rows, word, i) =>
                                i % 3 === 0 ? [...rows, [word]] : [...rows.slice(0, -1), [...rows[rows.length - 1], word]],
                            []).map((row, i) => <div key={i}>{row.join(" ")}</div>)}
                        </div>
                        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                            <button onClick={copyExportCode} style={{ padding: "8px 20px", borderRadius: 20, border: "none", background: exportCopied ? "#27ae60" : "#2b5278", color: "#fff", fontSize: 14, cursor: "pointer" }}>
                                {exportCopied ? "Copied!" : "Copy code"}
                            </button>
                            <button onClick={() => { setChatExport(null); setExportCopied(false) }} style={{ padding: "8px 20px", borderRadius: 20, border: "none", background: "#2a3a4a", color: "#a0b8cc", fontSize: 14, cursor: "pointer" }}>
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {verifyOpen && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={() => setVerifyOpen(false)}>
                    <div style={{ background: "#1f2b38", borderRadius: 16, padding: "28px 24px", maxWidth: 340, width: "100%", textAlign: "center" }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 30, marginBottom: 8 }}>🔍</div>
                        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6, color: "#e8f0f7" }}>Verify build</div>
                        <div style={{ fontSize: 13, color: "#708499", marginBottom: 20, lineHeight: 1.6 }}>
                            Убедись, что в браузере работает именно тот код, который опубликован на GitHub.
                        </div>

                        <div style={{ background: "#17212b", borderRadius: 10, padding: "12px 14px", marginBottom: 16, textAlign: "left" }}>
                            <div style={{ fontSize: 11, color: "#708499", marginBottom: 4, letterSpacing: 1 }}>COMMIT</div>
                            {commitUrl ? (
                                <a href={commitUrl} target="_blank" rel="noreferrer"
                                    style={{ fontFamily: "monospace", fontSize: 13, color: "#6ab3f3", wordBreak: "break-all", textDecoration: "none", borderBottom: "1px dotted rgba(106,179,243,0.4)" }}>
                                    {commitHash.slice(0, 16)}…
                                </a>
                            ) : (
                                <span style={{ fontFamily: "monospace", fontSize: 13, color: "#6ab3f3", wordBreak: "break-all" }}>
                                    {commitHash.slice(0, 40)}
                                </span>
                            )}
                            {buildTime && (
                                <div style={{ fontSize: 11, color: "#708499", marginTop: 6 }}>
                                    Built {new Date(buildTime).toLocaleString()}
                                </div>
                            )}
                        </div>

                        <div style={{ background: "#17212b", borderRadius: 10, padding: "12px 14px", marginBottom: 20, textAlign: "left" }}>
                            <div style={{ fontSize: 11, color: "#708499", marginBottom: 8, letterSpacing: 1 }}>КАК ПРОВЕРИТЬ</div>
                            {[
                                "Склонируй репозиторий и переключись на этот коммит",
                                "Собери: npm install && npm run build",
                                "Сравни dist/index.html (SRI-хеши ассетов) с задеплоенной версией",
                            ].map((step, i) => (
                                <div key={i} style={{ display: "flex", gap: 8, marginBottom: i < 2 ? 8 : 0, alignItems: "flex-start" }}>
                                    <span style={{ color: "#6ab3f3", fontWeight: 700, fontSize: 12, flexShrink: 0, marginTop: 1 }}>{i + 1}.</span>
                                    <span style={{ fontSize: 12, color: "#a0b8cc", lineHeight: 1.5 }}>{step}</span>
                                </div>
                            ))}
                        </div>

                        {repoUrl && (
                            <a href={repoUrl} target="_blank" rel="noreferrer"
                                style={{ display: "inline-block", marginBottom: 16, fontSize: 13, color: "#6ab3f3", textDecoration: "none" }}>
                                Открыть репозиторий →
                            </a>
                        )}

                        <div>
                            <button onClick={() => setVerifyOpen(false)} style={{ padding: "10px 32px", borderRadius: 22, border: "none", background: "#2b5278", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                                Закрыть
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {chatExport?.state === "error" && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
                    <div style={{ background: "#1f2b38", borderRadius: 16, padding: "24px", maxWidth: 300, width: "100%", textAlign: "center" }}>
                        <div style={{ fontSize: 13, color: "#ff6b6b", marginBottom: 16 }}>{chatExport.error}</div>
                        <button onClick={() => setChatExport(null)} style={{ padding: "8px 24px", borderRadius: 20, border: "none", background: "#2a3a4a", color: "#fff", cursor: "pointer" }}>Close</button>
                    </div>
                </div>
            )}

            <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#1f2b38", borderBottom: "1px solid rgba(42,58,74,0.8)", boxShadow: "0 2px 16px rgba(0,0,0,0.35)", zIndex: 2, position: "relative" }}>
                <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.3px", color: "#e8f0f7" }}>TrustGram</span>
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
                                Backup all chats
                            </button>
                            <button onClick={() => { setSettingsOpen(false); setVerifyOpen(true) }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#a0b8cc", cursor: "pointer", fontSize: 14, textAlign: "left", borderBottom: "1px solid #2a3a4a" }}>
                                Verify build
                            </button>
                            {cryptoRepoUrl && (
                                <button onClick={() => { setSettingsOpen(false); openExternal(cryptoRepoUrl + "/blob/dev/src/index.ts") }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#a0b8cc", cursor: "pointer", fontSize: 14, textAlign: "left", borderBottom: "1px solid #2a3a4a" }}>
                                    Encryption source code ↗
                                </button>
                            )}
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
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Placeholder header="No chats yet" description="Start a new conversation by pressing 'New chat'" />
                </div>
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
                        <div key={id} className="chat-row" style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid rgba(26,37,54,0.8)", gap: 8 }}>
                            <div
                                onClick={() => onOpenChat({ id, name })}
                                style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, cursor: "pointer" }}
                            >
                                <div style={{ width: 44, height: 44, borderRadius: "50%", background: "linear-gradient(135deg, #2b5278 0%, #1a3a5c 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)" }}>
                                    {String(name).replace(/^@/, "").slice(0, 2).toUpperCase()}
                                </div>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#e8f0f7" }}>{name}</div>
                                    <div style={{ fontSize: 12, color: "#708499", marginTop: 2 }}>{subtitle}</div>
                                </div>
                            </div>
                            <button
                                onClick={e => { e.stopPropagation(); handleExportChat(id, name) }}
                                disabled={chatExport?.state === "loading"}
                                title="Export this chat"
                                className="icon-btn"
                                style={{ background: "none", border: "none", color: "#708499", cursor: "pointer", padding: "4px", display: "flex", alignItems: "center", flexShrink: 0, opacity: 0.7 }}
                            >
                                {chatExport?.state === "loading" && chatExport?.id === id
                                    ? <Spinner size="s" />
                                    : <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                }
                            </button>
                            <DeleteButton id={id} deleteTarget={deleteTarget} setDeleteTarget={setDeleteTarget} onDelete={handleDeleteChat} />
                        </div>
                    ))}
                </div>
            )}

            <div style={{ padding: "10px 16px", borderTop: "1px solid rgba(42,58,74,0.7)", background: "#1f2b38", flexShrink: 0, display: "flex", justifyContent: "center" }}>
                <button
                    onClick={onImport}
                    style={{ padding: "7px 18px", borderRadius: 20, border: "none", background: "linear-gradient(135deg, #2d5a8a 0%, #1e3f6e 100%)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.25)" }}
                >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Import
                </button>
            </div>

            <Modal
                open={newChatOpen}
                onOpenChange={v => { setNewChatOpen(v); if (!v) { setRecipientInput(""); setNewChatError("") } }}
                header={<Modal.Header>New chat</Modal.Header>}
            >
                <div style={{ padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
                    <input
                        type="text"
                        placeholder="Search or enter @username / ID"
                        value={recipientInput}
                        onChange={e => { setRecipientInput(e.target.value); setNewChatError("") }}
                        onKeyDown={e => e.key === "Enter" && recipientInput.trim() && handleNewChat()}
                        autoFocus
                        style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #2a3a4a", background: "#17212b", color: "#fff", fontSize: 15, boxSizing: "border-box", outline: "none" }}
                    />

                    {filteredContacts.length > 0 && (
                        <div style={{ borderRadius: 8, border: "1px solid #2a3a4a", overflow: "hidden" }}>
                            <div style={{ maxHeight: 240, overflowY: "auto" }}>
                                {filteredContacts.map((c, i) => (
                                    <div
                                        key={c.id}
                                        className="contact-row"
                                        onClick={() => {
                                            onOpenChat({ id: c.id, name: c.name })
                                            setNewChatOpen(false)
                                            setRecipientInput("")
                                            setNewChatError("")
                                        }}
                                        style={{
                                            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                                            cursor: "pointer", background: "#17212b",
                                            borderBottom: i < filteredContacts.length - 1 ? "1px solid rgba(26,37,54,0.8)" : "none",
                                        }}
                                    >
                                        <div style={{ width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg, #2b5278 0%, #1a3a5c 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0, boxShadow: "0 2px 6px rgba(0,0,0,0.25)" }}>
                                            {String(c.name).replace(/^@/, "").slice(0, 2).toUpperCase()}
                                        </div>
                                        <span style={{ fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#e8f0f7" }}>{c.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {searchQuery && filteredContacts.length === 0 && (
                        <div style={{ fontSize: 13, color: "#708499", textAlign: "center", padding: "4px 0" }}>
                            No saved contacts match
                        </div>
                    )}

                    {newChatError && <p style={{ margin: 0, color: "#ff6b6b", fontSize: 13 }}>{newChatError}</p>}

                    {recipientInput.trim() && (
                        <Button onClick={handleNewChat} disabled={submitting}>
                            {submitting ? <Spinner size="s" /> : "Open chat"}
                        </Button>
                    )}
                </div>
            </Modal>
        </div>
    )
}
