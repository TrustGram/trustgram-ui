const PREFIX = "tg_conv_"

export function getConvState(contactId) {
    return localStorage.getItem(`${PREFIX}${contactId}`) || "new"
}

export function setConvState(contactId, state) {
    localStorage.setItem(`${PREFIX}${contactId}`, state)
}
