#!/usr/bin/env bash
# Deploy new code to a hub that setup-lightsail.sh already set up. Run on the server, from an unpacked copy of the code:
#
#   git archive origin/main | ssh <server> 'rm -rf /tmp/hearth-src && mkdir /tmp/hearth-src && tar -x -C /tmp/hearth-src \
#     && sudo bash /tmp/hearth-src/deploy/update.sh'
#
# It backs up the code, syncs it to /opt/hearth (keeping data and .env), installs packages only when bun.lock changed,
# re-installs the systemd unit when deploy/hearth.service changed (so its sandbox rules always match the code), makes
# the folders the hub writes, then restarts the hub and checks it came up. A restart stops running jobs.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/hearth
UNIT=/etc/systemd/system/hearth.service
HOME_DIR="$(getent passwd hearth | cut -d: -f6)"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
[ "$SRC" != "$APP" ] || { echo "Run it from a fresh copy of the code, not from $APP."; exit 1; }

say "Backing up the current code"
BACKUP="/opt/hearth-code-backup-$(date +%Y%m%d-%H%M%S).tgz"
tar -czf "$BACKUP" -C /opt --exclude hearth/node_modules --exclude hearth/data --exclude hearth/.env hearth
echo "   $BACKUP"

say "Syncing the code to $APP"
OLD_LOCK="$(sha256sum "$APP/bun.lock" 2>/dev/null | cut -d' ' -f1 || true)"
rsync -a --delete --exclude node_modules --exclude data --exclude .env "$SRC/" "$APP/"
chown -R hearth: "$APP"
if [ "$OLD_LOCK" != "$(sha256sum "$APP/bun.lock" | cut -d' ' -f1)" ] || [ ! -d "$APP/node_modules" ]; then
  say "Installing packages (bun.lock changed)"
  sudo -iu hearth bash -c "cd $APP && ~/.bun/bin/bun install --production" >/dev/null
fi

# Folders the unit lets the hub write must exist, or systemd drops them from ReadWritePaths and the hub can't write them.
sudo -u hearth mkdir -p "$HOME_DIR/.enkidu"

if ! cmp -s "$APP/deploy/hearth.service" "$UNIT"; then
  say "Updating the systemd unit"
  cp "$APP/deploy/hearth.service" "$UNIT"
  systemctl daemon-reload
fi

# Swap, so a memory spike slows the box down instead of having the kernel kill things (small Lightsail boxes have none).
if [ -z "$(swapon --noheadings 2>/dev/null)" ]; then
  say "Adding 4 GB of swap"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Restarting the hub"
systemctl restart hearth
sleep 3
systemctl is-active --quiet hearth || { journalctl -u hearth -n 30 --no-pager; exit 1; }
echo "   running"
