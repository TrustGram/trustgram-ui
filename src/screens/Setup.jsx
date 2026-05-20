import React, { useEffect, useState } from "react"
import { Button, Placeholder, Spinner } from "@telegram-apps/telegram-ui"
import { createIdentity, getPublicBundle } from "../crypto"
import { registerBundle } from "../api"

const STATUS = {
    IDLE: "idle",
    GENERATING: "generating",
    UPLOADING: "uploading",
    DONE: "done",
    ERROR: "error",
}

export default function Setup({ onDone }) {
    const [status, setStatus] = useState(STATUS.IDLE)
    const [error, setError] = useState(null)

    useEffect(() => { handleSetup() }, [])

    async function handleSetup() {
        try {
            setStatus(STATUS.GENERATING)
            const identity = await createIdentity()
            const publicBundle = await getPublicBundle(identity)

            setStatus(STATUS.UPLOADING)
            const initData = window.Telegram?.WebApp?.initData || null

            await registerBundle({
                identity_key: publicBundle.identityKey,
                signed_pre_key: publicBundle.signedPreKey,
                signature: "",
                one_time_keys: publicBundle.oneTimePreKeys.map((pub, i) => ({
                    key_id: String(i),
                    public_key: pub,
                })),
            }, initData)

            localStorage.setItem("tg_spk_rotated_at", String(Date.now()))
            setStatus(STATUS.DONE)
            setTimeout(() => onDone(identity), 800)
        } catch (e) {
            setError(e.message)
            setStatus(STATUS.ERROR)
        }
    }

    if (status === STATUS.GENERATING || status === STATUS.UPLOADING) {
        return (
            <Placeholder
                header={status === STATUS.GENERATING ? "Generating keys..." : "Uploading..."}
                description="This only happens once"
            >
                <Spinner size="l" />
            </Placeholder>
        )
    }

    if (status === STATUS.DONE) {
        return (
            <Placeholder
                header="You're set up!"
                description="Your keys have been registered"
            />
        )
    }

    if (status === STATUS.ERROR) {
        return (
            <Placeholder
                header="Something went wrong"
                description={error}
            >
                <Button onClick={() => setStatus(STATUS.IDLE)}>Try again</Button>
            </Placeholder>
        )
    }

    return (
        <Placeholder
            header="Welcome to TrustGram"
            description="To start chatting, we need to generate your encryption keys. They never leave your device."
        >
            <Button size="l" onClick={handleSetup}>
                Generate keys
            </Button>
        </Placeholder>
    )
}
