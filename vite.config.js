import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "trustgram-crypto": path.resolve("./src/lib/crypto.js"),
        },
    },
    server: {
        port: 5173,
    },
})
