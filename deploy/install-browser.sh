#!/usr/bin/env bash
# The hub's browser: Chrome, the fonts pages need, and the Enkidu browser tool (enkidu-browser + its daemon) for the
# hub user, so agents on the hub can open, click, type and screenshot pages in the hub's own Chrome.
#
#   sudo bash deploy/install-browser.sh            # setup-lightsail.sh runs this; safe to run again on a live hub
#
# The Enkidu tool comes from its signed release manifest; the archive is checked against the manifest's size and
# SHA-256 before anything runs. Linux x86_64 only for now (that's the only Linux build Enkidu publishes).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
HUB_USER="${HUB_USER:-hearth}"
MANIFEST="${ENKIDU_BROWSER_MANIFEST:-https://tryarca.ai/install/enkidu-browser/linux-x86_64/latest.json}"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# Chrome. Google only ships it for x86_64.
if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then
  if [ "$(uname -m)" = "x86_64" ]; then
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
    apt-get update -q >/dev/null && apt-get install -yq google-chrome-stable >/dev/null
  else
    echo "   No Chrome for $(uname -m) from Google; install Chromium by hand for Instagram, LinkedIn, X and the browser tool."
    exit 0
  fi
fi
echo "   $(google-chrome --version 2>/dev/null || chromium --version 2>/dev/null)"

# Fonts, so non-Latin text and emoji render instead of empty boxes in pages and screenshots.
apt-get install -yq fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji >/dev/null 2>&1

if [ "$(uname -m)" != "x86_64" ]; then
  echo "   The Enkidu browser tool has no $(uname -m) Linux build yet; skipped."
  exit 0
fi

# The Enkidu browser tool, installed as the hub user into ~/.enkidu/bin (where it looks for itself and its daemon).
sudo -iu "$HUB_USER" MANIFEST="$MANIFEST" bash -s <<'EOF'
set -euo pipefail
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
curl -fsS --retry 3 "$MANIFEST" -o "$T/latest.json"
read -r URL SHA SIZE < <(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["artifact"], m["sha256"], m["sizeBytes"])' "$T/latest.json")
curl -fsSL --retry 3 "$URL" -o "$T/b.tgz"
[ "$(stat -c %s "$T/b.tgz")" = "$SIZE" ] || { echo "   Enkidu browser download is the wrong size; not installed."; exit 1; }
echo "$SHA  $T/b.tgz" | sha256sum -c --quiet - || { echo "   Enkidu browser download failed its checksum; not installed."; exit 1; }
mkdir "$T/x" && tar -xzf "$T/b.tgz" -C "$T/x" enkidu-browser enkidu-daemon ffmpeg ffprobe
# `enable` stages the CLI, daemon and media tools into ~/.enkidu/bin, starts the daemon and probes Chrome. Already
# current: enable the installed copy, which just (re)starts the daemon, e.g. after a reboot.
BIN="$T/x/enkidu-browser"
cmp -s "$BIN" ~/.enkidu/bin/enkidu-browser && cmp -s "$T/x/enkidu-daemon" ~/.enkidu/bin/enkidu-daemon && BIN=~/.enkidu/bin/enkidu-browser
out=$("$BIN" enable --json)
# Put it on the hub user's PATH for agents and for `sudo -iu hearth enkidu-browser ...`.
grep -qs '.enkidu/bin' ~/.profile || echo 'export PATH="$HOME/.enkidu/bin:$PATH"' >> ~/.profile
if echo "$out" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ready") else 1)'; then
  echo "   Enkidu browser ready ($(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"][:7])' "$T/latest.json")): sudo -iu $USER enkidu-browser skill"
else
  echo "   Enkidu browser installed but not ready: $out"; exit 1
fi
EOF
