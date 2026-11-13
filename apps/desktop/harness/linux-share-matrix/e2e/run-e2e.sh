#!/usr/bin/env bash
# Hardware-encode E2EE proof against a real SFU, inside a matrix distro container with the render node passed in.
#
#   harness/linux-share-matrix/e2e/run-e2e.sh <distro> <case> [case ...]
#
# Cases (each is a fresh room on a THROWAWAY LiveKit v1.9.12 container, publisher + viewer in one Electron):
#   h264        H.264 Constrained Baseline (the profile LiveKit negotiates by default), E2EE on, hardware encode on (the app default)
#   vp8         VP8, E2EE on
#   h264-high   H.264 High on the share's transceiver (preferH264HighOnSender), E2EE on
#   h264-sw     H.264 CB with CIPHERLINE_LINUX_HW_ENCODE=0 (software OpenH264): the control that the same pipeline decodes
#   h264-wrongkey  the VIEWER has a different key: must decode NOTHING (proves "frames decoded" means "frames decrypted")
#   h264-plain  H.264 CB, E2EE off (what the SFU forwards when nothing is encrypted)
# Env: OUT_ROOT (default: the session scratchpad linux-matrix-e2e), E2E_SECS (default 40), E2E_FPS (60), KEEP_IMAGES=1.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATRIX="$(cd "$HERE/.." && pwd)"
DESKTOP="$(cd "$MATRIX/../.." && pwd)"
SCRATCH_DEFAULT=/tmp/claude-1001/-home-antigravity-Cipherline/985fe53f-c49e-46ba-80fb-a9929bad2f4a/scratchpad
OUT_ROOT="${OUT_ROOT:-$SCRATCH_DEFAULT/linux-matrix-e2e}"
D="${1:?distro}"; shift
[ "$#" -gt 0 ] || set -- h264 vp8
SUF="${MATRIX_IMG_SUFFIX:--e2e}"
IMG="clm-$D$SUF"; NET="clm-net$SUF"; LK="clm-lk$SUF"
SECS="${E2E_SECS:-40}"; FPS="${E2E_FPS:-60}"
mkdir -p "$OUT_ROOT/$D"
say() { printf '\n== %s\n' "$*"; }

# inputs shared with run.sh: electron, the app's own decision module
ELECTRON_VER="$(node -p "require('$DESKTOP/package.json').devDependencies.electron")"
ELECTRON_DIST="$OUT_ROOT/../electron-dist-$ELECTRON_VER"
[ -x "$ELECTRON_DIST/electron" ] || ELECTRON_DIST="$DESKTOP/node_modules/electron/dist"
[ -x "$ELECTRON_DIST/electron" ] || { echo "no electron $ELECTRON_VER"; exit 2; }
LVE_DIR="$OUT_ROOT/../lve"; mkdir -p "$LVE_DIR"
( cd "$DESKTOP" && npx --no-install esbuild electron/linux-video-encode.ts --format=cjs --platform=node --outfile="$LVE_DIR/linux-video-encode.cjs" --log-level=warning ) || exit 2
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"

# the page: the app's own code (publish options, sender params, lighter-copy gate, E2EE worker, viewer arbiter), bundled
DIST="$OUT_ROOT/../e2e-dist"
if [ ! -f "$DIST/index.html" ] || [ -n "$(find "$DESKTOP/src/utils/screenShare.ts" "$DESKTOP/src/utils/linuxHwEncode.ts" "$DESKTOP/harness/share-e2e/main.tsx" -newer "$DIST/index.html" 2>/dev/null)" ]; then
  say "building the harness page"
  ( cd "$DESKTOP" && OUT_DIR="$DIST" npx --no-install vite build -c harness/share-e2e/vite.config.ts ) || { echo "page build failed"; exit 2; }
fi

# throwaway SFU on an internal network (no route out)
LK_KEY=devkey; LK_SECRET="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)e2esecret0123456789"
cat > "$OUT_ROOT/lk.yaml" <<EOF
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  congestion_control: { enabled: true, allow_pause: true }
keys:
  $LK_KEY: $LK_SECRET
room:
  auto_create: true
EOF
docker network rm "$NET" >/dev/null 2>&1; docker network create --internal "$NET" >/dev/null
docker rm -f "$LK" >/dev/null 2>&1
docker run -d --name "$LK" --network "$NET" -v "$OUT_ROOT/lk.yaml":/lk.yaml:ro livekit/livekit-server:v1.9.12 --config /lk.yaml >/dev/null || { echo "livekit failed to start"; exit 2; }
cleanup() { docker rm -f "$LK" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; [ "${KEEP_IMAGES:-0}" = 1 ] || docker rmi -f "$IMG" >/dev/null 2>&1; }
trap cleanup EXIT
sleep 3
LK_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "'"$NET"'").IPAddress}}' "$LK")"
echo "livekit at $LK_IP"

say "image $D"
docker build --progress=plain -t "$IMG" -f "$MATRIX/docker/$D.Dockerfile" "$MATRIX/docker" > "$OUT_ROOT/build-$D.log" 2>&1 || { echo "build failed, see $OUT_ROOT/build-$D.log"; exit 2; }
RENDER_GID="$(stat -c %g /dev/dri/renderD128 2>/dev/null || echo 993)"; VIDEO_GID="$(getent group video | cut -d: -f3)"

for C in "$@"; do
  say "case $D / $C"
  CELL="$OUT_ROOT/$D/$C"; rm -rf "$CELL"; mkdir -p "$CELL"; chmod 777 "$CELL"
  ROOM="e2e-$C-$$-$RANDOM"
  TOK="$(node "$HERE/mint-tokens.mjs" "$LK_KEY" "$LK_SECRET" "$ROOM")" || { echo "token mint failed"; continue; }
  KEY_A="$(head -c 32 /dev/urandom | base64)"; KEY_B="$(head -c 32 /dev/urandom | base64)"
  CODEC=h264; HIGH=0; HWENV=""; KPUB="$KEY_A"; KVIEW="$KEY_A"
  case "$C" in
    h264) ;; vp8) CODEC=vp8 ;; h264-high) HIGH=1 ;;
    h264-sw) HWENV=0 ;; h264-wrongkey) KVIEW="$KEY_B" ;; h264-plain) KPUB=""; KVIEW="" ;;
    *) echo "unknown case $C"; continue ;;
  esac
  timeout 400 docker run --rm --init --name "$IMG-$C" --network "$NET" --user 1001:1001 \
    --device /dev/dri --group-add "$RENDER_GID" --group-add "$VIDEO_GID" --shm-size=1g --memory=4g --cpus=8 --pids-limit=2048 \
    -v "$NODE_DIR":/node:ro -v "$ELECTRON_DIST":/electron:ro -v "$LVE_DIR":/lve:ro -v "$MATRIX":/h:ro -v "$DIST":/dist:ro -v "$CELL":/out \
    -e OUT=/out -e MATRIX_GPU=1 -e MATRIX_W=1280 -e MATRIX_H=720 \
    -e E2E_URL="ws://$LK_IP:7880" -e E2E_TOKEN_PUB="$(printf '%s' "$TOK" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).pub')" \
    -e E2E_TOKEN_VIEW="$(printf '%s' "$TOK" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).view')" \
    -e E2E_KEY_PUB="$KPUB" -e E2E_KEY_VIEW="$KVIEW" -e E2E_CODEC="$CODEC" -e E2E_HIGH="$HIGH" -e E2E_FPS="$FPS" -e E2E_SECS="$SECS" \
    -e CIPHERLINE_LINUX_HW_ENCODE="$HWENV" -e E2E_EXTRA_ARGS="${E2E_EXTRA_ARGS:---use-fake-device-for-media-stream --use-fake-ui-for-media-stream}" \
    "$IMG" bash /h/inside/e2e-cell.sh > "$CELL/container.log" 2>&1
  echo "  container exit $?"
  [ -f "$CELL/e2e.jsonl.summary.json" ] && node -e 'const s=require(process.argv[1]);console.log(JSON.stringify({case:process.argv[2],decision:s.decision&&s.decision.reason,pub_impl:s.pub_encoder_impl,hw:s.pub_power_efficient,pub_fps:s.pub_top_fps_p50,canvas_fps:s.pub_canvas_fps_p50,pix:(s.pub_pix_samples||[]).slice(0,3),view_codec:s.view_codec,view_fps:s.view_fps_p50,view_wh:s.view_wh,frames_s:s.view_decoded_seconds_with_frames+"/"+s.view_seconds,annexb_pub:s.e2ee_annexb_pub&&{f:s.e2ee_annexb_pub.frames,rew:s.e2ee_annexb_pub.rewritten,short:s.e2ee_annexb_pub.short_sc},errs:s.encryption_errors}))' "$CELL/e2e.jsonl.summary.json" "$C"
done
