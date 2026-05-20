import React, { useEffect, useRef, useState } from "react"
import { Spinner } from "@telegram-apps/telegram-ui"
import Setup from "./screens/Setup"
import ChatList from "./screens/ChatList"
import Chat from "./screens/Chat"
import PinLock from "./screens/PinLock"
import PinSetup from "./screens/PinSetup"
import ExportImport from "./screens/ExportImport"
import { loadIdentity, saveIdentity, clearIdentity, getOrCreateStorageKey, appendOTKsToIdentity, updateSPKInIdentity } from "./storage"
import { clearAllMessages } from "./messageStore"
import { clearContacts } from "./contacts"
import { hasPin, clearPin, shouldLockOnOpen, updateLastActivity, getLockInterval } from "./pin"
import { fetchOTKCount, refillOTKs, updateSPK } from "./api"
import { drainInbox } from "./inboxDrain"

const OTK_LOW_WATERMARK = 5
const OTK_BATCH_SIZE = 20
const SPK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

async function checkKeyHealth(identity, storageKey, initData, refreshIdentity) {
    // OTK replenishment
    try {
        const { count } = await fetchOTKCount(initData)
        if (count < OTK_LOW_WATERMARK) {
            const pairs = await Promise.all(
                Array.from({ length: OTK_BATCH_SIZE }, () =>
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
            await appendOTKsToIdentity(oneTimeKeys.map(({ keyPair }) => keyPair))
            await refillOTKs(oneTimeKeys.map(({ key_id, public_key }) => ({ key_id, public_key })), initData)
            await refreshIdentity()
        }
    } catch {}

    // SPK rotation
    try {
        const lastRotated = parseInt(localStorage.getItem("tg_spk_rotated_at") || "0", 10)
        if (Date.now() - lastRotated > SPK_MAX_AGE_MS) {
            // drain inbox first so no in-flight messages are lost
            await drainInbox(identity, storageKey, initData)

            const newSpkKeyPair = await crypto.subtle.generateKey(
                { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"]
            )
            const raw = await crypto.subtle.exportKey("raw", newSpkKeyPair.publicKey)
            const pub = btoa(String.fromCharCode(...new Uint8Array(raw)))

            // upload to server first; only persist locally on success
            await updateSPK(pub, "", initData)
            await updateSPKInIdentity(newSpkKeyPair)
            localStorage.setItem("tg_spk_rotated_at", String(Date.now()))
            await refreshIdentity()
        }
    } catch {}
}

export default function App() {
    const [identity, setIdentity] = useState(null)
    const [storageKey, setStorageKey] = useState(null)
    const [loading, setLoading] = useState(true)
    const [activeChat, setActiveChat] = useState(null)
    const [locked, setLocked] = useState(false)
    const [pinScreen, setPinScreen] = useState(null) // null | "setup" | "change" | "disable"
    const [exportOpen, setExportOpen] = useState(false)
    const [exportTab, setExportTab] = useState("export")
    const lastActivityRef = useRef(Date.now())

    useEffect(() => {
        const initData = window.Telegram?.WebApp?.initData || null
        Promise.all([loadIdentity(), getOrCreateStorageKey()])
            .then(([saved, key]) => {
                if (saved) {
                    setIdentity(saved)
                    const refresh = async () => {
                        const refreshed = await loadIdentity()
                        if (refreshed) setIdentity(refreshed)
                    }
                    checkKeyHealth(saved, key, initData, refresh).catch(() => {})
                }
                setStorageKey(key)
                if (shouldLockOnOpen()) setLocked(true)
            })
            .catch(console.error)
            .finally(() => setLoading(false))
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
            if (interval === 0 || Date.now() - lastActivityRef.current >= interval) setLocked(true)
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
    }

    async function handleIdentityRefresh() {
        const refreshed = await loadIdentity()
        if (refreshed) setIdentity(refreshed)
    }

    async function handleResetKeys() {
        clearAllMessages()
        clearContacts()
        clearPin()
        localStorage.removeItem("tg_otk_remaining")
        localStorage.removeItem("tg_spk_rotated_at")
        localStorage.removeItem("tg_otk_last_check")
        await clearIdentity()
        setIdentity(null)
        const newKey = await getOrCreateStorageKey()
        setStorageKey(newKey)
    }

    if (loading) {
        return (
            <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Spinner size="l" />
            </div>
        )
    }

    if (!identity) return <Setup onDone={handleSetupDone} />

    if (locked) return <PinLock onUnlock={() => setLocked(false)} />

    if (pinScreen) {
        return (
            <PinSetup
                mode={pinScreen}
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
            onOpenChat={setActiveChat}
            onResetKeys={handleResetKeys}
            onPinSettings={mode => setPinScreen(mode)}
            onExport={() => { setExportTab("export"); setExportOpen(true) }}
            onImport={() => { setExportTab("import"); setExportOpen(true) }}
            storageKey={storageKey}
        />
    )
}
