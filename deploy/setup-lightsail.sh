#!/usr/bin/env bash
# Target "lightsail": one-shot server setup for Hearth on a fresh Ubuntu 24.04 box (AWS Lightsail or any VPS).
#
#   git clone https://github.com/<you>/hearth && cd hearth
#   sudo bash deploy/setup.sh lightsail yournameassistant.com you@example.com
#
# It installs Caddy (automatic HTTPS), a firewall, automatic security updates and fail2ban, locks SSH to keys,
# installs the hub as a systemd service at https://<domain>, and prints the QR code for your primary phone.
# Safe to run again: it keeps an existing .env and data.
set -euo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"; SKIP_DNS=0
for a in "$@"; do [ "$a" = "--skip-dns-check" ] && SKIP_DNS=1; done
if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ] || [[ "$DOMAIN" == --* ]]; then
  echo "usage: sudo bash deploy/setup.sh lightsail <domain> <email> [--skip-dns-check]"; exit 1
fi
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/hearth
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Checking that $DOMAIN points at this server"
MYIP="$(curl -fsS4 https://checkip.amazonaws.com || true)"
DNSIP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ "$SKIP_DNS" = 0 ] && [ "$MYIP" != "$DNSIP" ]; then
  echo "$DOMAIN resolves to '${DNSIP:-nothing}', but this server is $MYIP."
  echo "Add an A record  $DOMAIN -> $MYIP  at your domain registrar, wait a few minutes, and run this again."
  echo "(See deploy/lightsail.md, step 2. Use --skip-dns-check to continue anyway.)"
  exit 1
fi

say "Installing Caddy, firewall, fail2ban and automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq caddy ufw fail2ban unattended-upgrades git unzip curl rsync
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now fail2ban

say "Firewall: only SSH, HTTP (redirects to HTTPS) and HTTPS"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null # HTTP/3
ufw --force enable >/dev/null
ufw status | sed 's/^/   /'

say "SSH: keys only, no root login"
ADMIN="${SUDO_USER:-}"
if [ -n "$ADMIN" ] && [ -s "/home/$ADMIN/.ssh/authorized_keys" ]; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-hearth.conf
  sshd -t && systemctl reload ssh
  echo "   Done. You log in with your SSH key, as before."
else
  echo "   Skipped: no SSH key found for '${ADMIN:-?}', so turning off passwords could lock you out."
fi

say "Hub user and Bun"
id hearth >/dev/null 2>&1 || adduser --disabled-password --gecos "" hearth >/dev/null
[ -x /home/hearth/.bun/bin/bun ] || sudo -iu hearth bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null
mkdir -p /home/hearth/.claude /home/hearth/.codex && chown hearth: /home/hearth/.claude /home/hearth/.codex

say "Master key for the hub's encrypted API keys"
# API keys (E2B, Deepgram, your VMs' SSH keys) are encrypted in data/keys/vault.db with this key. It lives outside the
# data folder, so a copy of the data alone can't be read. Made once; kept on every later run.
sudo -u hearth bash -c 'umask 077; mkdir -p ~/.hearth; [ -s ~/.hearth/master.key ] || head -c 32 /dev/urandom | base64 > ~/.hearth/master.key'
echo "   /home/hearth/.hearth/master.key: save a copy somewhere safe, like a password manager."

say "Installing Hearth to $APP"
if [ "$SRC" != "$APP" ]; then
  mkdir -p "$APP"
  rsync -a --delete --exclude node_modules --exclude data --exclude .env "$SRC/" "$APP/"
fi
chown -R hearth: "$APP"
sudo -iu hearth bash -c "cd $APP && ~/.bun/bin/bun install --production" >/dev/null

say "Settings ($APP/.env)"
ENV="$APP/.env"
[ -f "$ENV" ] || sudo -u hearth cp "$APP/.env.example" "$ENV"
set_env() { if grep -q "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }
set_env HEARTH_TARGET lightsail
set_env HEARTH_HOST 127.0.0.1
set_env HEARTH_DATA "$APP/data"
set_env HEARTH_BEHIND_PROXY 1
set_env HEARTH_PUBLIC_URL "https://$DOMAIN"
set_env HEARTH_CONTACT "mailto:$EMAIL"
grep -q '^HEARTH_REQUIRE_PASSKEY=' "$ENV" || set_env HEARTH_REQUIRE_PASSKEY 0
chown hearth: "$ENV" && chmod 600 "$ENV"
sudo -u hearth mkdir -p "$APP/data" && chmod 700 "$APP/data"

say "HTTPS for $DOMAIN (Caddy gets and renews the certificate)"
sed -e "s/hub.example.com/$DOMAIN/" -e "s/you@example.com/$EMAIL/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

say "Starting the hub"
cp "$APP/deploy/hearth.service" /etc/systemd/system/hearth.service
systemctl daemon-reload
systemctl enable hearth >/dev/null
systemctl restart hearth
sleep 3
systemctl is-active --quiet hearth || { journalctl -u hearth -n 30 --no-pager; exit 1; }

if ! sudo -iu hearth bash -c 'test -e ~/.claude/.credentials.json || test -e ~/.codex/auth.json'; then
  say "One manual step: log in the brain (once)"
  echo "   sudo -iu hearth claude      # or: sudo -iu hearth codex login"
  echo "   then: sudo systemctl restart hearth"
fi

say "Set up your primary phone"
sudo -iu hearth bash -c "cd $APP && ~/.bun/bin/bun run setup"
echo "   Open the link on your phone, tap Pair, then Share → Add to Home Screen and open it from there."
echo "   Next, check everything with:  sudo -iu hearth bash -c 'cd $APP && ~/.bun/bin/bun run doctor'"
echo "   To run work on your Mac with your own logins, on the Mac:  bash deploy/setup.sh mac https://$DOMAIN"
