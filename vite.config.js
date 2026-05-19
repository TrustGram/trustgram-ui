import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"
import { execSync } from "child_process"

function getCommitHash() {
    for (const cwd of [".", ".."]) {
        try { return execSync("git rev-parse HEAD", { cwd }).toString().trim() } catch {}
    }
    return "unknown"
}

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
    define: {
        __COMMIT_HASH__: JSON.stringify(getCommitHash()),
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
})
