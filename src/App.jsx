import React, { useEffect, useRef, useState } from "react"
import { Spinner } from "@telegram-apps/telegram-ui"
import Setup from "./screens/Setup"
import ChatList from "./screens/ChatList"
import Chat from "./screens/Chat"
import PinLock from "./screens/PinLock"
import PinSetup from "./screens/PinSetup"
import ExportImport from "./screens/ExportImport"
import { loadIdentity, saveIdentity, clearIdentity, getOrCreateStorageKey } from "./storage"
import { clearAllMessages } from "./messageStore"
import { clearContacts } from "./contacts"
import { hasPin, clearPin, shouldLockOnOpen, updateLastActivity, getLockInterval } from "./pin"

export default function App() {
    const [identity, setIdentity] = useState(null)
    const [storageKey, setStorageKey] = useState(null)
    const [loading, setLoading] = useState(true)
    const [activeChat, setActiveChat] = useState(null)
    const [locked, setLocked] = useState(false)
    const [pinScreen, setPinScreen] = useState(null) // null | "setup" | "change" | "disable"
    const [exportOpen, setExportOpen] = useState(false)
    const lastActivityRef = useRef(Date.now())

    useEffect(() => {
        Promise.all([loadIdentity(), getOrCreateStorageKey()])
            .then(([saved, key]) => {
                if (saved) setIdentity(saved)
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
        return <ExportImport storageKey={storageKey} onBack={() => setExportOpen(false)} />
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
            onExport={() => setExportOpen(true)}
        />
    )
}
