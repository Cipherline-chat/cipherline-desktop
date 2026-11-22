#!/usr/bin/env bash
# Launch the REAL dev Electron app (main + preload compiled from this tree by `tsc -p tsconfig.electron.json`,
# renderer from the harness Vite on 127.0.0.1:5294 pinned to the isolated API) on a private Xvfb display, with a
# CDP port for app-run.mjs. Main's Discord origins go to the loopback mock (main-redirect.cjs).
#   launch.sh <name> <cdp-port> [extra electron args...]      (logs: $S/electron-<name>.log)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
S="${S:?set S to a scratch directory}"
N="$1"; P="$2"; shift 2
mkdir -p "$S/ud-$N"
cd "$APP"
DISPLAY="${XDISPLAY:-:143}" VITE_DEV_SERVER_URL=http://127.0.0.1:5294 VITE_API_HOST=127.0.0.1:13171 \
  NODE_OPTIONS="--require $HERE/../discord-import-final/main-redirect.cjs" DISCORD_MOCK=http://127.0.0.1:7994 MAIN_NET_LOG="$S/main-net-$N.log" \
  ELECTRON_ENABLE_LOGGING=1 setsid nohup /home/antigravity/Cipherline/apps/desktop/node_modules/electron/dist/electron . \
  --user-data-dir="$S/ud-$N" --remote-debugging-port="$P" --no-sandbox --password-store=basic "$@" \
  > "$S/electron-$N.log" 2>&1 < /dev/null &
echo $! > "$S/electron-$N.pid"
echo "launched $N pid $(cat "$S/electron-$N.pid") cdp $P"
