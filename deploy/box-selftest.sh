#!/usr/bin/env bash
# Checks the seal on this server: runs src/public/selftest.ts in a container with exactly the flags a real box gets
# (internal network, read-only, no capabilities, egress proxy only). Run after setup, and after any Docker change:
#   sudo bash deploy/box-selftest.sh
set -euo pipefail
IMAGE=${HEARTH_BOX_IMAGE:-hearth-box:latest}
NET=hearth-boxes
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bundle" "$tmp/data"; chmod 755 "$tmp/bundle"; chown 10001 "$tmp/data"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal "$NET" >/dev/null
if [[ "$(docker inspect -f '{{.State.Running}}' hearth-egress 2>/dev/null || true)" != "true" ]]; then
  docker rm -f hearth-egress >/dev/null 2>&1 || true
  docker run -d --name hearth-egress --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 64 --memory 64m --cpus 0.25 --user 10001:10001 --entrypoint bun "$IMAGE" src/public/egress.ts >/dev/null
  docker network connect "$NET" hearth-egress
fi
docker run --rm --network "$NET" --read-only --tmpfs /tmp:size=16m,mode=1777 --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 256m --cpus 0.5 --user 10001:10001 \
  -v "$tmp/bundle:/bundle:ro" -v "$tmp/data:/data" -e BOX_PROXY=http://hearth-egress:3128 \
  --entrypoint bun "$IMAGE" src/public/selftest.ts
