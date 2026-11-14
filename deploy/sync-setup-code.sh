#!/bin/sh
# Runs as root before the service starts. While the kiosk is unclaimed, expose the setup code on the
# SD card's boot partition (readable from any PC). Once an admin exists, remove it.
CODE=/var/lib/printnimbus/setup-code.txt
# make sure an unclaimed unit has a code (a cloned image gets a fresh one on first boot)
runuser -u printnimbus -- env DATA_DIR=/var/lib/printnimbus /usr/bin/node --disable-warning=ExperimentalWarning /opt/printnimbus/src/cli.js init >/dev/null 2>&1 || true
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
OUT="$BOOT/PRINTNIMBUS-SETUP-CODE.txt"
if [ -f "$CODE" ]; then
  [ -d "$BOOT" ] && { printf 'Print Nimbus setup code: %s\nModule number (your sign-in name): %s\nOpen http://<this-device>/admin and enter them.\n' "$(cat "$CODE")" "$(cat /var/lib/printnimbus/module-number.txt 2>/dev/null)" > "$OUT"; chmod 644 "$OUT"; }
else
  rm -f "$OUT"
fi
exit 0
