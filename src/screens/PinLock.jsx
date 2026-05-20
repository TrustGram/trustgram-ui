import React, { useState } from "react"
import { verifyPin } from "../pin"

const NUMPAD = ["1","2","3","4","5","6","7","8","9","","0","⌫"]
const PIN_LENGTH = 4
const MAX_ATTEMPTS = 5

const CSS = `
  .pin-root { scrollbar-width: none; }
  .pin-root::-webkit-scrollbar { display: none; }

  .pin-lock-icon { display: flex; }
  @media (max-height: 630px) { .pin-lock-icon { display: none !important; } }

  /* Fluid numpad sizing — scales with viewport height */
  .pin-numpad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(7px, 1.5vh, 12px); }
  .pin-numpad-btn  { width: clamp(60px, 11vh, 82px); height: clamp(60px, 11vh, 82px); }
  .pin-numpad-fs   { font-size: clamp(20px, 4vh, 30px); }
  .pin-numpad-del  { font-size: clamp(17px, 3.2vh, 22px); }
  .pin-top         { padding-top: clamp(12px, 4vh, 32px); padding-bottom: clamp(6px, 1.5vh, 12px); }
  .pin-dots-wrap   { margin: clamp(14px, 2.8vh, 32px) 0 clamp(10px, 2.2vh, 28px); }
  .pin-err-wrap    { height: clamp(26px, 4vh, 34px); }

  @keyframes shake {
    0%,100%{ transform:translateX(0) }
    15%,45%,75%{ transform:translateX(-8px) }
    30%,60%,90%{ transform:translateX(8px) }
  }
  @keyframes lockPulse {
    0%{ transform:scale(1); box-shadow:0 12px 40px rgba(0,0,0,0.5), 0 0 0 0 rgba(106,179,243,0.3); }
    50%{ transform:scale(0.93); box-shadow:0 6px 20px rgba(0,0,0,0.4), 0 0 0 12px rgba(106,179,243,0); }
    100%{ transform:scale(1); box-shadow:0 12px 40px rgba(0,0,0,0.5), 0 0 0 0 rgba(106,179,243,0); }
  }
  @keyframes dotPop {
    0%{ transform:scale(0.6) }
    60%{ transform:scale(1.25) }
    100%{ transform:scale(1.1) }
  }
  .pin-key {
    transition: background 0.1s, transform 0.08s, box-shadow 0.1s !important;
    -webkit-tap-highlight-color: transparent;
    outline: none !important;
  }
  .pin-key:not(:disabled):active {
    transform: scale(0.88) !important;
    background: rgba(43,82,120,0.85) !important;
  }
`

function PinDots({ value, shake }) {
    return (
        <div className="pin-dots-wrap" style={{
            display: "flex", gap: 20, justifyContent: "center",
            animation: shake ? "shake 0.5s" : "none",
        }}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => {
                const filled = i < value.length
                return (
                    <div key={i} style={{
                        width: 16, height: 16, borderRadius: "50%",
                        background: filled ? "#6ab3f3" : "transparent",
                        border: `2px solid ${filled ? "#6ab3f3" : "rgba(106,179,243,0.25)"}`,
                        boxShadow: filled ? "0 0 14px rgba(106,179,243,0.7), 0 0 30px rgba(106,179,243,0.2)" : "none",
                        transform: filled ? "scale(1.1)" : "scale(1)",
                        animation: filled ? "dotPop 0.2s ease-out forwards" : "none",
                        transition: "border-color 0.2s, background 0.2s",
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
    const [lockAnim, setLockAnim] = useState(false)

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
            setLockAnim(true)
            setTimeout(() => { setShake(false); setLockAnim(false) }, 600)
            setPin("")
            setError(newAttempts >= MAX_ATTEMPTS
                ? "Too many attempts. Restart the app."
                : `Wrong PIN · ${MAX_ATTEMPTS - newAttempts} ${MAX_ATTEMPTS - newAttempts === 1 ? "try" : "tries"} left`
            )
        }
    }

    return (
        <div className="pin-root" style={{
            minHeight: "100vh",
            minHeight: "100dvh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            background: "radial-gradient(ellipse 100% 70% at 50% 0%, #1c3550 0%, #17212b 55%)",
            boxSizing: "border-box",
            userSelect: "none",
            overflowY: "auto",
        }}>
            <style>{CSS}</style>

            {/* Top region: flex:1 centers content vertically when screen is tall enough.
                minHeight:fit-content prevents the region from collapsing below content height,
                so justifyContent:center never clips the icon at the top. */}
            <div className="pin-top" style={{
                flex: 1,
                minHeight: "fit-content",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                width: "100%", boxSizing: "border-box",
            }}>
                {/* Lock icon — hidden via CSS on viewports shorter than 630px */}
                <div className="pin-lock-icon" style={{
                    animation: lockAnim ? "lockPulse 0.55s ease" : "none",
                    width: 96, height: 96, borderRadius: 30,
                    background: "linear-gradient(150deg, #213d5a 0%, #152d47 100%)",
                    border: "1px solid rgba(106,179,243,0.2)",
                    boxShadow: "0 12px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    marginBottom: 24,
                }}>
                    <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="#6ab3f3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2.5"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                </div>

                <div style={{ fontSize: 22, fontWeight: 700, color: "#e8f0f7", letterSpacing: "-0.5px" }}>
                    TrustGram
                </div>
                <div style={{ fontSize: 14, color: "#708499", marginTop: 6, letterSpacing: "0.1px" }}>
                    Enter your PIN to continue
                </div>

                <PinDots value={pin} shake={shake} />

                <div className="pin-err-wrap" style={{ display: "flex", alignItems: "center" }}>
                    {error && (
                        <div style={{
                            fontSize: 12.5, color: "#ff9090",
                            background: "rgba(255,80,80,0.09)",
                            border: "1px solid rgba(255,80,80,0.2)",
                            borderRadius: 20, padding: "6px 16px",
                            letterSpacing: "0.1px",
                        }}>{error}</div>
                    )}
                </div>
            </div>

            {/* Numpad */}
            <div style={{
                paddingBottom: "max(28px, env(safe-area-inset-bottom, 28px))",
                paddingTop: 8, flexShrink: 0,
            }}>
                <div className="pin-numpad-grid">
                    {NUMPAD.map((d, i) => (
                        <button
                            key={i}
                            className={`pin-key pin-numpad-btn ${d === "⌫" ? "pin-numpad-del" : d ? "pin-numpad-fs" : ""}`}
                            onClick={() => handleDigit(d)}
                            disabled={!d || attempts >= MAX_ATTEMPTS}
                            style={{
                                borderRadius: "50%",
                                fontWeight: d === "⌫" ? 400 : 300,
                                border: "none",
                                cursor: d ? "pointer" : "default",
                                background: d ? "rgba(31,43,56,0.95)" : "transparent",
                                color: d ? "#e8f0f7" : "transparent",
                                boxShadow: d ? "0 3px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)" : "none",
                                fontFamily: "inherit",
                                opacity: attempts >= MAX_ATTEMPTS && d ? 0.4 : 1,
                            }}
                        >
                            {d}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}
