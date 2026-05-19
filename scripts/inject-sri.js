// Post-build script: injects SRI integrity hashes into dist/index.html
// and adds a Content-Security-Policy <meta> tag.
// Run automatically via: npm run build
import { readFileSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { resolve, join } from "path"

const distDir = resolve("dist")
const indexPath = join(distDir, "index.html")
let html = readFileSync(indexPath, "utf8")

function computeSRI(relPath) {
    const buf = readFileSync(join(distDir, relPath))
    return "sha256-" + createHash("sha256").update(buf).digest("base64")
}

// Inject integrity into <script ... src="/assets/...">
html = html.replace(/<script\b([^>]*)\bsrc="(\/assets\/[^"]+)"([^>]*)>/g, (m, pre, src, post) => {
    if (m.includes("integrity=")) return m
    try { return `<script${pre} src="${src}" integrity="${computeSRI(src)}"${post}>` }
    catch { return m }
})

// Inject integrity into <link ... href="/assets/...">
html = html.replace(/<link\b([^>]*)\bhref="(\/assets\/[^"]+)"([^>]*)\/?>/g, (m, pre, href, post) => {
    if (m.includes("integrity=")) return m
    try { return `<link${pre} href="${href}" integrity="${computeSRI(href)}"${post}/>` }
    catch { return m }
})

// Build CSP — API URL from env (matches VITE_API_URL in .env.production)
const api = process.env.VITE_API_URL ?? "https://trustgram-bot.onrender.com"
const csp = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `connect-src 'self' ${api}`,
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
].join("; ")

html = html.replace(/(<head[^>]*>)/, `$1\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)

writeFileSync(indexPath, html)
console.log("✓ SRI hashes + CSP injected →", indexPath)
