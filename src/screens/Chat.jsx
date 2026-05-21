import React, { useEffect, useRef, useState } from "react"
import { Spinner, Placeholder } from "@telegram-apps/telegram-ui"
import { initiateSession, encryptMessage, decryptMessage, acceptSession, computeFingerprint } from "../crypto"
import { fetchBundle, fetchInbox, sendMessage, deleteMessage } from "../api"
import { loadMessages, saveMessages, clearMessages } from "../messageStore"
import { consumeOTK, getOtkLastCheck, setOtkLastCheck } from "../storage"
import { refillIfLow } from "../keyHealth"
import { withRatchetLock, clearRatchet } from "../ratchetStore"

const FILE_MAX_BYTES = 512 * 1024 // 512 KB

// SVG can carry inline <script> that fires on direct-open or drag-into-browser.
// Block at the picker so we never round-trip a malicious payload through E2E.
// Both the official mime and the "user picked an .svg with no/wrong mime" path.
function isUnsafeFile(file) {
    const mime = (file.type || "").toLowerCase()
    const name = (file.name || "").toLowerCase()
    if (mime === "image/svg+xml") return "SVG files are not supported (can embed scripts)."
    if (name.endsWith(".svg") || name.endsWith(".svgz")) return "SVG files are not supported (can embed scripts)."
    if (mime.startsWith("text/html") || name.endsWith(".html") || name.endsWith(".htm"))
        return "HTML files are not supported (can embed scripts)."
    return null
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function bufToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    const CHUNK = 8192
    for (let i = 0; i < bytes.length; i += CHUNK)
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    return btoa(binary)
}

async function streamTransform(buffer, Stream) {
    const s = new Stream("deflate-raw")
    const writer = s.writable.getWriter()
    writer.write(new Uint8Array(buffer))
    writer.close()
    const chunks = []
    const reader = s.readable.getReader()
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return out.buffer
}

const compressData   = buf => streamTransform(buf, CompressionStream)
const decompressData = buf => streamTransform(buf, DecompressionStream)

// Compress text bodies above this size before encrypting.
// Below ~200 bytes deflate overhead (window/header) eats any savings.
// (Compression happens on the *plaintext* — server only sees ciphertext, so
// the compress-vs-encrypt-order CRIME concern doesn't apply: attacker has no
// way to inject chosen plaintext alongside the user's message.)
const TEXT_COMPRESS_THRESHOLD = 200

async function maybeCompressText(text) {
    const utf8 = new TextEncoder().encode(text)
    if (utf8.byteLength < TEXT_COMPRESS_THRESHOLD) return { plaintext: text, type: "message" }
    const compressed = await compressData(utf8.buffer)
    if (compressed.byteLength >= utf8.byteLength) return { plaintext: text, type: "message" }
    return { plaintext: bufToBase64(compressed), type: "message_zip" }
}

async function decompressText(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const buf = await decompressData(bytes.buffer)
    return new TextDecoder().decode(buf)
}

function FileCard({ file }) {
    // Treat SVG as a generic file (never preview): <img src> won't execute its
    // scripts, but no need to make a Blob URL we could leak by mistake.
    const mime = file.mimeType || ""
    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml"
    const [imgSrc, setImgSrc] = React.useState(null)
    // null | "saved" | "opened" | { error: string }
    const [dlStatus, setDlStatus] = React.useState(null)

    React.useEffect(() => {
        if (!isImage) return
        let url
        ;(async () => {
            const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0))
            const buf = file.compressed ? await decompressData(bytes.buffer) : bytes.buffer
            url = URL.createObjectURL(new Blob([buf], { type: file.mimeType }))
            setImgSrc(url)
        })()
        return () => { if (url) URL.revokeObjectURL(url) }
    }, [file.data, file.compressed])

    async function handleDownload() {
        setDlStatus(null)
        try {
            const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0))
            const buf = file.compressed ? await decompressData(bytes.buffer) : bytes.buffer
            const blob = new Blob([buf], { type: file.mimeType || "application/octet-stream" })
            const url = URL.createObjectURL(blob)
            // Some mobile WebViews (especially iOS Telegram) won't honor the
            // `download` attribute on a detached <a>. Putting the anchor into
            // the DOM and removing it after the click gives the WebView a
            // proper user-initiated navigation to handle.
            const a = document.createElement("a")
            a.href = url
            a.download = file.name
            a.rel = "noopener"
            // Hidden but in DOM.
            a.style.position = "absolute"
            a.style.left = "-9999px"
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            // Haptic confirmation so the user has tactile feedback even when
            // the OS gives no visual cue.
            try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success") } catch {}
            setDlStatus("saved")
            setTimeout(() => URL.revokeObjectURL(url), 5000)
            setTimeout(() => setDlStatus(s => (s === "saved" ? null : s)), 3500)
        } catch (e) {
            setDlStatus({ error: e?.message ?? "Download failed" })
        }
    }

    return (
        <div style={{ minWidth: 180, maxWidth: 240 }}>
            {isImage && imgSrc && (
                <img
                    src={imgSrc}
                    alt={file.name}
                    style={{ width: "100%", borderRadius: 8, marginBottom: 8, display: "block", maxHeight: 200, objectFit: "cover" }}
                />
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {!isImage && (
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.65 }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>{formatFileSize(file.size)}</div>
                </div>
                <button onClick={handleDownload} title="Save to device" style={{
                    background: "rgba(255,255,255,0.12)", border: "none", borderRadius: 8,
                    padding: "6px 8px", cursor: "pointer", color: "inherit", flexShrink: 0,
                    display: "flex", alignItems: "center", transition: "background 0.12s",
                }}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </button>
            </div>
            {dlStatus && (
                <div style={{
                    marginTop: 6, fontSize: 11, lineHeight: 1.35,
                    color: typeof dlStatus === "object" ? "#ff8a8a" : "#6ab3f3",
                }}>
                    {dlStatus === "saved" && `Saved as ${file.name}. Check your Downloads.`}
                    {typeof dlStatus === "object" && dlStatus.error}
                </div>
            )}
            {isImage && (
                <div style={{ marginTop: 4, fontSize: 10, opacity: 0.5, lineHeight: 1.3 }}>
                    Tip: long-press the image to save it via your OS menu.
                </div>
            )}
        </div>
    )
}

const EMOJI_SET = [
    "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐒",
    "🦆","🦅","🦉","🦇","🐝","🐛","🦋","🐌","🐞","🐜","🦗","🐢","🐍","🦎","🐙","🦑",
    "🦀","🐡","🐠","🐟","🐬","🐳","🦈","🐊","🐅","🐆","🦓","🦍","🐘","🦛","🦏","🐪",
    "🦒","🐃","🐄","🐎","🐖","🐏","🐑","🐐","🦌","🐕","🐈","🐓","🦃","🦚","🦜","🦢",
    "🕊","🐇","🦝","🦨","🦡","🦦","🦥","🐁","🐀","🐿","🦔","🌸","🌼","🌻","🌹","🌷",
    "🌱","🌿","🍀","🍁","🍂","🍃","🍄","🌾","💐","🌵","🌴","🌳","🌲","🌺","🍎","🍐",
    "🍊","🍋","🍌","🍉","🍇","🍓","🍒","🍑","🍍","🥥","🥝","🍅","🍆","🥑","🥦","🥬",
    "🥒","🌶","🧄","🧅","🥕","🌽","🥔","🍠","🧀","🥚","🥞","🥓","🍗","🍖","🌭","🍔",
    "🍟","🍕","🌮","🌯","🥙","🥗","🍿","🧂","🥫","🍱","🍘","🍣","🍤","🍜","🍝","🍛",
    "🍲","🥘","🫕","🥣","🥗","🧆","🥚","🍳","🥐","🥯","🍞","🥖","🧇","🥞","🧈","☕",
    "🍵","🧃","🥤","🧋","🍺","🍷","🥂","🍸","🍹","🧉","⚽","🏀","🏈","⚾","🎾","🏐",
    "🏉","🎱","🏓","🏸","🥊","🎯","🎳","🏹","🎣","🤿","🎿","🛷","🎮","🕹","🎲","♟",
    "🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🪕","🎻","🌍","🌙","⭐",
    "☀","🌤","⛅","🌧","⛈","🌩","🌨","❄","🌊","🌈","🌪","⚡","🔥","💧","🌊","🍀",
    "🌙","✨","💫","⚡","🔑","🗝","🔐","🔒","🔓","🚪","🧲","💡","🔦","🕯","🪔","🔮",
    "🧿","🪬","🎁","🎈","🎉","🎊","🎀","🎗","🏆","🥇","🥈","🥉","🏅","🎖","🌟","💎",
]

function hexToEmoji(hex) {
    return hex.match(/.{2}/g).slice(0, 8).map(b => EMOJI_SET[parseInt(b, 16)])
}

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

// Stable tie-breaker: when two messages share the same ms timestamp, fall back
// to comparing IDs. Server IDs are positive integers; optimistic local IDs are
// strings like "me_1715...". Numeric-aware localeCompare orders both correctly
// (numbers as numbers, "me_*" lexicographically after) and keeps successive
// merges deterministic.
function compareMessages(x, y) {
    const dt = parseTs(x.timestamp) - parseTs(y.timestamp)
    if (dt !== 0) return dt
    return String(x.id).localeCompare(String(y.id), undefined, { numeric: true })
}

function mergeDedupe(a, b) {
    const seen = new Set(a.map(dedupKey))
    const novel = b.filter(m => !seen.has(dedupKey(m)))
    return [...a, ...novel].sort(compareMessages)
}

export default function Chat({ identity, storageKey, contactId, contactName, onBack, onIdentityRefresh }) {
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [sendingFile, setSendingFile] = useState(false)
    const [error, setError] = useState(null)
    const [debugLog, setDebugLog] = useState([])
    const [deleteConfirm, setDeleteConfirm] = useState(false)
    const [safetyNumbers, setSafetyNumbers] = useState(null) // null | { display, loading }
    const bottomRef = useRef(null)
    const inputRef = useRef(null)
    const fileInputRef = useRef(null)
    const messagesRef = useRef([])
    const identityRef = useRef(identity)
    const refillInProgress = useRef(false)
    // Tracks whether the component is still alive. In-flight polling/loading
    // that resolves after unmount must NOT call setState (React warns + leaks).
    const mountedRef = useRef(true)
    const initData = getInitData()

    useEffect(() => () => { mountedRef.current = false }, [])

    function pushDebug(line) {
        if (!mountedRef.current) return
        setDebugLog(prev => [...prev.slice(-9), `${new Date().toLocaleTimeString()} ${line}`])
    }

    // Guard setState behind mountedRef so async tasks completing after unmount
    // are no-ops instead of stale updates.
    function safeSetMessages(value) {
        if (!mountedRef.current) return
        setMessages(value)
    }
    function safeSetLoading(value) {
        if (!mountedRef.current) return
        setLoading(value)
    }
    function safeSetError(value) {
        if (!mountedRef.current) return
        setError(value)
    }

    useEffect(() => { identityRef.current = identity }, [identity])

    async function maybeRefillOTKs() {
        if (refillInProgress.current) return
        // throttle: check server at most once per 10 minutes per session
        const OTK_COOLDOWN_MS = 10 * 60 * 1000
        const lastCheck = await getOtkLastCheck()
        if (Date.now() - lastCheck < OTK_COOLDOWN_MS) return

        refillInProgress.current = true
        await setOtkLastCheck(Date.now())
        try {
            // refillIfLow holds a navigator.locks lease so a concurrently-open
            // tab can't race us into uploading a duplicate batch.
            const did = await refillIfLow({ threshold: 5, batchSize: 20, initData })
            if (did && onIdentityRefresh) await onIdentityRefresh()
        } catch (e) {
            console.warn("[TrustGram] OTK refill failed:", e?.message ?? e)
            pushDebug(`✗ otk refill: ${e?.message?.slice(0, 50) ?? "?"}`)
        }
        refillInProgress.current = false
    }

    function updateMessages(msgs) {
        messagesRef.current = msgs
        safeSetMessages(msgs)
        // saveMessages always persists (decrypted history is valuable even if the
        // component just unmounted — losing the latest poll's messages from disk
        // is worse than a brief no-op setState).
        //
        // Never swallow silently — quota/encoding failures here cause the saved
        // envelope to fall behind in-memory state, so on next load the user sees
        // an OLDER history (the bug that made picture-bearing chats look like
        // they "lost history" on reload).
        if (storageKey) {
            saveMessages(contactId, msgs, storageKey).catch(e => {
                console.error("[TrustGram] saveMessages failed:", e)
                pushDebug(`✗ save: ${e?.message?.slice(0, 50) ?? "?"}`)
            })
        }
    }

    useEffect(() => {
        let interval
        loadHistory().then(() => {
            // Don't start polling if we already unmounted during the initial load.
            if (!mountedRef.current) return
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

        // Process every incoming message under a single ratchet lock so the
        // chain key advances exactly once per message and concurrent polls /
        // tabs can't race.
        await withRatchetLock(contactId, async (initialState) => {
            let state = initialState
            for (const msg of mine) {
                const otkSnippet = (() => { try { return JSON.parse(msg.encrypted_payload)?.senderInfo?.oneTimePreKeyId?.slice(0, 8) ?? "null" } catch { return "?" } })()
                try {
                    const payload = JSON.parse(msg.encrypted_payload)

                    if (payload.type && payload.type !== "message" && payload.type !== "file" && payload.type !== "message_zip") {
                        await deleteMessage(msg.id, initData).catch(() => {})
                        continue
                    }

                    // First message of a session — receiver bootstraps via X3DH.
                    // Subsequent messages reuse the saved state.
                    //
                    // If senderInfo is present but we already have state, we
                    // still accept the new X3DH (sender may have lost state
                    // and is starting fresh) — fall back if normal decrypt
                    // fails. For now: trust senderInfo only when state is null.
                    if (!state) {
                        if (!payload.senderInfo) {
                            throw new Error("No session state and no senderInfo")
                        }
                        state = await acceptSession(
                            identityRef.current,
                            payload.senderInfo.oneTimePreKeyId,
                            payload.senderInfo.identityKey,
                            payload.senderInfo.ephemeralKey,
                        )
                        if (payload.senderInfo.oneTimePreKeyId) {
                            consumeOTK(payload.senderInfo.oneTimePreKeyId).catch(() => {})
                        }
                    }

                    let plaintext
                    let nextState
                    try {
                        const res = await decryptMessage(state, payload.message)
                        plaintext = res.plaintext
                        nextState = res.state
                    } catch (decryptErr) {
                        // If we have state but it doesn't work and the message
                        // carries a senderInfo (sender restarted session),
                        // bootstrap from scratch and retry once.
                        if (payload.senderInfo) {
                            pushDebug(`↻ resync #${msg.id} (state mismatch)`)
                            state = await acceptSession(
                                identityRef.current,
                                payload.senderInfo.oneTimePreKeyId,
                                payload.senderInfo.identityKey,
                                payload.senderInfo.ephemeralKey,
                            )
                            if (payload.senderInfo.oneTimePreKeyId) {
                                consumeOTK(payload.senderInfo.oneTimePreKeyId).catch(() => {})
                            }
                            const res = await decryptMessage(state, payload.message)
                            plaintext = res.plaintext
                            nextState = res.state
                        } else {
                            throw decryptErr
                        }
                    }
                    state = nextState

                    if (payload.type === "file") {
                        const file = JSON.parse(plaintext)
                        decrypted.push({ id: msg.id, from: "them", file, text: null, timestamp: msg.timestamp })
                    } else if (payload.type === "message_zip") {
                        const text = await decompressText(plaintext)
                        decrypted.push({ id: msg.id, from: "them", text, timestamp: msg.timestamp })
                    } else {
                        decrypted.push({ id: msg.id, from: "them", text: plaintext, timestamp: msg.timestamp })
                    }
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
            return state  // persisted by withRatchetLock
        })
        return decrypted
    }

    async function loadHistory() {
        safeSetLoading(true)
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
            safeSetError(e.message)
        } finally {
            safeSetLoading(false)
        }
    }

    async function pollMessages() {
        try {
            const inbox = await fetchInbox(initData)
            const decrypted = await decryptInboxMessages(inbox.messages)
            if (decrypted.length > 0) {
                updateMessages(mergeDedupe(messagesRef.current, decrypted))
            }
        } catch (e) {
            // Don't surface a banner: poll runs every 4s and a single failure
            // is fine. But never swallow silently — leave a trail for debugging.
            console.warn("[TrustGram] poll failed:", e?.message ?? e)
            pushDebug(`✗ poll: ${e?.message?.slice(0, 50) ?? "?"}`)
        }
    }

    async function handleSend() {
        if (!input.trim()) return
        setSending(true)
        safeSetError(null)
        const text = input.trim()
        setInput("")
        inputRef.current?.focus()
        const optimisticId = `me_${Date.now()}`
        try {
            const optimistic = mergeDedupe(messagesRef.current, [{
                id: optimisticId,
                from: "me",
                text,
                timestamp: new Date().toISOString(),
            }])
            updateMessages(optimistic)

            const { plaintext: bodyText, type } = await maybeCompressText(text)

            // Encrypt under the ratchet lock so concurrent sends serialize and
            // both halves of the wire format come from the same advancing chain.
            await withRatchetLock(contactId, async (existingState) => {
                let state = existingState
                let senderInfo = null

                if (!state) {
                    // First message — do X3DH. Subsequent messages skip this.
                    const bundle = await fetchBundle(contactId, initData)
                    const otkPub = bundle.one_time_key?.public_key
                    pushDebug(`→ send X3DH otk:${otkPub?.slice(0, 8) ?? "null"}`)
                    const init = await initiateSession(identityRef.current, {
                        identityKey: bundle.identity_key,
                        signingKey: bundle.signing_key,
                        signedPreKey: bundle.signed_pre_key,
                        signedPreKeySignature: bundle.signature,
                        oneTimePreKey: otkPub ?? null,
                    })
                    state = init.state
                    senderInfo = init.senderInfo
                } else {
                    pushDebug(`→ send (existing session)`)
                }

                const { message, state: nextState } = await encryptMessage(state, bodyText)
                const wire = senderInfo
                    ? { type, senderInfo, message }
                    : { type, message }
                await sendMessage(contactId, JSON.stringify(wire), initData)
                pushDebug(`→ send ok${type === "message_zip" ? " (zip)" : ""}`)
                return nextState
            })
        } catch (e) {
            console.error("[TrustGram] send failed:", e)
            pushDebug(`✗ send: ${e.message?.slice(0, 50)}`)
            safeSetError(e.message)
            // Roll back the optimistic message so the UI doesn't show a "sent"
            // bubble for something that never reached the server.
            updateMessages(messagesRef.current.filter(m => m.id !== optimisticId))
            // Restore the input so the user can retry without retyping.
            setInput(text)
        } finally {
            if (mountedRef.current) setSending(false)
        }
    }

    function handleKeyDown(e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
    }

    async function handleFileSelect(e) {
        const file = e.target.files?.[0]
        if (!file) return
        e.target.value = ""

        if (file.size > FILE_MAX_BYTES) {
            safeSetError(`File too large: ${formatFileSize(file.size)}. Max is 512 KB.`)
            return
        }

        const unsafe = isUnsafeFile(file)
        if (unsafe) {
            safeSetError(unsafe)
            return
        }

        setSendingFile(true)
        safeSetError(null)
        let optimisticId = null
        try {
            const arrayBuffer = await file.arrayBuffer()
            const compressedBuffer = await compressData(arrayBuffer)
            const useCompressed = compressedBuffer.byteLength < arrayBuffer.byteLength
            const dataBuffer = useCompressed ? compressedBuffer : arrayBuffer
            const base64data = bufToBase64(dataBuffer)
            pushDebug(`→ file ${formatFileSize(file.size)} → ${useCompressed ? formatFileSize(compressedBuffer.byteLength) + " compressed" : "no gain, raw"}`)

            const filePayload = JSON.stringify({
                name: file.name,
                mimeType: file.type || "application/octet-stream",
                size: file.size,
                data: base64data,
                compressed: useCompressed,
            })

            const optimisticFile = { name: file.name, mimeType: file.type, size: file.size, data: base64data, compressed: useCompressed }
            optimisticId = `me_${Date.now()}`
            updateMessages(mergeDedupe(messagesRef.current, [{
                id: optimisticId, from: "me", file: optimisticFile, text: null,
                timestamp: new Date().toISOString(),
            }]))

            await withRatchetLock(contactId, async (existingState) => {
                let state = existingState
                let senderInfo = null
                if (!state) {
                    const bundle = await fetchBundle(contactId, initData)
                    const otkPub = bundle.one_time_key?.public_key
                    pushDebug(`→ file X3DH otk:${otkPub?.slice(0, 8) ?? "null"}`)
                    const init = await initiateSession(identityRef.current, {
                        identityKey: bundle.identity_key,
                        signingKey: bundle.signing_key,
                        signedPreKey: bundle.signed_pre_key,
                        signedPreKeySignature: bundle.signature,
                        oneTimePreKey: otkPub ?? null,
                    })
                    state = init.state
                    senderInfo = init.senderInfo
                } else {
                    pushDebug(`→ file (existing session)`)
                }
                const { message, state: nextState } = await encryptMessage(state, filePayload)
                const wire = senderInfo
                    ? { type: "file", senderInfo, message }
                    : { type: "file", message }
                await sendMessage(contactId, JSON.stringify(wire), initData)
                pushDebug(`→ file ok`)
                return nextState
            })
        } catch (e) {
            console.error("[TrustGram] file send failed:", e)
            pushDebug(`✗ file: ${e?.message?.slice(0, 50) ?? "?"}`)
            safeSetError(e.message)
            // Roll back the optimistic message so the UI doesn't show a "sent"
            // bubble for a file that never reached the server.
            if (optimisticId) {
                updateMessages(messagesRef.current.filter(m => m.id !== optimisticId))
            }
        } finally {
            if (mountedRef.current) setSendingFile(false)
        }
    }

    async function handleDeleteChat() {
        clearMessages(contactId)
        // Drop the ratchet state too — otherwise re-adding the contact would
        // try to decrypt their new initial X3DH against a stale session.
        clearRatchet(contactId).catch(() => {})
        onBack()
    }

    async function handleShowSafetyNumbers() {
        setSafetyNumbers({ display: null, hex: null, loading: true, showHex: false })
        try {
            const bundle = await fetchBundle(contactId, initData)
            const { hex, display } = await computeFingerprint(identityRef.current, bundle.identity_key, bundle.signing_key)
            setSafetyNumbers({ hex, display, loading: false, showHex: false })
        } catch (e) {
            setSafetyNumbers(null)
            setError(e.message)
        }
    }

    const keysAvailable = !!identity

    const displayName = contactName ?? String(contactId)
    const initials = displayName.replace(/^@/, "").slice(0, 2).toUpperCase()
    const [debugOpen, setDebugOpen] = useState(false)

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#17212b" }}>
            <style>{`
                .chat-send-btn { transition: background 0.15s, box-shadow 0.15s !important; }
                .chat-send-btn.active:not(:disabled) { box-shadow: 0 0 0 3px rgba(106,179,243,0.22), 0 4px 12px rgba(43,82,120,0.5) !important; }
                .chat-msg-in { transition: background 0.1s; }
            `}</style>

            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, background: "#1f2b38", borderBottom: "1px solid rgba(42,58,74,0.8)", boxShadow: "0 2px 16px rgba(0,0,0,0.35)", flexShrink: 0, zIndex: 2 }}>
                <button onClick={onBack} style={{ background: "none", border: "none", color: "#6ab3f3", cursor: "pointer", padding: "4px", lineHeight: 1, display: "flex", alignItems: "center" }}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg, #2b5278 0%, #1a3a5c 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)" }}>
                    {initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
                    <div style={{ fontSize: 11, color: "#6ab3f3", cursor: "pointer" }} onClick={() => setDebugOpen(o => !o)}>🔒 End-to-end encrypted{debugLog.length > 0 ? ` · ${debugLog.length}` : ""}</div>
                </div>
                <button onClick={handleShowSafetyNumbers} title="Verify safety numbers" style={{ background: "none", border: "none", color: "#708499", cursor: "pointer", padding: "4px", display: "flex", alignItems: "center" }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </button>
                {deleteConfirm ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#ff6b6b" }}>Clear history?</span>
                        <button onClick={handleDeleteChat} style={{ background: "#c0392b", border: "none", color: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>Clear</button>
                        <button onClick={() => setDeleteConfirm(false)} style={{ background: "none", border: "none", color: "#708499", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
                    </div>
                ) : (
                    <button onClick={() => setDeleteConfirm(true)} style={{ background: "none", border: "none", color: "#708499", cursor: "pointer", padding: "4px", display: "flex", alignItems: "center" }}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" /></svg>
                    </button>
                )}
            </div>

                {safetyNumbers !== null && (
                <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={() => setSafetyNumbers(null)}>
                    <div style={{ background: "#1f2b38", borderRadius: 16, padding: "28px 24px", maxWidth: 340, width: "100%", textAlign: "center" }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>🛡️</div>
                        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Safety Numbers</div>
                        <div style={{ fontSize: 13, color: "#708499", marginBottom: 20, lineHeight: 1.5 }}>
                            Compare with <b style={{ color: "#a0b8cc" }}>{displayName}</b> via another channel. If they match — your connection is secure.
                        </div>
                        {safetyNumbers.loading ? (
                            <div style={{ display: "flex", justifyContent: "center", padding: 16 }}><Spinner size="m" /></div>
                        ) : safetyNumbers.showHex ? (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
                                {safetyNumbers.display.split(" ").map((group, i) => (
                                    <div key={i} style={{ background: "#17212b", borderRadius: 8, padding: "10px 4px", fontSize: 14, fontFamily: "monospace", fontWeight: 600, letterSpacing: 1, color: "#6ab3f3" }}>
                                        {group}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12 }}>
                                {hexToEmoji(safetyNumbers.hex).map((emoji, i) => (
                                    <div key={i} style={{ background: "#17212b", borderRadius: 10, padding: "12px 4px", fontSize: 28, lineHeight: 1 }}>
                                        {emoji}
                                    </div>
                                ))}
                            </div>
                        )}
                        {!safetyNumbers.loading && (
                            <button onClick={() => setSafetyNumbers(s => ({ ...s, showHex: !s.showHex }))}
                                style={{ background: "none", border: "none", color: "#708499", fontSize: 13, cursor: "pointer", marginBottom: 16 }}>
                                {safetyNumbers.showHex ? "Show as emoji" : "Show as numbers"}
                            </button>
                        )}
                        <div>
                            <button onClick={() => setSafetyNumbers(null)} style={{ padding: "10px 32px", borderRadius: 22, border: "none", background: "#2b5278", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
                                background: msg.from === "me"
                                    ? "linear-gradient(135deg, #2d5a8a 0%, #1e3f6e 100%)"
                                    : "#1f2b38",
                                border: msg.from === "me" ? "none" : "1px solid rgba(255,255,255,0.055)",
                                borderRadius: msg.from === "me" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                                padding: msg.file ? "10px 12px" : "9px 13px",
                                maxWidth: "78%", fontSize: 14, lineHeight: 1.5,
                                wordBreak: "break-word", color: "#e8f0f7",
                                boxShadow: msg.from === "me"
                                    ? "0 2px 8px rgba(0,0,0,0.25)"
                                    : "0 1px 4px rgba(0,0,0,0.2)",
                            }}>
                                {msg.file ? <FileCard file={msg.file} /> : msg.text}
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

            {!keysAvailable && (
                <div style={{ padding: "8px 16px", background: "#141e28", borderTop: "1px solid rgba(255,180,0,0.15)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#a07820" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    <span style={{ fontSize: 12, color: "#8a6820", lineHeight: 1.4 }}>
                        Imported chat — no keys on this device. Read-only.
                    </span>
                </div>
            )}

            <div style={{ padding: "8px 10px 12px", background: "#1f2b38", borderTop: "1px solid rgba(42,58,74,0.7)", display: "flex", alignItems: "flex-end", gap: 8, flexShrink: 0, opacity: keysAvailable ? 1 : 0.45, pointerEvents: keysAvailable ? "auto" : "none" }}>
                <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileSelect} />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending || sendingFile || !keysAvailable}
                    title="Attach file (max 512 KB)"
                    style={{
                        width: 44, height: 44, borderRadius: "50%", border: "none", flexShrink: 0,
                        background: "#2a3a4a", color: "#708499",
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                        transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = "#6ab3f3" }}
                    onMouseLeave={e => { e.currentTarget.style.color = "#708499" }}
                >
                    {sendingFile
                        ? <Spinner size="s" />
                        : <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    }
                </button>
                <div style={{ flex: 1, background: "#17212b", borderRadius: 22, padding: "10px 16px", display: "flex", alignItems: "center", border: "1px solid rgba(255,255,255,0.055)", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.2)" }}>
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Message"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={sending || sendingFile || !keysAvailable}
                        style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#e8f0f7", fontSize: 15, fontFamily: "inherit" }}
                    />
                </div>
                <button
                    onClick={handleSend}
                    disabled={sending || sendingFile || !input.trim() || !keysAvailable}
                    className={`chat-send-btn${input.trim() && keysAvailable ? " active" : ""}`}
                    style={{
                        width: 44, height: 44, borderRadius: "50%", border: "none", flexShrink: 0,
                        background: input.trim() && keysAvailable ? "linear-gradient(135deg, #2d5a8a 0%, #1e3f6e 100%)" : "#2a3a4a",
                        color: "#fff", cursor: input.trim() && keysAvailable ? "pointer" : "default",
                        display: "flex", alignItems: "center", justifyContent: "center",
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
