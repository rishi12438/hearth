#!/usr/bin/env bash
# Set up Hearth for where it runs. Pick the target:
#
#   sudo bash deploy/setup.sh lightsail <domain> <email>      the always-on hub: your domain, HTTPS, memory, reminders
#                                                             (AWS Lightsail or any Ubuntu VPS)
#   bash deploy/setup.sh mac <hub-url> [--name "Studio"]      link this Mac to that hub: work runs here, with your own
#                                                             Claude/Codex login, whenever it's on
#
# The Mac connects out to the hub and keeps the line open, so it needs no domain, open ports or tunnel.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }
case "${1:-}" in
  lightsail|vps|server) shift; exec bash "$DIR/setup-lightsail.sh" "$@" ;;
  mac) shift; exec bash "$DIR/setup-mac.sh" "$@" ;;
  *.*) exec bash "$DIR/setup-lightsail.sh" "$@" ;; # the older form: setup.sh <domain> <email>
  *) usage; exit 1 ;;
esac
