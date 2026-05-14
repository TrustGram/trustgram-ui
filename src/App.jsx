import React, { useEffect, useState } from "react"
import { Spinner } from "@telegram-apps/telegram-ui"
import Setup from "./screens/Setup"
import ChatList from "./screens/ChatList"
import Chat from "./screens/Chat"
import { loadIdentity, saveIdentity, clearIdentity } from "./storage"

export default function App() {
    const [identity, setIdentity] = useState(null)
    const [loading, setLoading] = useState(true)
    const [activeChat, setActiveChat] = useState(null)

    useEffect(() => {
        loadIdentity()
            .then(saved => { if (saved) setIdentity(saved) })
            .catch(console.error)
            .finally(() => setLoading(false))
    }, [])

    async function handleSetupDone(newIdentity) {
        await saveIdentity(newIdentity)
        setIdentity(newIdentity)
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
                contactId={activeChat.id}
                contactName={activeChat.name}
                onBack={() => setActiveChat(null)}
            />
        )
    }

    async function handleResetKeys() {
        await clearIdentity()
        setIdentity(null)
    }

    return <ChatList identity={identity} onOpenChat={setActiveChat} onResetKeys={handleResetKeys} />
}
