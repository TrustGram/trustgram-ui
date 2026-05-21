import React, { useEffect, useRef, useState } from "react"
import { Spinner } from "@telegram-apps/telegram-ui"
import Setup from "./screens/Setup"
import ChatList from "./screens/ChatList"
import Chat from "./screens/Chat"
import PinLock from "./screens/PinLock"
import PinSetup from "./screens/PinSetup"
import ExportImport from "./screens/ExportImport"
import {
    loadIdentity, saveIdentity, clearIdentity,
    getStorageKeyMode, getUnencryptedStorageKey,
    updateSPKInIdentity,
    savePendingSPK, loadPendingSPK, clearPendingSPK,
    getSpkRotatedAt, setSpkRotatedAt,
} from "./storage"
import { signSPK } from "./crypto"
import { clearAllMessages } from "./messageStore"
import { clearContacts } from "./contacts"
import { hasPin, shouldLockOnOpen, updateLastActivity, getLockInterval, clearLockState } from "./pin"
import { updateSPK } from "./api"
import { drainInbox } from "./inboxDrain"
import { refillIfLow } from "./keyHealth"

const SPK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

async function finalizePendingSPK(initData, refreshIdentity) {
    const pending = await loadPendingSPK()
    if (!pending) return
    // Retry the parts that may not have completed last time. Server PUT is
    // idempotent — re-uploading the same SPK is harmless.
    await updateSPK(pending.publicKey, pending.signature, initData)
    await updateSPKInIdentity(pending.keyPair)
    await clearPendingSPK()
    await setSpkRotatedAt(pending.timestamp ?? Date.now())
    await refreshIdentity()
}

async function rotateSPK(identity, storageKey, initData, refreshIdentity) {
    // 1. Drain inbox so no messages are pending under the old SPK.
    await drainInbox(identity, storageKey, initData)

    // 2. Generate + sign the new key.
    const newSpkKeyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"]
    )
    const raw = await crypto.subtle.exportKey("raw", newSpkKeyPair.publicKey)
    const pub = btoa(String.fromCharCode(...new Uint8Array(raw)))
    const signature = await signSPK(identity, newSpkKeyPair)

    // 3. Persist the new private half BEFORE telling the server about the public
    //    half. If we crash now, the next boot recovers by retrying step 4.
    const timestamp = Date.now()
    await savePendingSPK({ keyPair: newSpkKeyPair, publicKey: pub, signature, timestamp })

    // 4. Upload to server. On failure, leave pending in place — boot will retry.
    await updateSPK(pub, signature, initData)

    // 5. Promote pending → current identity.
    await updateSPKInIdentity(newSpkKeyPair)
    await clearPendingSPK()
    await setSpkRotatedAt(timestamp)
    await refreshIdentity()
}

async function checkKeyHealth(identity, storageKey, initData, refreshIdentity) {
    // First, finish any rotation that was interrupted last session.
    try {
        await finalizePendingSPK(initData, refreshIdentity)
    } catch (e) {
        console.warn("[TrustGram] pending SPK recovery failed:", e?.message ?? e)
    }

    // OTK replenishment (cross-tab safe via navigator.locks).
    try {
        const did = await refillIfLow({ threshold: 5, batchSize: 20, initData })
        if (did) await refreshIdentity()
    } catch (e) {
        console.warn("[TrustGram] OTK refill failed:", e?.message ?? e)
    }

    // SPK rotation (only if no pending — we just recovered one if there was).
    // Wrap in navigator.locks so two open tabs don't both rotate; the loser
    // just skips this cycle and tries again on the next boot.
    try {
        const lastRotated = await getSpkRotatedAt()
        if (Date.now() - lastRotated > SPK_MAX_AGE_MS) {
            const run = () => rotateSPK(identity, storageKey, initData, refreshIdentity)
            if (navigator.locks) {
                await navigator.locks.request("trustgram:spk-rotate", { ifAvailable: true }, async lock => {
                    if (!lock) return
                    await run()
                })
            } else {
                await run()
            }
        }
    } catch (e) {
        console.warn("[TrustGram] SPK rotation failed:", e?.message ?? e)
    }
}

export default function App() {
    const [identity, setIdentity] = useState(null)
    const [storageKey, setStorageKey] = useState(null)
    // Raw 32-byte storage key, kept in RAM while unlocked. Needed to re-bind on
    // PIN change/disable. Null when storage is legacy (non-extractable) or locked.
    const [storageKeyBytes, setStorageKeyBytes] = useState(null)
    const [loading, setLoading] = useState(true)
    const [activeChat, setActiveChat] = useState(null)
    const [locked, setLocked] = useState(false)
    const [pinScreen, setPinScreen] = useState(null) // null | "setup" | "change" | "disable"
    const [exportOpen, setExportOpen] = useState(false)
    const [exportTab, setExportTab] = useState("export")
    const lastActivityRef = useRef(Date.now())

    useEffect(() => {
        const initData = window.Telegram?.WebApp?.initData || null

        async function bootstrap() {
            const saved = await loadIdentity()
            if (saved) setIdentity(saved)

            const mode = await getStorageKeyMode()
            if (mode === "encrypted") {
                // PIN required — leave storageKey null, show PinLock.
                setLocked(true)
            } else {
                const result = await getUnencryptedStorageKey()
                if (result) {
                    setStorageKey(result.storageKey)
                    setStorageKeyBytes(result.rawBytes)
                    if (saved) {
                        const refresh = async () => {
                            const refreshed = await loadIdentity()
                            if (refreshed) setIdentity(refreshed)
                        }
                        checkKeyHealth(saved, result.storageKey, initData, refresh).catch(() => {})
                    }
                    if (shouldLockOnOpen()) setLocked(true)
                }
            }
        }

        bootstrap().catch(console.error).finally(() => setLoading(false))
    }, [])

    useEffect(() => {
        const resetActivity = () => {
            lastActivityRef.current = Date.now()
            updateLastActivity()
        }

        const checkLock = () => {
            if (!hasPin()) return
            const interval = getLockInterval()
            if (interval === null) return
            if (interval === 0 || Date.now() - lastActivityRef.current >= interval) {
                // Drop the in-RAM key so a memory dump after lock can't see it.
                setStorageKey(null)
                setStorageKeyBytes(null)
                setLocked(true)
            }
        }

        document.addEventListener("click", resetActivity)
        document.addEventListener("touchstart", resetActivity)
        document.addEventListener("keydown", resetActivity)
        document.addEventListener("visibilitychange", checkLock)

        return () => {
            document.removeEventListener("click", resetActivity)
            document.removeEventListener("touchstart", resetActivity)
            document.removeEventListener("keydown", resetActivity)
            document.removeEventListener("visibilitychange", checkLock)
        }
    }, [])

    async function handleSetupDone(newIdentity) {
        await saveIdentity(newIdentity)
        setIdentity(newIdentity)
        // First-launch storage key was provisioned during bootstrap.
        if (!storageKey) {
            const result = await getUnencryptedStorageKey()
            if (result) {
                setStorageKey(result.storageKey)
                setStorageKeyBytes(result.rawBytes)
            }
        }
    }

    async function handleIdentityRefresh() {
        const refreshed = await loadIdentity()
        if (refreshed) setIdentity(refreshed)
    }

    async function handleUnlock({ storageKey: sk, rawBytes }) {
        setStorageKey(sk)
        setStorageKeyBytes(rawBytes)
        setLocked(false)
    }

    async function handleResetKeys() {
        await clearAllMessages()
        clearContacts()
        clearLockState()
        // clearIdentity() handles spk_rotated_at, otk_last_check, and pending_spk
        // in IDB plus their legacy localStorage mirrors.
        localStorage.removeItem("tg_otk_remaining")
        await clearIdentity()
        setIdentity(null)
        setStorageKey(null)
        setStorageKeyBytes(null)
        const result = await getUnencryptedStorageKey()
        if (result) {
            setStorageKey(result.storageKey)
            setStorageKeyBytes(result.rawBytes)
        }
    }

    if (loading) {
        return (
            <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Spinner size="l" />
            </div>
        )
    }

    if (locked) return <PinLock onUnlock={handleUnlock} />

    if (!identity) return <Setup onDone={handleSetupDone} />

    if (pinScreen) {
        return (
            <PinSetup
                mode={pinScreen}
                storageKeyBytes={storageKeyBytes}
                onDone={() => setPinScreen(null)}
                onCancel={() => setPinScreen(null)}
            />
        )
    }

    if (exportOpen) {
        return <ExportImport storageKey={storageKey} defaultTab={exportTab} onBack={() => setExportOpen(false)} />
    }

    if (activeChat) {
        return (
            <Chat
                identity={identity}
                storageKey={storageKey}
                contactId={activeChat.id}
                contactName={activeChat.name}
                onBack={() => setActiveChat(null)}
                onIdentityRefresh={handleIdentityRefresh}
            />
        )
    }

    return (
        <ChatList
            identity={identity}
            onOpenChat={setActiveChat}
            onResetKeys={handleResetKeys}
            onPinSettings={mode => setPinScreen(mode)}
            onExport={() => { setExportTab("export"); setExportOpen(true) }}
            onImport={() => { setExportTab("import"); setExportOpen(true) }}
            storageKey={storageKey}
        />
    )
}
