#!/usr/bin/env bash
# Firewall hitch: the REAL dev Electron app on a private Xvfb display, renderer from the harness Vite
# (../fwh.vite.config.ts on 127.0.0.1:5297) pinned to an ISOLATED loopback API, with a CDP port for pw.mjs.
# Never the shared dev stack, staging or prod.
#
#   Isolated API (throwaway containers, no volumes) — see ../discord-import-final/api.sh for the build/run
#   recipe; ports used in the 2026-11-22 round: pg 55597 (DB clfwh), redis 16597, minio 9297, API 13197.
#   Xvfb :197 -screen 0 1600x1000x24 &
#   FWH_API_HOST=127.0.0.1:13197 PORT=5297 npx vite --config harness/fwh.vite.config.ts &
#   (cd apps/desktop && tsc -p tsconfig.electron.json)
#   S=<scratch> harness/fwh/launch.sh a 9597
#   API_LOG=<api log> S=<scratch> node harness/fwh/acct.mjs fwplayer > $S/acct.json   (register; codes from the API log)
#   S=<scratch> node harness/fwh/pw.mjs 9597 $PWD/harness/fwh/step-login.mjs, then step-code.mjs, then
#   "Start fresh"; step-open.mjs opens the game; step-trace.mjs <ms> <name> records a Chrome trace while
#   pressing Space; metrics.mjs / overlap.mjs / periodic.mjs / gc.mjs / gpu.mjs / fns.mjs read it.
#
# Gotchas met on this box:
#   - No system keyring under Xvfb: SecureStore puts up a MODAL "Encryption at rest disabled" dialog and the
#     main window is never created until it is answered; this script presses Return on it (xdotool).
#   - The user D-Bus can leave the keyring probe hanging: run under a private `dbus-run-session`.
#   - WebGL needs `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`
#     (no GPU here); without them Keys says "this machine can't draw the game".
#   - A second launch on the same --user-data-dir loses the single-instance lock and quits silently while the
#     OLD process keeps answering on the CDP port: kill by the user-data-dir first (done below).
#   - SwiftShader keeps the GPU process ~97% busy: worker frame rates here are load noise; compare
#     main-thread costs (BeginMainFrames/s, task ms/s), not fps.
set -u
S="${S:?set S to a scratch directory}"
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON="${ELECTRON:-/home/antigravity/Cipherline/apps/desktop/node_modules/electron/dist/electron}"
N="$1"; P="$2"; shift 2
export DISPLAY="${XDISPLAY:-:197}"
pkill -f "dist/electron --user-data-dir=$S/ud-$N" 2>/dev/null; sleep 2
mkdir -p "$S/ud-$N"
cd "$APP"
VITE_DEV_SERVER_URL=http://127.0.0.1:5297 VITE_API_HOST=127.0.0.1:13197 ELECTRON_ENABLE_LOGGING=1 \
  setsid nohup dbus-run-session -- "$ELECTRON" . \
  --user-data-dir="$S/ud-$N" --remote-debugging-port="$P" --no-sandbox --password-store=basic \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist "$@" \
  > "$S/electron-$N.log" 2>&1 < /dev/null &
for i in $(seq 1 40); do
  W=$(xdotool search --name "Encryption at rest disabled" 2>/dev/null | head -1)
  if [ -n "$W" ]; then xdotool windowfocus --sync "$W"; xdotool key --window "$W" Return; echo "keyring dialog answered"; break; fi
  curl -s -m2 "http://127.0.0.1:$P/json/list" | grep -q 5297 && break
  sleep 1
done
for i in $(seq 1 60); do curl -s -m2 "http://127.0.0.1:$P/json/list" | grep -q 5297 && { echo "renderer up (cdp $P)"; exit 0; }; sleep 1; done
echo "renderer NOT up: see $S/electron-$N.log"; exit 1
