# Security audit of the original app, and what replaced it

## Act on this first
The original zip contained **live credentials**: a Razorpay *live* key ID and secret, a Razorpay webhook secret, a Razorpay *test* secret, and an Outlook account password. They were hardcoded in `server.js`, duplicated in `.env`, and `public/.env` sat **inside the web root**, so it may have been downloadable (your own `server.log` shows bots requesting `/.env`). The zip also holds visitor logs.
**Rotate all of them:** regenerate the Razorpay API keys and webhook secret, change the Outlook password, and treat the old values as public. Don't reuse the old files.

## Findings

| # | Severity | Problem in v1 | Fix in v2 |
|---|---|---|---|
| 1 | Critical | Secrets in source and web root | Secrets only in the admin panel/env; `dotfiles: deny`; never returned by any API (tested) |
| 2 | Critical | `/print` had no payment check: anyone could print free by POSTing | No such endpoint. A job only enters the queue after HMAC-verified payment (or webhook) |
| 3 | Critical | Price calculated in the browser; server trusted `amount` | Server computes price from its own page count and settings; order amount comes from the server |
| 4 | Critical | `/refund` open to anyone, any payment ID | Refunds only by the system after a failed print, or by the logged-in admin; atomically claimed so they run once |
| 5 | High | Refund never worked (client sent JSON without a content-type; `amount` undefined) | Server-side refund of the exact stored amount; failures surface in the admin and via alert |
| 6 | High | Payment confirmation route used an undefined `req.rawBody` and a hardcoded secret, and was never called | Proper checkout-signature check and a raw-body webhook check, both constant-time |
| 7 | High | `/sendEmail` unauthenticated and interpolated user input into HTML (spam relay / HTML injection) | Removed; optional alert webhook with fixed text |
| 8 | High | `/log` unauthenticated, unbounded file append (disk fill, log forging) | Removed; logs go to journald |
| 9 | High | `trust proxy: true` made the IP rate limit spoofable via `X-Forwarded-For` | Configurable; default trusts only a local proxy |
| 10 | Medium | Upload trusted the browser's MIME/extension; no size cap; files kept in the same folder as logs | Content sniffing, size/page caps, random filenames, private `0700` data dir, auto-delete |
| 11 | Medium | Print options (copies etc.) were unvalidated and passed to the OS print call | Strict validation; `execFile` with an argument array, no shell |
| 12 | Medium | No security headers; third-party scripts unpinned (pdf.js from a CDN) | Helmet + CSP; page counts computed server-side, pdf.js dropped |
| 13 | Low | Right-click blocking, `socket.io` reload hack, dead `server2.js`, `webpack.config.js`, stray PDFs and `.prn` files | Removed |
| 14 | Low | Windows-only printing (`pdf-to-printer`) | CUPS |

## Not fixed because it is outside the code
* Anyone who obtained the old keys can still use them until you rotate them.
* Razorpay account hygiene (2FA on the dashboard, restricting who can issue refunds).
