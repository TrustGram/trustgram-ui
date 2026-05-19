import React from "react"
import ReactDOM from "react-dom/client"
import { AppRoot } from "@telegram-apps/telegram-ui"
import "@telegram-apps/telegram-ui/dist/styles.css"
import "./index.css"
import App from "./App"

// Force dark theme CSS variables regardless of Telegram client theme.
// Telegram WebApp sets these as inline styles on documentElement (highest priority in CSS),
// so we override them via JS after the fact.
const root = document.documentElement
root.style.setProperty("--tg-theme-bg-color", "#17212b")
root.style.setProperty("--tg-theme-secondary-bg-color", "#1f2b38")
root.style.setProperty("--tg-theme-text-color", "#ffffff")
root.style.setProperty("--tg-theme-hint-color", "#708499")
root.style.setProperty("--tg-theme-link-color", "#6ab3f3")
root.style.setProperty("--tg-theme-button-color", "#2b5278")
root.style.setProperty("--tg-theme-button-text-color", "#ffffff")
root.style.setProperty("--tg-color-scheme", "dark")
document.body.style.color = "#ffffff"
document.body.style.background = "#17212b"

ReactDOM.createRoot(document.getElementById("root")).render(
    <AppRoot appearance="dark">
        <App />
    </AppRoot>
)
