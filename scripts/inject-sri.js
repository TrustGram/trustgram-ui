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
    // telegram-web-app.js is loaded from telegram.org by the host iframe.
    "script-src 'self' https://telegram.org",
    // React inline styles + Telegram UI bundle styles — kept inline.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `connect-src 'self' ${api}`,
    // data: for inline icons, blob: for file-preview URLs created by FileCard.
    "img-src 'self' data: blob:",
    // Hard no on <object>, <embed>, <applet>.
    "object-src 'none'",
    // Same-origin Web Workers (none right now, but defence in depth).
    "worker-src 'self' blob:",
    // No PWA manifests external to the bundle.
    "manifest-src 'self'",
    // Cannot inject <base> to redirect relative URLs.
    "base-uri 'self'",
    // No HTML <form> submissions anywhere — we use fetch() exclusively.
    "form-action 'none'",
    // Force https on any accidentally-http URL in the bundle.
    "upgrade-insecure-requests",
].join("; ")

html = html.replace(/(<head[^>]*>)/, `$1\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)

writeFileSync(indexPath, html)
console.log("✓ SRI hashes + CSP injected →", indexPath)
