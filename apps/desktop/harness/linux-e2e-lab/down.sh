#!/usr/bin/env bash
# Tears the lab down: client containers (cle2e-sharer / cle2e-viewer), the compose project (tmpfs data dies with it) and
# the network. Touches only cle2e-* names. KEEP_IMAGE=1 keeps the cle2e-desktop image (default removes it).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker rm -f cle2e-sharer cle2e-viewer >/dev/null 2>&1 || true
docker compose -f "$HERE/compose.yml" --env-file "$HERE/out/lab.env" down -v >/dev/null 2>&1 \
  || docker compose -f "$HERE/compose.yml" down -v >/dev/null 2>&1 || true
docker network rm cle2e-net >/dev/null 2>&1 || true
[ "${KEEP_IMAGE:-0}" = 1 ] || docker rmi cle2e-desktop >/dev/null 2>&1 || true
echo "lab down"
