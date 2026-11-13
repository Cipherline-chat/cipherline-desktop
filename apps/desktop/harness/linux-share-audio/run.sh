#!/usr/bin/env bash
# Re-runnable proof harness for src-native/audio_capture_linux.cc (PipeWire screen-share audio).
#
#   apps/desktop/harness/linux-share-audio/run.sh [outdir]
#
# 1. builds the addon on this machine (node-gyp, vendored headers, no system dev packages) - or, with
#    PREBUILT_ADDON=/path/to/audio_capture.node, tests THAT binary instead (e.g. the output of
#    `npm run rebuild-native:linux-compat`, the glibc-2.31 build that actually ships),
# 2. runs the REAL-EXCLUSION test in an ubuntu:24.04 container with pipewire + wireplumber +
#    pipewire-pulse (two tones from different processes, FFT of what the addon captured),
# 2b. runs the PER-APPLICATION test (Wayland window shares: list the apps playing audio, capture one app's
#    audio only, re-link a restarted stream, refuse a handle main did not issue) against the same stack, with the
#    REAL electron/app-audio.ts + capture-consent.ts compiled and mounted - the main-process rules, not a copy,
# 3. runs the ABSENT-LIBRARY test in a bare ubuntu:24.04 container with no PipeWire at all.
# Needs docker. Uses the host's node binary (mounted read-only), so no node is installed in the image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$HERE/output}"
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
mkdir -p "$OUT"

if [ -n "${PREBUILT_ADDON:-}" ]; then
  echo "== using prebuilt addon $PREBUILT_ADDON"
  ADDON="$(readlink -f "$PREBUILT_ADDON")"
else
  echo "== build addon"
  ( cd "$DESKTOP" && npx node-gyp rebuild --nodedir="${NODE_GYP_NODEDIR:-$HOME/.cache/node-gyp/$(node -p 'process.versions.node')}" >"$OUT/build.log" 2>&1 )
  ADDON="$DESKTOP/build/Release/audio_capture.node"
fi
ls -l "$ADDON"
echo "undefined PipeWire/SPA/X11 symbols (must be 0): $(nm -D --undefined-only "$ADDON" | grep -ci 'pw_\|spa_\|XOpen' || true)" | tee "$OUT/undefined-symbols.txt"

docker image inspect cipherline-pw-test >/dev/null 2>&1 || docker build -q -t cipherline-pw-test "$HERE"

echo "== real exclusion test (pipewire stack in a container)"
set +e
docker run --rm --name cl-pw-test \
  -v "$NODE_DIR":/opt/node:ro -v "$ADDON":/addon/audio_capture.node:ro -v "$HERE":/h:ro -v "$OUT":/out \
  cipherline-pw-test bash /h/inside.sh
RC=$?
set -e
echo "exclusion test container exit: $RC"

echo "== per-application audio test (same stack; electron/app-audio.ts + capture-consent.ts compiled from this checkout)"
JS="$(mktemp -d)"
( cd "$DESKTOP" && npx tsc electron/app-audio.ts electron/capture-consent.ts --outDir "$JS" --module commonjs --target es2022 \
    --skipLibCheck --esModuleInterop --strict >"$OUT/app-compile.log" 2>&1 )
ls "$JS"
set +e
docker run --rm --name cl-pw-app-test -e APP_ONLY=1 \
  -v "$NODE_DIR":/opt/node:ro -v "$ADDON":/addon/audio_capture.node:ro -v "$HERE":/h:ro -v "$JS":/js:ro -v "$OUT":/out \
  cipherline-pw-test bash /h/inside.sh
RC_APP=$?
set -e
echo "per-application test container exit: $RC_APP"

echo "== X11 window -> pid test (xterm under Xvfb)"
docker run --rm -v "$NODE_DIR":/opt/node:ro -v "$ADDON":/addon/audio_capture.node:ro -v "$HERE":/h:ro cipherline-pw-test \
  bash /h/x11-pid.sh 2>&1 | tee "$OUT/x11-pid.log"

echo "== absent-library test (bare ubuntu:24.04, no libpipewire, no libX11)"
docker run --rm -v "$NODE_DIR":/opt/node:ro -v "$ADDON":/addon/audio_capture.node:ro -v "$HERE":/h:ro ubuntu:24.04 \
  /opt/node/bin/node /h/absent-lib-test.mjs | tee "$OUT/absent-lib.log"
exit $((RC || RC_APP))
