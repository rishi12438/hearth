#!/usr/bin/env bash
# The hub's tools for the brain: Chrome and the fonts pages need, a virtual screen (Xvfb + openbox), and Enkidu's tools for
# the hub user: enkidu-browser (drive Chrome) and enkidu-cua (see and control apps on that screen, and record videos).
# The brain finds them as skills (src/brains/skills.ts).
#
#   sudo bash deploy/install-tools.sh            # setup-lightsail.sh runs this; safe to run again on a live hub
#
# Each Enkidu tool comes from its release manifest; the archive is checked against the manifest's size and SHA-256
# before anything runs. Linux x86_64 only for now (that's the only Linux build Enkidu publishes).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
HUB_USER="${HUB_USER:-hearth}"
RELEASES="${ENKIDU_RELEASES:-https://tryarca.ai/install}"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# Chrome. Google only ships it for x86_64.
if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then
  if [ "$(uname -m)" = "x86_64" ]; then
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
    apt-get update -q >/dev/null && apt-get install -yq google-chrome-stable >/dev/null
  else
    echo "   No Chrome for $(uname -m) from Google; install Chromium by hand for Instagram, LinkedIn, X and the browser tools."
    exit 0
  fi
fi
echo "   $(google-chrome --version 2>/dev/null || chromium --version 2>/dev/null)"

# Fonts, so non-Latin text and emoji render instead of empty boxes in pages and screenshots; and the virtual screen
# enkidu-cua starts on :99 (Xvfb, with openbox so windows can be listed).
apt-get install -yq fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji xvfb openbox x11-utils >/dev/null 2>&1

# Codex runs shell commands in a bubblewrap sandbox. Ubuntu 24.04+ only lets a program make the user namespaces that needs
# when an AppArmor profile allows it, and none ships for bwrap, so every Codex command fails ("bwrap: loopback: Failed
# RTM_NEWADDR: Operation not permitted"). Allow it for /usr/bin/bwrap only, the fix Ubuntu documents, rather than
# turning the restriction off for the whole system.
if command -v codex >/dev/null; then
  apt-get install -yq bubblewrap >/dev/null 2>&1
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && [ ! -e /etc/apparmor.d/bwrap ]; then
    printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' '# Hearth: lets Codex'"'"'s sandbox (bubblewrap) make its namespaces.' \
      'profile bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '  include if exists <local/bwrap>' '}' > /etc/apparmor.d/bwrap
    apparmor_parser -r /etc/apparmor.d/bwrap
  fi
  echo "   Codex sandbox: bubblewrap $(bwrap --version 2>/dev/null | awk '{print $2}')"
fi

if [ "$(uname -m)" != "x86_64" ]; then
  echo "   Enkidu's tools have no $(uname -m) Linux build yet; skipped."
  exit 0
fi

# Enkidu's tools, installed as the hub user into ~/.enkidu/bin (where each looks for itself and the shared daemon).
install_tool() { # <tool> <cli>
  sudo -iu "$HUB_USER" MANIFEST="$RELEASES/$2/linux-x86_64/latest.json" CLI="$2" bash -s <<'EOF'
set -euo pipefail
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
curl -fsS --retry 3 "$MANIFEST" -o "$T/latest.json"
read -r URL SHA SIZE < <(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["artifact"], m["sha256"], m["sizeBytes"])' "$T/latest.json")
curl -fsSL --retry 3 "$URL" -o "$T/b.tgz"
[ "$(stat -c %s "$T/b.tgz")" = "$SIZE" ] || { echo "   $CLI download is the wrong size; not installed."; exit 1; }
echo "$SHA  $T/b.tgz" | sha256sum -c --quiet - || { echo "   $CLI download failed its checksum; not installed."; exit 1; }
mkdir "$T/x" && tar -xzf "$T/b.tgz" -C "$T/x"
# `enable` stages the tool (CLI, daemon, media tools, and for CUA its driver) into ~/.enkidu/bin, starts the daemon and
# probes it. Already current: enable the installed copy, which just (re)starts the daemon, e.g. after a reboot.
BIN="$T/x/$CLI"
cmp -s "$BIN" ~/.enkidu/bin/$CLI && cmp -s "$T/x/enkidu-daemon" ~/.enkidu/bin/enkidu-daemon && BIN=~/.enkidu/bin/$CLI
out=$("$BIN" enable --json)
grep -qs '.enkidu/bin' ~/.profile || echo 'export PATH="$HOME/.enkidu/bin:$PATH"' >> ~/.profile
if echo "$out" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ready") else 1)'; then
  echo "   $CLI ready ($(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"][:7])' "$T/latest.json"))"
else
  echo "   $CLI installed but not ready: $out"; exit 1
fi
EOF
}
fail=0
install_tool browser enkidu-browser || fail=1
install_tool cua enkidu-cua || fail=1
exit $fail
