import React, { useEffect, useState } from "react"
import { Spinner } from "@telegram-apps/telegram-ui"
import Setup from "./screens/Setup"
import ChatList from "./screens/ChatList"
import Chat from "./screens/Chat"
import { loadIdentity, saveIdentity, clearIdentity, getOrCreateStorageKey } from "./storage"
import { clearAllMessages } from "./messageStore"
import { clearContacts } from "./contacts"

export default function App() {
    const [identity, setIdentity] = useState(null)
    const [storageKey, setStorageKey] = useState(null)
    const [loading, setLoading] = useState(true)
    const [activeChat, setActiveChat] = useState(null)

    useEffect(() => {
        Promise.all([loadIdentity(), getOrCreateStorageKey()])
            .then(([saved, key]) => {
                if (saved) setIdentity(saved)
                setStorageKey(key)
            })
            .catch(console.error)
            .finally(() => setLoading(false))
    }, [])

    async function handleSetupDone(newIdentity) {
        await saveIdentity(newIdentity)
        setIdentity(newIdentity)
    }

    async function handleResetKeys() {
        clearAllMessages()
        clearContacts()
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

    if (!identity) {
        return <Setup onDone={handleSetupDone} />
    }

    if (activeChat) {
        return (
            <Chat
                identity={identity}
                storageKey={storageKey}
                contactId={activeChat.id}
                contactName={activeChat.name}
                onBack={() => setActiveChat(null)}
            />
        )
    }

    return <ChatList onOpenChat={setActiveChat} onResetKeys={handleResetKeys} />
}
