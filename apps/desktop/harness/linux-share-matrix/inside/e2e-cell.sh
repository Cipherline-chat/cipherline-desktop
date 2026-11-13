#!/usr/bin/env bash
# The hardware-encode E2EE cell, INSIDE the container: a sway (Wayland) session on the passed-in render node, then the e2e Electron app
# (harness/linux-share-matrix/e2e-app). Usage: e2e-cell.sh   (all inputs are E2E_* environment variables, see e2e-app/main.js)
set -u
H=/h
source $H/inside/common.sh
mkdir -p "$OUT"; : > "$OUT/harness.log"; : > "$PIDS"
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$@"; fi
cleanup() {
  tac "$PIDS" | while read -r pid name; do kill -- "$pid" 2>/dev/null; done
  sleep 1
  tac "$PIDS" | while read -r pid name; do kill -9 -- "$pid" 2>/dev/null; done
}
trap cleanup EXIT
{ . /etc/os-release; echo "distro=$PRETTY_NAME"; echo "kernel=$(uname -r)"; } > "$OUT/facts.txt" 2>&1
if [ -e /dev/dri/renderD128 ]; then
  LIBVA_DRIVER_NAME="${LIBVA_DRIVER_NAME:-iHD}" timeout 20 vainfo --display drm --device /dev/dri/renderD128 > "$OUT/vainfo.txt" 2>&1 || true
fi
mkdir -p -m 1777 /tmp/.X11-unix 2>/dev/null
. $H/inside/session-sway.sh
start_session; RC=$?
echo "session_start_rc=$RC" >> "$OUT/facts.txt"
[ $RC -eq 0 ] || { log "session failed (rc=$RC)"; exit 0; }
: > "$OUT/e2e.jsonl"
env E2E_OUT="$OUT/e2e.jsonl" E2E_DIST=/dist \
  timeout -k 5 "${E2E_TIMEOUT:-300}" /electron/electron --no-sandbox --user-data-dir="$HOME/ud-e2e" $E2E_EXTRA_ARGS $H/e2e-app \
  > "$OUT/electron-e2e.log" 2>&1 &
p=$!; track $p electron-e2e
wait $p; echo "electron-e2e exit=$?" >> "$OUT/facts.txt"
log "e2e cell done"
