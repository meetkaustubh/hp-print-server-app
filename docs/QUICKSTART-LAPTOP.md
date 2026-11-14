# Laptop edition: quick start (Windows)

This is the same app as the Raspberry Pi edition, running on a laptop that is connected to your printer (USB, or the same Wi-Fi as a network printer), like your current setup.

## 1. One-time setup
1. Install **Node.js 22 LTS** from https://nodejs.org (accept the defaults).
2. Unzip this folder somewhere permanent, e.g. `C:\PrintNimbus`.
3. Double-click **`start-laptop.bat`**. The first run installs components (about a minute), then opens the admin page.
4. In the admin page, enter the **setup code** shown in the black window, choose an admin password.
5. **Dashboard → Printer**: pick your printer (e.g. *HP944FDA*), press **Use this printer**, then **Print test page**.
6. **Settings**: set your prices, business name, and (when ready) Razorpay keys. See "Payments" in `README.md`.

To start it automatically at every login, run **`install-autostart.bat`**. Keep the laptop awake while it's serving (Windows Settings → Power → Sleep: Never when plugged in).

## 2. Making it reachable from customers' phones
On the same Wi-Fi, customers can open `http://<laptop-ip>:3000` (the Dashboard shows the address). For the public internet (and for live Razorpay, which needs HTTPS) use a tunnel, like your previous ngrok setup but free and stable:

* **Cloudflare Tunnel (recommended):** install `cloudflared`, then in Cloudflare Zero Trust create a tunnel with a public hostname pointing to `http://localhost:3000` and run the service command it shows. Set *Public website address* in Settings and print the **QR poster** tab.
* **Quick test only:** `cloudflared tunnel --url http://localhost:3000` gives a temporary https address.
* ngrok also works; point it at port 3000.

## 3. Notes specific to the laptop edition
* **Printing** uses the bundled SumatraPDF through the `pdf-to-printer` package, the same engine as your old app. Printer status (offline, out of paper, jam) and "did it leave the print queue" are read through PowerShell's printer cmdlets (Windows 8 or newer). I could not test the Windows backend in my environment; test with your printer before taking money. If the app ever says "printed" too early, tell me and I'll adjust how completion is detected.
* **Windows Firewall** may ask to allow Node.js the first time: allow *Private networks*.
* **macOS / Linux laptops:** use `start-laptop.sh` (printing through CUPS).
* **Data** (settings, job history, your logo override) lives in the `data` folder next to the app. Back it up; deleting it resets the kiosk.
* **Updating:** unzip the new version over the old folder but keep your `data` folder.

## Auto-update from GitHub (optional)

If you installed with `git clone`, double-click `laptop\start-synced.bat` instead of `start-laptop.bat`. It runs the app and checks GitHub every minute (change with `SYNC_INTERVAL` seconds). When new code lands on `main` it pulls it, reinstalls components only if they changed, and restarts the app. Your `.env`, `data/` folder and Razorpay keys are never touched. Needs Git and Node installed. A restart takes a few seconds, so unpaid carts in progress keep working but a page open at that moment may need a refresh.
