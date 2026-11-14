# Print Nimbus 2.1: pay-and-print kiosk (Windows laptop or Raspberry Pi)

Customers scan a QR code, upload one or more documents, choose options for each, pay once with Razorpay (UPI/cards), and the pages come out of the printer next to you. If a document fails to print, that document is refunded automatically.

* **Multi-document orders:** each file has its own colour / B&W, copies, single/double-sided and pages; one payment covers all.
* **Page picker:** tap page thumbnails to choose pages (All / None / Odd / Even / Colour pages / Skip blank), or type a range.
* **Smart checks:** while a file is processed the customer sees a scan-style progress view; the browser detects which pages contain colour and which are blank, suggests B&W when no colour is found, and offers to skip blank pages. Phone photos are rotated upright automatically.
* Runs on a **Windows laptop** or a **Raspberry Pi Zero 2 W** (512 MB) or bigger. No build step and no native modules.
* Prints through **CUPS** (Pi / macOS / Linux) or **SumatraPDF + the Windows spooler** (laptop).
* Accepts **PDF, JPG, PNG** out of the box. **Word / Excel / PowerPoint / text** can be switched on (LibreOffice).
* **Admin panel** at `/admin`: prices, printer, Razorpay keys, jobs, refunds, QR poster, health.

## 1. Two editions, one codebase

| | Laptop edition | Raspberry Pi edition |
|---|---|---|
| Runs on | Windows laptop (macOS/Linux work too) | Raspberry Pi Zero 2 W or bigger |
| Printing | `pdf-to-printer` (SumatraPDF) + PowerShell status | CUPS |
| Start | double-click `start-laptop.bat` | `sudo ./deploy/install.sh` (systemd service) |
| Guide | `QUICKSTART-LAPTOP.md` | `QUICKSTART-PI.md` |

Both are built from the same source by `scripts/build-dist.sh`, so every feature below exists in both and fixes land in both.

## 2. Turn on payments (Razorpay)

1. Razorpay Dashboard → Settings → API Keys → generate a key (start with **Test mode**).
2. In `/admin → Settings → Payments`: choose *Razorpay*, paste Key ID and Key Secret.
3. **Webhook (important):** Razorpay Dashboard → Settings → Webhooks → add `https://<your-site>/api/razorpay/webhook`, events `payment.captured` and `order.paid`, choose a secret, paste the same secret into the admin panel. This guarantees a paid job prints even if the customer closes their browser.
4. Make sure **auto-capture** is on (Settings → Payment capture).
5. Do a ₹1 test payment, then switch to live keys.

Razorpay's live Checkout needs the page served over **HTTPS**, so a plain `http://printnimbus.local` is fine for free mode or test-mode trials but not for live payments. Use a tunnel:

### Public HTTPS with Cloudflare Tunnel (free, no router changes)
1. Cloudflare Zero Trust → Networks → Tunnels → create a tunnel, choose Debian / arm64, and run the install commands it shows on the Pi (`cloudflared service install <token>`).
2. Add a public hostname (e.g. `print.yourdomain.com`) → service `http://localhost:80`.
3. In the admin panel set *Public website address* to that URL, then print the **QR poster** tab.

`TRUST_PROXY=loopback` (the default) makes rate limiting use the real visitor IP behind the tunnel.

## 3. Selling it as a product

* **One image per unit:** configure one reference Pi, run `install.sh`, then **do not** complete the admin setup. Shrink and clone the SD image (e.g. `pishrink`). Every clone boots unclaimed with its own setup code. To make it unique per unit, delete `/var/lib/printnimbus/setup-code.txt` before imaging; a fresh code is generated on first boot of each clone.
* **Print the setup code** on a sticker/insert, or tell the buyer to read `PRINTNIMBUS-SETUP-CODE.txt` from the SD card.
* **Each buyer uses their own Razorpay account** (own KYC and settlement). The keys are entered in their admin panel; you never touch their money. If you want to collect payments centrally and split with operators, look at Razorpay Route, which is a bigger project.
* **Branding:** drop a `logo.png` (square, ~256 px) into `/var/lib/printnimbus/` to replace the default icon; business name and tagline are in Settings. `branding/print-nimbus-logo.png` is your original logo on a teal tile, ready to use.
* **Legal:** the built-in Terms / Privacy / Refund pages are starter templates. Replace them with reviewed text (or link your own URLs in Settings). Razorpay requires these policies on your site.
* **Not included, your call:** licence keys / device locking, remote fleet updates, Wi-Fi captive-portal onboarding for buyers who can't use Raspberry Pi Imager. Each is additive; the settings and auth layers are ready for it.

## 4. How it works

```
phone ──HTTPS──> Express ──> validate + convert to PDF ──> SQLite job (uploaded)
                    │   price computed on the server
                    ├──> Razorpay order  (amount from server, never from the browser)
 Checkout success ──┴──> HMAC-verify signature  (+ webhook as backup) ──> job queued
                          worker ──> CUPS `lp` ──> wait until CUPS drains ──> done
                                      └─ failure / timeout ──> automatic refund (once)
```

Each document is a job; jobs bought together share one Razorpay order and print back to back. Job states: `uploaded → awaiting_payment → queued → printing → done`, or `failed → refunded | refund_failed`. A failed document triggers a partial refund of just its own price.

Edge cases handled: customer edits the cart and then pays the older order (that payment is refunded in full automatically), duplicate confirm/webhook (idempotent, prints once), payment arriving after the upload expired (auto-refund), server restarting mid-job (marked for operator review, never silently reprinted), printer offline when a paid job arrives (waits 3 min, then refunds), unpaid uploads (deleted after 30 min), files deleted `retention_minutes` after printing.

## 5. Security model (what changed from v1)

See `SECURITY-AUDIT.md` for the full before/after. In short: no secrets in code (admin panel / env, never sent to browsers), prices and page counts computed server-side, payments verified by HMAC before printing, no public refund/email/log endpoints, uploads validated by content, all subprocesses run without a shell, strict CSP + rate limits, scrypt-hashed admin password with CSRF-guarded session, systemd sandboxing, and document files auto-deleted.

## 6. Limits you should know

* CUPS can tell when a job leaves the queue but **cannot always tell a paper jam from success**. Most printers hold the job while jammed or out of paper, so the app times out and refunds; a printer that discards the job silently would be reported as printed.
* Office conversion on a Zero 2 W takes roughly 20–60 s per file and is limited to one at a time. Layout can differ slightly from Word; PDF is always the most faithful.
* The Windows laptop backend (status and completion detection through PowerShell) is untested on real Windows hardware so far; the Pi/CUPS path and all payment logic are covered by tests.
* Admin sessions are in memory: restarting the service signs the admin out (customers are unaffected).
* Settings, including the Razorpay secret, live in a SQLite file readable only by the service user (`chmod 600`). That protects against other users and the web, not against someone with root or the SD card. Use env vars + full-disk encryption if your threat model needs more.

## 7. Honest limits of the smart checks

* Colour and blank-page detection run in the customer's browser on small previews. They are a helpful guide, not a guarantee: a very faint tint or a tiny logo can be missed, and a page with only light-grey content can be called blank. Customers can always override.
* Colour is chosen **per document**, not per page. Printing page 3 in colour and the rest in B&W means splitting the file into two documents (the *Print only these* shortcut helps).
* **Colour and layout:** PDFs are printed at their original size and colours (no forced scaling; oversized pages are only shrunk to fit). Word/Excel/PowerPoint files are converted with LibreOffice, so fonts matter: the Pi installer adds Carlito/Caladea (metric-compatible with Calibri/Cambria); on a laptop, install LibreOffice and keep the fonts your documents use. For pixel-perfect Word output, upload a PDF exported from Word.
* There is no photo-to-scan edge detection or deskew (what a phone scanner app does). Photos are rotated using their EXIF tag and fitted to the page.
* Previews need a modern browser (pdf.js). If it can't load, customers still print with a typed page range.

## 8. Development

```bash
npm install
PRINT_BACKEND=dryrun npm run dev      # no printer needed; "printed" PDFs land in data/printed/
npm test                               # 37 tests: payments, refunds, multi-doc orders, uploads, EXIF, admin security, Office conversion
./scripts/build-dist.sh                # builds dist/printnimbus-laptop-<ver>.zip and dist/printnimbus-pi-<ver>.zip
```
