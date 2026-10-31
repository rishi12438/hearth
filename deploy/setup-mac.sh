#!/usr/bin/env bash
# Target "mac": link this Mac to your Hearth hub as one of your devices. The hub does all the thinking; the Mac can copy
# your Claude/Codex login up so the hub thinks with your own account.
#
#   bash deploy/setup.sh mac https://yournameassistant.com [--name "Studio"]
#
# Runs as you, not root: it reads the logins you already have. Your primary phone approves the link. It then starts at
# login. Safe to run again.
set -euo pipefail

HUB="${1:-}"; [ $# -gt 0 ] && shift
if [ -z "$HUB" ] || [[ "$HUB" != http* ]]; then echo 'usage: bash deploy/setup.sh mac https://yournameassistant.com [--name "Studio"]'; exit 1; fi
[ "$(uname)" = Darwin ] || { echo "This is for macOS. On Linux: bun run join $HUB, then keep 'bun run computer' running."; exit 1; }
[ "$(id -u)" != 0 ] || { echo "Run it as yourself, without sudo: it reads your own logins."; exit 1; }
APP="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.hearth.computer
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
cd "$APP"

say "Bun"
BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then curl -fsSL https://bun.sh/install | bash >/dev/null; BUN="$HOME/.bun/bin/bun"; fi
"$BUN" install --production >/dev/null
echo "   $("$BUN" --version)"

say "Settings ($APP/.env)"
[ -f .env ] || cp .env.example .env
set_env() { if grep -q "^$1=" .env; then sed -i '' "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
set_env HEARTH_TARGET mac
set_env HEARTH_HUB_URL "$HUB"
chmod 600 .env
mkdir -p data && chmod 700 data


say "Linking to $HUB"
if "$BUN" -e "const l=require('./data/computer.json'); process.exit(l.hub===new URL(process.argv[1]).origin?0:1)" "$HUB" 2>/dev/null; then
  echo "   Already linked."
else
  "$BUN" src/cli.ts join "$HUB" "$@"
fi

say "Start at login"
# launchd starts with a bare PATH.
P="$(dirname "$BUN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$BUN</string><string>src/cli.ts</string><string>computer</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$P</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/hearth-computer.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/hearth-computer.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
if grep -q "connected to" "$HOME/Library/Logs/hearth-computer.log" 2>/dev/null; then echo "   Connected. Your phone shows it under Settings → Your hub & devices. Turn on Copy Claude login to the hub there."; else echo "   Started. Check: tail -f ~/Library/Logs/hearth-computer.log"; fi

echo
echo "   Stop it:      launchctl bootout gui/$(id -u)/$LABEL"
echo "   Check it:     bun run doctor"
