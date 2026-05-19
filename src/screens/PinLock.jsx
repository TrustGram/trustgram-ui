import React, { useState } from "react"
import { verifyPin } from "../pin"

const NUMPAD = ["1","2","3","4","5","6","7","8","9","","0","⌫"]
const PIN_LENGTH = 4
const MAX_ATTEMPTS = 5

function PinDots({ value }) {
    return (
        <div style={{ display: "flex", gap: 18, justifyContent: "center", margin: "28px 0" }}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => (
                <div key={i} style={{
                    width: 14, height: 14, borderRadius: "50%",
                    background: i < value.length ? "#6ab3f3" : "transparent",
                    border: "2px solid #6ab3f3",
                    transition: "background 0.1s",
                }} />
            ))}
        </div>
    )
}

export default function PinLock({ onUnlock }) {
    const [pin, setPin] = useState("")
    const [error, setError] = useState("")
    const [attempts, setAttempts] = useState(0)
    const [checking, setChecking] = useState(false)
    const [shake, setShake] = useState(false)

    async function handleDigit(d) {
        if (checking || attempts >= MAX_ATTEMPTS) return
        if (d === "⌫") { setPin(p => p.slice(0, -1)); setError(""); return }
        if (!d) return
        const next = pin + d
        setPin(next)
        if (next.length < PIN_LENGTH) return

        setChecking(true)
        const ok = await verifyPin(next)
        setChecking(false)

        if (ok) {
            onUnlock()
        } else {
            const newAttempts = attempts + 1
            setAttempts(newAttempts)
            setShake(true)
            setTimeout(() => setShake(false), 400)
            setPin("")
            setError(newAttempts >= MAX_ATTEMPTS
                ? "Too many attempts. Restart the app."
                : `Wrong PIN. ${MAX_ATTEMPTS - newAttempts} attempts left.`
            )
        }
    }

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#17212b" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🔒</div>
            <div style={{ fontSize: 17, fontWeight: 600, color: "#fff" }}>TrustGram locked</div>
            <div style={{ fontSize: 13, color: "#708499", marginTop: 4 }}>Enter your PIN to continue</div>

            <div style={{ animation: shake ? "shake 0.4s" : "none" }}>
                <PinDots value={pin} />
            </div>

            {error && <div style={{ fontSize: 13, color: "#ff6b6b", marginBottom: 12, textAlign: "center", padding: "0 24px" }}>{error}</div>}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 8 }}>
                {NUMPAD.map((d, i) => (
                    <button
                        key={i}
                        onClick={() => handleDigit(d)}
                        disabled={!d || attempts >= MAX_ATTEMPTS}
                        style={{
                            width: 72, height: 72, borderRadius: "50%", fontSize: d === "⌫" ? 22 : 24,
                            fontWeight: 500, border: "none", cursor: d ? "pointer" : "default",
                            background: d ? "#1f2b38" : "transparent",
                            color: d ? "#fff" : "transparent",
                            transition: "background 0.1s",
                        }}
                    >
                        {d}
                    </button>
                ))}
            </div>

            <style>{`@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-8px)} 40%,80%{transform:translateX(8px)} }`}</style>
        </div>
    )
}
