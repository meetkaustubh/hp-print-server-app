#!/usr/bin/env bash
# Adds a printer to CUPS using driverless IPP ("everywhere"), which works for most printers made since ~2015.
#   sudo ./add-printer.sh                 -> lists what CUPS can see (USB + network) and lets you pick
#   sudo ./add-printer.sh ipp://192.168.1.50/ipp/print [Name]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
URI="${1:-}"; NAME="${2:-Kiosk-Printer}"
if [ -z "$URI" ]; then
  echo "Searching for printers (this takes a few seconds)..."
  mapfile -t found < <(lpinfo -v 2>/dev/null | awk '$1=="direct"||$1=="network"{print $2}' | grep -E '^(usb|ipp|ipps|dnssd|socket)' | grep -v '^dnssd.*_pdl-datastream' || true)
  [ ${#found[@]} -gt 0 ] || { echo "No printers found. Plug it in / join it to the same Wi-Fi, or pass a URI."; exit 1; }
  select URI in "${found[@]}"; do [ -n "$URI" ] && break; done
fi
lpadmin -p "$NAME" -E -v "$URI" -m everywhere -o printer-is-shared=false
lpadmin -d "$NAME"
echo "Added '$NAME'. Select it in the admin panel (Dashboard -> Printer) and press 'Print test page'."
echo "If the printer needs a vendor driver (older HP: 'sudo apt install hplip', Brother/Canon: vendor .deb), add it with 'lpadmin -m <ppd>' instead."
