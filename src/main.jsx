import React from "react"
import ReactDOM from "react-dom/client"
import { AppRoot } from "@telegram-apps/telegram-ui"
import "@telegram-apps/telegram-ui/dist/styles.css"
import "./index.css"
import App from "./App"

ReactDOM.createRoot(document.getElementById("root")).render(
    <AppRoot appearance="dark">
        <App />
    </AppRoot>
)
