import React, { useState, useEffect } from "react"
import { setLockInterval, getLockInterval } from "../pin"
import {
    bindStorageKeyToPin, rebindStorageKeyToPin, unbindStorageKeyFromPin,
    unlockStorageKey, getPinLength,
} from "../storage"

const NUMPAD = ["1","2","3","4","5","6","7","8","9","","0","⌫"]

// Note: the "Immediately" option still has a small grace window (~5s) so the
// system file picker / share sheet / OS permission prompts don't trigger a
// lock-and-PIN-prompt cycle every time the user attaches a file. See App.jsx.
const INTERVALS = [
    { label: "When I leave (5 sec)", value: 0 },
    { label: "After 1 minute", value: 60_000 },
    { label: "After 5 minutes", value: 300_000 },
    { label: "After 30 minutes", value: 1_800_000 },
    { label: "Never", value: null },
]

function PinDots({ value, error, length }) {
    const gap = length === 6 ? 12 : 18
    return (
        <div style={{ display: "flex", gap, justifyContent: "center", margin: "24px 0 8px" }}>
            {Array.from({ length }, (_, i) => (
                <div key={i} style={{
                    width: 14, height: 14, borderRadius: "50%",
                    background: i < value.length ? (error ? "#ff6b6b" : "#6ab3f3") : "transparent",
                    border: `2px solid ${error ? "#ff6b6b" : "#6ab3f3"}`,
                    transition: "background 0.1s",
                }} />
            ))}
        </div>
    )
}

function Numpad({ onDigit }) {
    return (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16 }}>
            {NUMPAD.map((d, i) => (
                <button key={i} onClick={() => d && onDigit(d)} disabled={!d}
                    style={{
                        width: 72, height: 72, borderRadius: "50%", fontSize: d === "⌫" ? 22 : 24,
                        fontWeight: 500, border: "none", cursor: d ? "pointer" : "default",
                        background: d ? "#1f2b38" : "transparent", color: d ? "#fff" : "transparent",
                    }}
                >{d}</button>
            ))}
        </div>
    )
}

function LengthToggle({ value, onChange }) {
    // Lets the user choose between a 4- or 6-digit PIN. 6 is 100× the
    // search space, which matters for offline brute against an exfiltrated
    // IDB copy (the in-app brute is already throttled by the cooldown ladder).
    return (
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 16 }}>
            {[4, 6].map(opt => {
                const active = value === opt
                return (
                    <button
                        key={opt}
                        onClick={() => onChange(opt)}
                        style={{
                            padding: "6px 16px",
                            borderRadius: 999,
                            border: `1px solid ${active ? "#6ab3f3" : "rgba(106,179,243,0.25)"}`,
                            background: active ? "rgba(106,179,243,0.15)" : "transparent",
                            color: active ? "#e8f0f7" : "#708499",
                            fontSize: 12.5,
                            fontWeight: active ? 600 : 500,
                            cursor: "pointer",
                            letterSpacing: "0.2px",
                            transition: "background 0.15s, border-color 0.15s, color 0.15s",
                        }}
                    >
                        {opt} digits
                    </button>
                )
            })}
        </div>
    )
}

// mode: "setup" | "change" | "disable"
// storageKeyBytes: raw 32-byte storage key from the unlocked session. Required
// for setup/change (to encrypt it) and disable (to persist it back as raw).
export default function PinSetup({ mode = "setup", storageKeyBytes, onDone, onCancel }) {
    const steps = mode === "setup"
        ? ["enter", "confirm", "interval"]
        : mode === "change"
            ? ["verify_old", "enter", "confirm", "interval"]
            : ["verify_old"] // disable

    const [step, setStep] = useState(0)
    const [pin, setPin_] = useState("")
    const [firstPin, setFirstPin] = useState("")
    // Cached raw bytes after verify_old succeeded — needed to re-bind in change mode.
    const [unlockedBytes, setUnlockedBytes] = useState(null)
    const [error, setError] = useState("")
    const [interval, setInterval_] = useState(getLockInterval() ?? 0)
    const [shake, setShake] = useState(false)
    // Default to 6 for fresh setup; for change mode load the current length so
    // the toggle pre-selects what the user already has.
    const [pinLength, setPinLength] = useState(mode === "setup" ? 6 : 4)

    useEffect(() => {
        if (mode !== "setup") getPinLength().then(setPinLength).catch(() => {})
    }, [mode])

    const currentStep = steps[step]
    // Old-PIN verification always uses the stored length, even if the user is
    // about to change it. Showing the toggle is only for the new PIN.
    const expectedLen = currentStep === "verify_old" ? pinLength : pinLength
    const showLengthToggle = currentStep === "enter"

    function triggerShake(msg) {
        setShake(true); setTimeout(() => setShake(false), 400)
        setError(msg); setPin_("")
    }

    function handleLengthChange(newLength) {
        if (newLength === pinLength) return
        setPinLength(newLength)
        setPin_("")
        setError("")
    }

    async function handleDigit(d) {
        if (d === "⌫") { setPin_(p => p.slice(0, -1)); setError(""); return }
        const next = pin + d
        setPin_(next)
        if (next.length < expectedLen) return

        if (currentStep === "verify_old") {
            const result = await unlockStorageKey(next)
            if (!result) { triggerShake("Wrong PIN"); return }
            if (mode === "disable") {
                try { await unbindStorageKeyFromPin(result.rawBytes) } catch (e) { triggerShake(e.message); return }
                onDone(); return
            }
            setUnlockedBytes(result.rawBytes)
            setPin_(""); setError(""); setStep(s => s + 1)
        } else if (currentStep === "enter") {
            setFirstPin(next); setPin_(""); setError(""); setStep(s => s + 1)
        } else if (currentStep === "confirm") {
            if (next !== firstPin) { triggerShake("PINs don't match"); return }
            try {
                if (mode === "change") {
                    await rebindStorageKeyToPin(next, unlockedBytes, pinLength)
                } else {
                    // setup: use the bytes the app passed in
                    await bindStorageKeyToPin(next, storageKeyBytes, pinLength)
                }
            } catch (e) {
                triggerShake(e.message)
                return
            }
            if (steps.includes("interval")) { setPin_(""); setError(""); setStep(s => s + 1) }
            else { setLockInterval(interval); onDone() }
        }
    }

    function handleIntervalDone() {
        setLockInterval(interval)
        onDone()
    }

    const titles = {
        verify_old: "Enter current PIN",
        enter: mode === "setup" ? "Set a new PIN" : "Enter new PIN",
        confirm: "Confirm PIN",
        interval: "Auto-lock after",
    }

    if (currentStep === "interval") {
        return (
            <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#17212b", padding: "0 24px" }}>
                <div style={{ fontSize: 17, fontWeight: 600, color: "#fff", marginBottom: 24 }}>Auto-lock after</div>
                <div style={{ width: "100%", maxWidth: 320, display: "flex", flexDirection: "column", gap: 8 }}>
                    {INTERVALS.map(opt => (
                        <button key={String(opt.value)} onClick={() => setInterval_(opt.value)}
                            style={{
                                padding: "14px 18px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 15, textAlign: "left",
                                background: interval === opt.value ? "#2b5278" : "#1f2b38",
                                color: interval === opt.value ? "#fff" : "#a0b8cc",
                            }}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
                <button onClick={handleIntervalDone}
                    style={{ marginTop: 28, padding: "12px 40px", borderRadius: 22, border: "none", background: "#2b5278", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
                >
                    Done
                </button>
                {onCancel && <button onClick={onCancel} style={{ marginTop: 12, background: "none", border: "none", color: "#708499", fontSize: 14, cursor: "pointer" }}>Cancel</button>}
            </div>
        )
    }

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#17212b" }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "#fff" }}>{titles[currentStep]}</div>
            {showLengthToggle && <LengthToggle value={pinLength} onChange={handleLengthChange} />}
            <div style={{ animation: shake ? "shake 0.4s" : "none" }}>
                <PinDots value={pin} error={!!error} length={expectedLen} />
            </div>
            {error
                ? <div style={{ fontSize: 13, color: "#ff6b6b", marginBottom: 8 }}>{error}</div>
                : <div style={{ height: 21 }} />
            }
            <Numpad onDigit={handleDigit} />
            {onCancel && (
                <button onClick={onCancel} style={{ marginTop: 20, background: "none", border: "none", color: "#708499", fontSize: 14, cursor: "pointer" }}>Cancel</button>
            )}
            <style>{`@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-8px)} 40%,80%{transform:translateX(8px)} }`}</style>
        </div>
    )
}
