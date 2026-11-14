# Raspberry Pi edition: quick start

## 1. Hardware

| Item | Notes |
|---|---|
| Raspberry Pi Zero 2 W + 16 GB+ A1/A2 SD card | Use a good card; the app writes very little. Pi 3/4/5 also work and are faster. |
| Printer | Any CUPS-supported printer. USB (via OTG adapter) or same-Wi-Fi network printer. |
| 5 V / 2.5 A PSU | Weak PSUs cause random Zero 2 W resets. |

## 2. Install (about 10 minutes)

1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In its settings, set the hostname (e.g. `printnimbus`), a user and password, your Wi-Fi, and enable SSH.
2. Copy this folder to the Pi: `scp -r printnimbus pi@printnimbus.local:~`
3. SSH in and run:
   ```bash
   cd ~/printnimbus
   sudo ./deploy/install.sh
   sudo ./deploy/add-printer.sh             # pick your printer (or pass an ipp:// URI)
   ```
4. Open `http://printnimbus.local/admin`. Enter the **setup code** (shown by the installer, also saved as `PRINTNIMBUS-SETUP-CODE.txt` on the SD card's boot partition), choose an admin password. You then sign in with your unit's **module number** (`PN-XXXXXX`, unique per unit, shown by the installer and in `PRINTNIMBUS-SETUP-CODE.txt`) plus that password, then **Dashboard → Printer → Use this printer → Print test page**.

Forgot the admin password? SSH in: `sudo -u printnimbus env DATA_DIR=/var/lib/printnimbus node /opt/printnimbus/src/cli.js reset-admin`, then `sudo systemctl restart printnimbus`.

Logs: `journalctl -u printnimbus -f`. Update: copy the new folder over and re-run `install.sh` (settings and jobs in `/var/lib/printnimbus` are kept).

