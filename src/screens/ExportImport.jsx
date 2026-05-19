import React, { useRef, useState } from "react"
import { Spinner } from "@telegram-apps/telegram-ui"
import { exportChats, importChats, formatCode } from "../export"

export default function ExportImport({ storageKey, onBack, defaultTab = "export" }) {
    const [tab, setTab] = useState(defaultTab) // "export" | "import"

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#17212b" }}>
            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, background: "#1f2b38", borderBottom: "1px solid #2a3a4a", flexShrink: 0 }}>
                <button onClick={onBack} style={{ background: "none", border: "none", color: "#6ab3f3", cursor: "pointer", padding: "4px", display: "flex", alignItems: "center" }}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <span style={{ fontWeight: 600, fontSize: 16 }}>Backup & Restore</span>
            </div>

            <div style={{ display: "flex", borderBottom: "1px solid #2a3a4a", flexShrink: 0 }}>
                {["export", "import"].map(t => (
                    <button key={t} onClick={() => setTab(t)} style={{
                        flex: 1, padding: "12px 0", background: "none", border: "none",
                        borderBottom: tab === t ? "2px solid #6ab3f3" : "2px solid transparent",
                        color: tab === t ? "#6ab3f3" : "#708499", fontSize: 15, fontWeight: 600, cursor: "pointer",
                    }}>
                        {t === "export" ? "Export" : "Import"}
                    </button>
                ))}
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px" }}>
                {tab === "export"
                    ? <ExportTab storageKey={storageKey} />
                    : <ImportTab storageKey={storageKey} onDone={onBack} />
                }
            </div>
        </div>
    )
}

function ExportTab({ storageKey }) {
    const [state, setState] = useState("idle") // idle | loading | done | error
    const [code, setCode] = useState("")
    const [error, setError] = useState("")
    const [copied, setCopied] = useState(false)

    async function handleExport() {
        setState("loading")
        try {
            const { payload, code: backupCode } = await exportChats(storageKey)
            const blob = new Blob([payload], { type: "application/json" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = `trustgram_backup_${new Date().toISOString().slice(0, 10)}.trustgram`
            a.click()
            URL.revokeObjectURL(url)
            setCode(backupCode)
            setState("done")
        } catch (e) {
            setError(e.message)
            setState("error")
        }
    }

    async function copyCode() {
        await navigator.clipboard.writeText(code).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    if (state === "done") {
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ background: "#1f2b38", borderRadius: 12, padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
                    <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Backup file downloaded</div>
                    <div style={{ fontSize: 13, color: "#708499", lineHeight: 1.5 }}>
                        Save the backup code below — you'll need it to restore your chats. Without it the file cannot be decrypted.
                    </div>
                </div>

                <div style={{ background: "#1f2b38", borderRadius: 12, padding: 20, textAlign: "center" }}>
                    <div style={{ fontSize: 12, color: "#708499", marginBottom: 12 }}>BACKUP CODE</div>
                    <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: 700, letterSpacing: 2, color: "#6ab3f3", lineHeight: 1.8 }}>
                        {code.split(" ").reduce((rows, word, i) =>
                            i % 3 === 0 ? [...rows, [word]] : [...rows.slice(0, -1), [...rows[rows.length - 1], word]],
                        []).map((row, i) => <div key={i}>{row.join(" ")}</div>)}
                    </div>
                    <button onClick={copyCode} style={{ marginTop: 14, padding: "8px 24px", borderRadius: 20, border: "none", background: copied ? "#27ae60" : "#2b5278", color: "#fff", fontSize: 14, cursor: "pointer" }}>
                        {copied ? "Copied!" : "Copy code"}
                    </button>
                </div>

                <div style={{ fontSize: 12, color: "#708499", textAlign: "center", lineHeight: 1.5 }}>
                    Store the file and code separately in a safe place.
                </div>
            </div>
        )
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#1f2b38", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>What gets exported</div>
                <div style={{ fontSize: 13, color: "#708499", lineHeight: 1.6 }}>
                    All saved chat history from this device, encrypted with a one-time backup code.<br /><br />
                    Encryption keys are <b style={{ color: "#a0b8cc" }}>not included</b> — they stay on your device.
                </div>
            </div>

            {state === "error" && (
                <div style={{ color: "#ff6b6b", fontSize: 13, padding: "10px 14px", background: "#1f2b38", borderRadius: 8 }}>{error}</div>
            )}

            <button onClick={handleExport} disabled={state === "loading"}
                style={{ padding: "14px", borderRadius: 12, border: "none", background: "#2b5278", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                {state === "loading" ? <><Spinner size="s" /> Encrypting...</> : "Export chats"}
            </button>
        </div>
    )
}

function ImportTab({ storageKey, onDone }) {
    const [code, setCode] = useState("")
    const [file, setFile] = useState(null)
    const [state, setState] = useState("idle") // idle | loading | done | error
    const [error, setError] = useState("")
    const [imported, setImported] = useState(0)
    const fileRef = useRef(null)

    async function handleImport() {
        if (!file || !code.trim()) return
        setState("loading")
        try {
            const payload = await file.text()
            const count = await importChats(payload, code, storageKey)
            setImported(count)
            setState("done")
        } catch (e) {
            setError(e.message)
            setState("error")
        }
    }

    if (state === "done") {
        return (
            <div style={{ textAlign: "center", paddingTop: 40 }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
                <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 8 }}>Restored successfully</div>
                <div style={{ fontSize: 14, color: "#708499", marginBottom: 28 }}>
                    {imported} contact{imported !== 1 ? "s" : ""} and their messages restored.
                </div>
                <button onClick={onDone} style={{ padding: "12px 36px", borderRadius: 22, border: "none", background: "#2b5278", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                    Done
                </button>
            </div>
        )
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#1f2b38", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>Restore from backup</div>
                <div style={{ fontSize: 13, color: "#708499", lineHeight: 1.5 }}>
                    Select a <code style={{ color: "#6ab3f3" }}>.trustgram</code> backup file and enter the backup code that was shown when you exported.
                </div>
            </div>

            <button onClick={() => fileRef.current?.click()}
                style={{ padding: 14, borderRadius: 12, border: "2px dashed #2a3a4a", background: "none", color: file ? "#6ab3f3" : "#708499", fontSize: 14, cursor: "pointer", textAlign: "center" }}>
                {file ? `📄 ${file.name}` : "Tap to select backup file"}
            </button>
            <input ref={fileRef} type="file" accept=".trustgram,.json" style={{ display: "none" }} onChange={e => { setFile(e.target.files[0] || null); setError("") }} />

            <div>
                <div style={{ fontSize: 12, color: "#708499", marginBottom: 6 }}>BACKUP CODE</div>
                <input
                    type="text"
                    placeholder="12345 67890 12345 67890 12345 67890"
                    value={code}
                    onChange={e => { setCode(formatCode(e.target.value.replace(/[^0-9]/g, ""))); setError("") }}
                    maxLength={35}
                    style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #2a3a4a", background: "#1f2b38", color: "#fff", fontSize: 16, fontFamily: "monospace", letterSpacing: 1, boxSizing: "border-box" }}
                />
            </div>

            {error && <div style={{ color: "#ff6b6b", fontSize: 13, padding: "10px 14px", background: "#1f2b38", borderRadius: 8 }}>{error}</div>}

            <button onClick={handleImport} disabled={!file || !code.trim() || state === "loading"}
                style={{ padding: 14, borderRadius: 12, border: "none", background: (!file || !code.trim()) ? "#2a3a4a" : "#2b5278", color: "#fff", fontSize: 15, fontWeight: 600, cursor: (!file || !code.trim()) ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                {state === "loading" ? <><Spinner size="s" /> Restoring...</> : "Restore chats"}
            </button>
        </div>
    )
}
