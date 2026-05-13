import React, { useEffect, useState } from "react"
import {
    List,
    Cell,
    Avatar,
    Button,
    Spinner,
    Modal,
    Input,
    Placeholder,
} from "@telegram-apps/telegram-ui"
import { fetchInbox, fetchBundleByUsername } from "../api"
import { MOCK_BOTS } from "../mockBots"

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
    return Array.from(map.values()).sort(
        (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    )
}

export default function ChatList({ onOpenChat }) {
    const [conversations, setConversations] = useState([])
    const [loading, setLoading] = useState(true)
    const [newChatOpen, setNewChatOpen] = useState(false)
    const [recipientId, setRecipientId] = useState("")

    useEffect(() => {
        const mocks = Object.entries(MOCK_BOTS).map(([id, name]) => ({
            sender_id: Number(id),
            name,
            timestamp: new Date(0).toISOString(),
            isMock: true,
        }))
        fetchInbox(getInitData())
            .then(data => {
                const real = groupByContact(data.messages)
                const realIds = new Set(real.map(m => m.sender_id))
                const uniqueMocks = mocks.filter(m => !realIds.has(m.sender_id))
                setConversations([...real, ...uniqueMocks])
            })
            .catch(() => setConversations(mocks))
            .finally(() => setLoading(false))
    }, [])

    async function handleNewChat() {
        const input = recipientId.trim()
        if (!input) return

        const isUsername = isNaN(input.replace(/^@/, ""))
        if (isUsername) {
            try {
                const bundle = await fetchBundleByUsername(input, window.Telegram?.WebApp?.initData || null)
                setNewChatOpen(false)
                setRecipientId("")
                onOpenChat(bundle.telegram_id)
            } catch {
                alert("User not found")
            }
        } else {
            setNewChatOpen(false)
            setRecipientId("")
            onOpenChat(parseInt(input, 10))
        }
    }

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 20, fontWeight: 600 }}>TrustGram</span>
                <Button size="s" onClick={() => setNewChatOpen(true)}>New chat</Button>
            </div>

            {loading ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Spinner size="l" />
                </div>
            ) : conversations.length === 0 ? (
                <Placeholder
                    header="No chats yet"
                    description="Start a new conversation by pressing 'New chat'"
                />
            ) : (
                <List>
                    {conversations.map(msg => (
                        <Cell
                            key={msg.sender_id}
                            before={<Avatar>{String(msg.sender_id).slice(-2)}</Avatar>}
                            subtitle={msg.isMock ? "Test bot" : new Date(msg.timestamp).toLocaleString()}
                            onClick={() => onOpenChat(msg.sender_id)}
                        >
                            {msg.name ?? msg.sender_id}
                        </Cell>
                    ))}
                </List>
            )}

            <Modal open={newChatOpen} onOpenChange={setNewChatOpen} header={<Modal.Header>New chat</Modal.Header>}>
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                    <Input
                        placeholder="@username or Telegram ID"
                        value={recipientId}
                        onChange={e => setRecipientId(e.target.value)}
                    />
                    <Button onClick={handleNewChat}>Start chat</Button>
                </div>
            </Modal>
        </div>
    )
}
