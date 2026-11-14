#!/usr/bin/env bash
# Print Nimbus installer for Raspberry Pi OS (Bookworm or newer, 64-bit Lite recommended).
#   sudo ./deploy/install.sh [--hostname printnimbus]
set -euo pipefail

NEW_HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) NEW_HOST="${2:?hostname required}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac; shift
done
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/printnimbus; DATA=/var/lib/printnimbus
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing system packages"
apt-get update -y
apt-get install -y --no-install-recommends cups cups-filters poppler-utils ghostscript avahi-daemon curl ca-certificates rsync

need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  echo "==> Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Creating service user and folders"
id printnimbus >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin printnimbus
install -d -o printnimbus -g printnimbus -m 700 "$DATA"
install -d -m 755 "$APP"
rsync -a --delete --exclude node_modules --exclude data --exclude .git "$SRC"/ "$APP"/
chmod +x "$APP"/deploy/*.sh
( cd "$APP" && npm ci --omit=dev --no-audit --no-fund )
chown -R root:root "$APP"

echo "==> Swap (helps npm on 512 MB boards)"
if [ -f /etc/dphys-swapfile ]; then
  want=512
  sed -i "s/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=$want/" /etc/dphys-swapfile
  dphys-swapfile setup >/dev/null 2>&1 && dphys-swapfile swapon >/dev/null 2>&1 || true
fi

[ -n "$NEW_HOST" ] && { hostnamectl set-hostname "$NEW_HOST"; echo "==> Hostname set to $NEW_HOST (reachable as $NEW_HOST.local)"; }

echo "==> Installing service"
cp "$APP/deploy/printnimbus.service" /etc/systemd/system/printnimbus.service
systemctl daemon-reload
CODE=$(sudo -u printnimbus env DATA_DIR="$DATA" node --disable-warning=ExperimentalWarning "$APP/src/cli.js" init | sed -n 's/^Setup code: //p')
systemctl enable --now cups avahi-daemon
systemctl enable --now printnimbus

IP=$(hostname -I | awk '{print $1}')
echo
echo "================================================================"
echo " Print Nimbus is running."
echo "   Open:        http://${IP}/   (or http://$(hostname).local/)"
echo "   Admin:       http://${IP}/admin"
[ -n "$CODE" ] && echo "   Setup code:  $CODE   (also in PRINTNIMBUS-SETUP-CODE.txt on the boot partition)"
echo " Next: add your printer ->  sudo $APP/deploy/add-printer.sh"
echo "================================================================"
