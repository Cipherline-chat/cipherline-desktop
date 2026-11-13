#!/usr/bin/env bash
# Linux screen-share distro x session matrix.
#
#   harness/linux-share-matrix/run.sh [distro ...]          # default: every Dockerfile in docker/
#   SESSIONS="sway x11" run.sh ubuntu-24.04                 # subset of sessions (sway x11 kde gnome)
#   KEEP_IMAGES=1 run.sh ...                                # keep the distro images (default: removed after each distro, the dev box has little disk)
#   GPU=0 run.sh ...                                        # do not pass /dev/dri (software baseline)
#   PKG=1 run.sh ...                                        # also smoke-test the staging AppImage + .deb (needs them in $PKG_DIR)
#
# Cells run strictly one after another. Containers run with --rm --init on an --internal docker network (no route out:
# the harness needs no account and must never reach production). Nothing is installed on the host.
# Output: $OUT_ROOT/<distro>/<session>/{cell.json,cell.md,...}, then $OUT_ROOT/matrix.md + matrix.json.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/../.." && pwd)"
SCRATCH_DEFAULT=/tmp/claude-1001/-home-antigravity-Cipherline/985fe53f-c49e-46ba-80fb-a9929bad2f4a/scratchpad
OUT_ROOT="${OUT_ROOT:-$SCRATCH_DEFAULT/linux-matrix}"
SESSIONS="${SESSIONS:-sway kde gnome x11}"
GPU="${GPU:-1}"
PKG="${PKG:-0}"
KEEP_IMAGES="${KEEP_IMAGES:-0}"
NET=clm-internal${MATRIX_IMG_SUFFIX:-}
mkdir -p "$OUT_ROOT"

say() { printf '\n== %s\n' "$*"; }

# ── inputs ────────────────────────────────────────────────────────────────────────────────────────────────────────────
ELECTRON_VER="$(node -p "require('$DESKTOP/package.json').devDependencies.electron")"
ELECTRON_DIST="$DESKTOP/node_modules/electron/dist"
if [ ! -x "$ELECTRON_DIST/electron" ]; then
  ELECTRON_DIST="$OUT_ROOT/../electron-dist-$ELECTRON_VER"
  if [ ! -x "$ELECTRON_DIST/electron" ]; then
    ZIP="$(ls ~/.cache/electron/*/electron-v$ELECTRON_VER-linux-x64.zip 2>/dev/null | head -1)"
    [ -n "$ZIP" ] || { echo "Electron $ELECTRON_VER is neither installed (node_modules/electron/dist) nor cached (~/.cache/electron)"; exit 2; }
    mkdir -p "$ELECTRON_DIST" && unzip -q -o "$ZIP" -d "$ELECTRON_DIST"
  fi
fi
echo "electron: $ELECTRON_VER at $ELECTRON_DIST"

# The addon from `npm run rebuild-native` (built on THIS box). Its glibc requirement follows the build host, so a second copy is
# built in an Ubuntu 22.04 container (glibc 2.35) and used for every cell; the host-built one is only test-loaded per distro.
ADDON_HOST="$DESKTOP/build/Release/audio_capture.node"
if [ ! -f "$ADDON_HOST" ]; then say "building the native addon (npm run rebuild-native)"; ( cd "$DESKTOP" && npm run rebuild-native ) || { echo "addon build failed"; exit 2; }; fi
ADDON_DIR="$OUT_ROOT/../addon-glibc235"
if [ ! -f "$ADDON_DIR/audio_capture.node" ] || [ "$ADDON_DIR/audio_capture.node" -ot "$DESKTOP/src-native/audio_capture_linux.cc" ]; then say "building the portable addon (ubuntu:22.04)"; "$HERE/build-addon.sh" "$ADDON_DIR" || exit 2; fi
ADDON="$ADDON_DIR/audio_capture.node"
echo "addon (used in cells): $ADDON  (max glibc $(grep -ao 'GLIBC_[0-9.]*' "$ADDON" | sort -u -V | tail -1))"
echo "addon (dev-box rebuild-native, load-tested only): $ADDON_HOST  (max glibc $(grep -ao 'GLIBC_[0-9.]*' "$ADDON_HOST" | sort -u -V | tail -1))"
# The app's own Linux hardware-encode decision (electron/linux-video-encode.ts), transpiled so the harness applies the REAL function.
LVE_DIR="$OUT_ROOT/../lve"; mkdir -p "$LVE_DIR"
( cd "$DESKTOP" && npx --no-install esbuild electron/linux-video-encode.ts --format=cjs --platform=node --outfile="$LVE_DIR/linux-video-encode.cjs" --log-level=warning ) || { echo "could not transpile linux-video-encode.ts"; exit 2; }
# The app's own portal capture decisions (sharePlatformSupport.portalCaptureRequest + portalCapturePlan.portalRetuneTouchesCapture), bundled so the
# `rate` stage asks the portal for exactly what the app asks for. Mounted at /pcr.
PCR_DIR="$OUT_ROOT/../pcr"; mkdir -p "$PCR_DIR"
printf "export { portalCaptureRequest } from '%s/src/utils/sharePlatformSupport';\nexport { portalRetuneTouchesCapture } from '%s/src/utils/portalCapturePlan';\nexport { createPortalPicks, planPortalPick, pickFromListing } from '%s/electron/portal-pick';\n" "$DESKTOP" "$DESKTOP" "$DESKTOP" > "$PCR_DIR/entry.ts"
( cd "$DESKTOP" && npx --no-install esbuild "$PCR_DIR/entry.ts" --bundle --format=cjs --platform=node --outfile="$PCR_DIR/portal-capture-plan.cjs" --log-level=warning ) || { echo "could not bundle the portal capture decisions"; exit 2; }
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"

# Drift guard: the app's switches are mirrored by hand in app/main.js. If main.ts stops saying these things, fail loudly.
drift=0
chk() { grep -qF -- "$2" "$DESKTOP/electron/$1" || { echo "DRIFT: electron/$1 no longer contains: $2"; drift=1; }; }
chk main.ts "appendSwitch('ozone-platform-hint', 'auto')"
chk main.ts "appendSwitch('log-level', '3')"
chk capture-flags.ts "enableFeatures.push('WebRTCPipeWireCapturer')"
chk linux-video-encode.ts "LINUX_HW_ENCODE_FEATURE = 'AcceleratedVideoEncoder'"
chk linux-video-encode.ts "CIPHERLINE_LINUX_HW_ENCODE"
# the one-prompt flow app/main.js (flow-after) replays: placeholder admitted without a listing, a NEW id per capture, no listing on the portal
chk main.ts "const portalPlaceholder = captureViaPortal() && isPortalSourceId(sourceId);"
chk main.ts "portalCaptureVideo(++portalCaptureSeq)"
chk main.ts "Not listing desktop sources through the portal"
chk portal-source.ts 'return { id: `screen:${n}:0`, name: PORTAL_SOURCE_NAME };'
[ $drift = 0 ] || { echo "app/main.js mirrors electron/main.ts switches; update it, then rerun"; exit 2; }

if [ "$#" -gt 0 ]; then DISTROS=("$@"); else DISTROS=(); for f in "$HERE"/docker/*.Dockerfile; do DISTROS+=("$(basename "$f" .Dockerfile)"); done; fi
RENDER_GID="$(stat -c %g /dev/dri/renderD128 2>/dev/null || echo 993)"
VIDEO_GID="$(getent group video | cut -d: -f3)"

docker network inspect $NET >/dev/null 2>&1 || docker network create --internal $NET >/dev/null
trap 'docker network rm $NET >/dev/null 2>&1 || true' EXIT

for D in "${DISTROS[@]}"; do
  IMG="clm-$D${MATRIX_IMG_SUFFIX:-}"   # MATRIX_IMG_SUFFIX: a private tag, so concurrent matrix runs never remove each other's image
  say "distro $D: build image"
  if [ "${REUSE_IMAGE:-0}" = 1 ] && docker image inspect "$IMG" >/dev/null 2>&1; then echo "  (REUSE_IMAGE=1: $IMG already built)"
  elif ! docker build --progress=plain -t "$IMG" -f "$HERE/docker/$D.Dockerfile" "$HERE/docker" > "$OUT_ROOT/build-$D.log" 2>&1; then
    echo "BUILD FAILED for $D (see $OUT_ROOT/build-$D.log)"; mkdir -p "$OUT_ROOT/$D"; echo "image build failed: see build-$D.log" > "$OUT_ROOT/$D/BUILD_FAILED"
    docker rmi -f "$IMG" >/dev/null 2>&1; continue
  fi
  for S in $SESSIONS; do
    CELL="$OUT_ROOT/$D/$S"; rm -rf "$CELL"; mkdir -p "$CELL"; chmod 777 "$CELL"
    say "cell $D / $S"
    if ! docker run --rm --entrypoint test "$IMG" -e "/opt/clm/has-$S" 2>/dev/null; then
      echo "not packaged in this image" > "$CELL/NOT_PACKAGED"; echo "  -> $S is not packaged on $D"; continue
    fi
    DEVARGS=(); [ "$GPU" = 1 ] && DEVARGS=(--device /dev/dri --group-add "$RENDER_GID" --group-add "$VIDEO_GID")
    # Experiment knob: force a libva driver for the cell (e.g. MATRIX_LIBVA_DRIVER=i965). Unset in every standard run.
    LIBVA_ARGS=(); [ -n "${MATRIX_LIBVA_DRIVER:-}" ] && LIBVA_ARGS=(-e "LIBVA_DRIVER_NAME=$MATRIX_LIBVA_DRIVER")
    NAME="clm-$D-$S${MATRIX_IMG_SUFFIX:-}"
    timeout 1100 docker run --rm --init --name "$NAME" --network $NET --user 1001:1001 "${DEVARGS[@]}" "${LIBVA_ARGS[@]}" \
      --shm-size=1g --memory=4g --cpus=8 --pids-limit=2048 \
      -v "$NODE_DIR":/node:ro -v "$ELECTRON_DIST":/electron:ro -v "$ADDON":/addon/audio_capture.node:ro -v "$ADDON_HOST":/addon-host/audio_capture.node:ro \
      -v "$LVE_DIR":/lve:ro -v "$PCR_DIR":/pcr:ro -v "$HERE":/h:ro -v "$DESKTOP/harness/linux-share-audio":/h-audio:ro -v "$CELL":/out \
      -e OUT=/out -e MATRIX_ONLY_HWENC="${MATRIX_ONLY_HWENC:-0}" -e MATRIX_EXTRA_FEATURES="${MATRIX_EXTRA_FEATURES:-}" -e MATRIX_GNOME_SHELL="${MATRIX_GNOME_SHELL:-0}" -e MATRIX_TESTS="${MATRIX_TESTS:-}" -e MATRIX_HWENC_EXTRA_ARGS="${MATRIX_HWENC_EXTRA_ARGS:-}" -e CIPHERLINE_LINUX_HW_ENCODE="${CIPHERLINE_LINUX_HW_ENCODE:-}" -e MATRIX_DEFAULT_EXTRA_ARGS="${MATRIX_DEFAULT_EXTRA_ARGS:-}" -e MATRIX_QUICK="${MATRIX_QUICK:-0}" -e MATRIX_W -e MATRIX_H -e MATRIX_HZ -e MATRIX_WATCHDOG_S -e MATRIX_CELL_TIMEOUT -e MATRIX_RATE_FPS -e MATRIX_RATE_SIZES -e MATRIX_RATE_MODES -e MATRIX_RATE_SECS -e MATRIX_PICK_TYPES -e MATRIX_RATE_CPU_ROUNDS -e MATRIX_RATE_CODEC -e MATRIX_RATE_PLAN -e MATRIX_RATE_RESTORE -e MATRIX_RATE_HANDLER -e MATRIX_RATE_PICK -e MATRIX_RATE_PICK_THUMB -e MATRIX_RESTORE_TYPES -e MATRIX_RATE_LIVE_SENDER -e MATRIX_PAT_W -e MATRIX_PAT_H -e MATRIX_GPU="$GPU" -e MATRIX_DISTRO="$D" -e MATRIX_SESSION="$S" \
      "$IMG" bash /h/inside/cell.sh "$S" > "$CELL/container.log" 2>&1
    echo "  container exit $?"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    node "$HERE/report.mjs" cell "$CELL" "$D" "$S" >/dev/null 2>&1 || echo "  (cell report failed)"
  done
  if [ "$PKG" = 1 ] && [ -x "$HERE/pkg-smoke.sh" ]; then "$HERE/pkg-smoke.sh" "$D" "$IMG" "$OUT_ROOT" "$NODE_DIR" "$ELECTRON_DIST"; fi
  [ "$KEEP_IMAGES" = 1 ] || docker rmi -f "$IMG" >/dev/null 2>&1
  [ "$KEEP_IMAGES" = 1 ] || docker builder prune -f >/dev/null 2>&1
done
node "$HERE/report.mjs" matrix "$OUT_ROOT"
echo; echo "matrix written to $OUT_ROOT/matrix.md"
