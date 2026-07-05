# trustgram-ui

TrustGram frontend — a Telegram Mini App for end-to-end encrypted chat.

All encryption happens in the browser via
[`trustgram-crypto`](https://github.com/TrustGram/trustgram-crypto) (X3DH + Double
Ratchet over the Web Crypto API). The backend only ever relays opaque ciphertext.

## Stack

- **React 18** + **Vite**
- **[@telegram-apps/telegram-ui](https://github.com/Telegram-Mini-Apps/TelegramUI)** — Telegram-native components
- **trustgram-crypto** — E2E crypto, bundled at build time
- **IndexedDB** — local identity, ratchet state, and encrypted message history
- Optional **PIN lock** (PBKDF2-600k + AES-GCM) for at-rest protection of history

Hosted on **Cloudflare Pages**.

## Scripts

```bash
npm install
npm run dev       # Vite dev server → http://localhost:5173
npm run build     # vite build + inject SRI hashes & CSP (scripts/inject-sri.js)
npm run preview   # preview the production build
```

## Configuration

Vite environment variables (`VITE_`-prefixed — inlined into the client bundle).
See `.env.development` / `.env.production`.

| Variable | Description |
| --- | --- |
| `VITE_API_URL` | Base URL of `trustgram-bot` (`http://localhost:8001` dev, `https://trustgram-bot.onrender.com` prod) |
| `VITE_REPO_URL`, `VITE_CRYPTO_REPO_URL` | Source links surfaced in the UI |

## Security headers

The production build injects a Content-Security-Policy `<meta>` tag and
Subresource Integrity hashes for bundled assets (`scripts/inject-sri.js`).
`frame-ancestors` is set as a real HTTP header in `public/_headers` so only
Telegram's WebApp host may iframe the app.

## Deploy

Production: https://trustgram-ui.pages.dev

Automatic deployment on push to `main` via Cloudflare Pages.
