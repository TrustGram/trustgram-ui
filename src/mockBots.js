export const MOCK_BOTS = {
    1: "Echo Bot 1",
    2: "Echo Bot 2",
    3: "Echo Bot 3",
}

export function isMockBot(contactId) {
    return contactId in MOCK_BOTS
}

export function mockBotName(contactId) {
    return MOCK_BOTS[contactId] ?? contactId
}

export function mockReply(contactId, text) {
    return new Promise(resolve =>
        setTimeout(() => {
            resolve({
                id: Date.now(),
                from: "them",
                text: `Ответ пользователя ${contactId}: ${text}`,
                timestamp: new Date().toISOString(),
            })
        }, 800)
    )
}
