#!/usr/bin/env bash
# Native share encoder spike: live injection test. Needs: docker (livekit/livekit-server:v1.9.12 already pulled), Xvfb, an Electron 43
# dist (ELECTRON_BIN), the helper built (native/share-encoder/build/share-encoder-helper), a VA-API render node.
#   SCRATCH=/some/dir ELECTRON_BIN=/path/electron harness/native-share-spike/run.sh
# Isolated: LiveKit on 127.0.0.1:17880/17881/17882 under its own container name, torn down on exit. Touches no cipherline-* container.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; DESKTOP="$(cd "$HERE/../.." && pwd)"
SCRATCH=${SCRATCH:?}; ELECTRON_BIN=${ELECTRON_BIN:?}
HELPER="$DESKTOP/native/share-encoder/build/share-encoder-helper"
NAME=spike-lk-$$; KEY=spikekey; SECRET=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )spikesecretspikesecret00
mkdir -p "$SCRATCH/spike" "$HERE/.out"
cat > "$SCRATCH/spike/livekit.yaml" <<EOF
port: 17880
bind_addresses: ["127.0.0.1"]
keys:
  $KEY: $SECRET
rtc:
  tcp_port: 17881
  udp_port: 17882
  use_external_ip: false
  node_ip: 127.0.0.1
  enable_loopback_candidate: true
  congestion_control: { enabled: true, allow_pause: false }
room: { auto_create: true }
logging: { level: info }
EOF
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; pkill -KILL -f 'share-encoder-helper --serve' 2>/dev/null; }
trap cleanup EXIT
cd "$DESKTOP" || exit 1
if [ -z "${SPIKE_NOBUILD:-}" ]; then
OUT_DIR="$SCRATCH/spike/dist" ../../node_modules/.bin/vite build --config harness/native-share-spike/vite.config.ts > "$SCRATCH/spike/vite.log" 2>&1 || { tail -20 "$SCRATCH/spike/vite.log"; exit 1; }
../../node_modules/.bin/esbuild harness/native-share-spike/main.ts --bundle --platform=node --format=cjs --external:electron --external:livekit-server-sdk --outfile="$HERE/.out/main.cjs" --log-level=warning || exit 1
../../node_modules/.bin/esbuild electron/preload.ts --bundle --platform=node --format=cjs --external:electron --outfile="$HERE/.out/preload.cjs" --log-level=warning || exit 1
fi
docker run -d --rm --name "$NAME" --network host -v "$SCRATCH/spike/livekit.yaml:/lk.yaml:ro" livekit/livekit-server:v1.9.12 --config /lk.yaml >/dev/null || exit 1
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17880/ && break; sleep 0.5; done
export LIBVA_DRIVER_NAME=iHD LIBVA_MESSAGING_LEVEL=0
export CIPHERLINE_NATIVE_SHARE_ENCODER=${CIPHERLINE_NATIVE_SHARE_ENCODER:-1} CIPHERLINE_NATIVE_SHARE_HELPER="$HELPER"
export SPIKE_DIST="$SCRATCH/spike/dist" SPIKE_PRELOAD="$HERE/.out/preload.cjs" SPIKE_OUT="$SCRATCH/spike/result.json"
export SPIKE_LOG="$SCRATCH/spike/progress.log"; : > "$SCRATCH/spike/progress.log"
export SPIKE_LK_KEY=$KEY SPIKE_LK_SECRET=$SECRET
xvfb-run -a -s "-screen 0 1920x1080x24" "$ELECTRON_BIN" --no-sandbox --enable-logging=stderr "$HERE/.out/main.cjs" > "$SCRATCH/spike/electron.log" 2>&1
echo "exit=$? result: $SPIKE_OUT"
