import React, { useState } from "react"
import { verifyPin } from "../pin"

const NUMPAD = ["1","2","3","4","5","6","7","8","9","","0","⌫"]
const PIN_LENGTH = 4
const MAX_ATTEMPTS = 5

const CSS = `
  @keyframes shake {
    0%,100%{ transform:translateX(0) }
    15%,45%,75%{ transform:translateX(-7px) }
    30%,60%,90%{ transform:translateX(7px) }
  }
  @keyframes lockBounce {
    0%{ transform:scale(1) }
    40%{ transform:scale(0.88) }
    70%{ transform:scale(1.08) }
    100%{ transform:scale(1) }
  }
  .pin-key {
    transition: background 0.12s, transform 0.1s, box-shadow 0.12s !important;
    -webkit-tap-highlight-color: transparent;
  }
  .pin-key:not(:disabled):hover {
    background: rgba(43,82,120,0.5) !important;
    box-shadow: 0 0 0 1px rgba(106,179,243,0.15) !important;
  }
  .pin-key:not(:disabled):active {
    background: rgba(43,82,120,0.8) !important;
    transform: scale(0.91) !important;
  }
`

function PinDots({ value }) {
    return (
        <div style={{ display: "flex", gap: 22, justifyContent: "center", margin: "28px 0 22px" }}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => {
                const filled = i < value.length
                return (
                    <div key={i} style={{
                        width: 14, height: 14, borderRadius: "50%",
                        background: filled ? "#6ab3f3" : "transparent",
                        border: "2px solid",
                        borderColor: filled ? "#6ab3f3" : "rgba(106,179,243,0.3)",
                        boxShadow: filled ? "0 0 10px rgba(106,179,243,0.55), 0 0 22px rgba(106,179,243,0.18)" : "none",
                        transform: filled ? "scale(1.15)" : "scale(1)",
                        transition: "all 0.18s cubic-bezier(0.34,1.56,0.64,1)",
                    }} />
                )
            })}
        </div>
    )
}

export default function PinLock({ onUnlock }) {
    const [pin, setPin] = useState("")
    const [error, setError] = useState("")
    const [attempts, setAttempts] = useState(0)
    const [checking, setChecking] = useState(false)
    const [shake, setShake] = useState(false)
    const [lockBounce, setLockBounce] = useState(false)

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
            setLockBounce(true)
            setTimeout(() => { setShake(false); setLockBounce(false) }, 500)
            setPin("")
            setError(newAttempts >= MAX_ATTEMPTS
                ? "Too many attempts. Restart the app."
                : `Wrong PIN · ${MAX_ATTEMPTS - newAttempts} ${MAX_ATTEMPTS - newAttempts === 1 ? "try" : "tries"} left`
            )
        }
    }

    return (
        <div style={{
            height: "100vh",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            background: "radial-gradient(ellipse 80% 60% at 50% 20%, #1a3048 0%, #17212b 70%)",
            userSelect: "none",
        }}>
            <style>{CSS}</style>

            {/* Icon */}
            <div style={{
                animation: lockBounce ? "lockBounce 0.45s ease" : "none",
                width: 68, height: 68, borderRadius: 22,
                background: "linear-gradient(145deg, #1e3a5c 0%, #152d47 100%)",
                border: "1px solid rgba(106,179,243,0.18)",
                boxShadow: "0 8px 28px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06)",
                display: "flex", alignItems: "center", justifyContent: "center",
                marginBottom: 22,
            }}>
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#6ab3f3" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
            </div>

            <div style={{ fontSize: 20, fontWeight: 700, color: "#e8f0f7", letterSpacing: "-0.4px" }}>TrustGram</div>
            <div style={{ fontSize: 13, color: "#708499", marginTop: 5, fontWeight: 400, letterSpacing: "0.1px" }}>Enter your PIN to continue</div>

            <div style={{ animation: shake ? "shake 0.5s" : "none" }}>
                <PinDots value={pin} />
            </div>

            <div style={{ height: 32, display: "flex", alignItems: "center", marginBottom: 12 }}>
                {error && (
                    <div style={{
                        fontSize: 12, color: "#ff8888",
                        background: "rgba(255,100,100,0.08)",
                        border: "1px solid rgba(255,100,100,0.18)",
                        borderRadius: 20, padding: "5px 14px",
                        letterSpacing: "0.1px",
                    }}>{error}</div>
                )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 11 }}>
                {NUMPAD.map((d, i) => (
                    <button
                        key={i}
                        className="pin-key"
                        onClick={() => handleDigit(d)}
                        disabled={!d || attempts >= MAX_ATTEMPTS}
                        style={{
                            width: 78, height: 78, borderRadius: "50%",
                            fontSize: d === "⌫" ? 20 : 28,
                            fontWeight: d === "⌫" ? 400 : 300,
                            border: "none",
                            cursor: d ? "pointer" : "default",
                            background: d ? "rgba(31,43,56,0.9)" : "transparent",
                            color: d ? "#e8f0f7" : "transparent",
                            boxShadow: d ? "0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)" : "none",
                            fontFamily: "inherit",
                        }}
                    >
                        {d}
                    </button>
                ))}
            </div>
        </div>
    )
}
