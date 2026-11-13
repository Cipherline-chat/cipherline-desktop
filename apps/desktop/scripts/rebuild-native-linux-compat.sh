#!/usr/bin/env bash
# Build the Linux native binaries (build/Release/audio_capture.node + build/Release/cl-wayland-overlay)
# inside an old-glibc container so they load on every distro Electron itself supports.
#
#   npm run rebuild-native:linux-compat          (what the release-linux CI job and local devs both run)
#
# WHY a container: a binary links the glibc of the machine that built it. `npm run rebuild-native` on an
# Ubuntu 24.04 box (glibc 2.39) produced a .node needing GLIBC_2.38 (the C23 __isoc23_strtol/sscanf redirects
# in the 2.38+ headers) plus GLIBC_2.34 (dlopen/dlsym/dlclose/pthread_once moved from libdl/libpthread into
# libc) and 2.32 (__libc_single_threaded), so on Ubuntu 22.04 / Debian 12 it failed to dlopen and Linux
# screen-share audio silently did not exist. The cure is where it is built, not the source.
#
# FLOOR = GLIBC 2.31 (Ubuntu 20.04, Debian 11). Electron 43's own Linux binaries need at most GLIBC_2.25
# (measured with objdump on the 43.8.1 release: electron 2.25, libffmpeg/libEGL/crashpad <= 2.17), so
# 2.31 is not limited by Electron; it is the oldest image that still has a maintained toolchain + apt mirror
# (focal; the next step down, 18.04, is gone). Going lower buys nothing: Electron's GTK3/NSS/libstdc++
# requirements already exclude those distros. Bumping the floor means changing the Dockerfile digest, GLIBC_FLOOR
# here, and the matching numbers in .github/workflows/release-desktop.yml - a wiring test keeps them in step.
#
# Node itself is the HOST's node (mounted read-only; official builds need glibc 2.28 so they run in focal) and
# the Electron headers come from the host's ~/.electron-gyp cache (downloaded on first use). Output lands in
# apps/desktop/build/Release/ exactly like `npm run rebuild-native`, so packaging is unchanged.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
ELECTRON_VERSION="${ELECTRON_VERSION:-43.8.7}"   # keep in step with "rebuild-native" in package.json
GLIBC_FLOOR="${GLIBC_FLOOR:-2.31}"
IMAGE="cipherline-native-linux-compat:glibc-2.31"
DEVDIR="${ELECTRON_GYP_DIR:-$HOME/.electron-gyp}"

command -v docker >/dev/null || { echo "docker is required (builds in an Ubuntu 20.04 container for glibc 2.31)" >&2; exit 2; }
NODE_BIN="$(readlink -f "$(command -v node)")"
NODE_DIR="$(dirname "$(dirname "$NODE_BIN")")"
NODE_GYP="$NODE_DIR/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
[ -f "$NODE_GYP" ] || { echo "node-gyp not found at $NODE_GYP (expected the npm bundled with node)" >&2; exit 2; }

docker build -q -t "$IMAGE" "$HERE/linux-compat" >/dev/null
mkdir -p "$DEVDIR"
OUT="$DESKTOP/build/Release"
rm -rf "$OUT"          # never let a stale host-built (newer-glibc) binary survive a failed container build
mkdir -p "$OUT"

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$DESKTOP/src-native":/w/src-native:ro -v "$DESKTOP/binding.gyp":/w/binding.gyp:ro \
  -v "$NODE_DIR":/opt/node:ro -v "$DEVDIR":/devdir -v "$OUT":/out \
  "$IMAGE" bash -euc '
    cp -r /w /tmp/b && cd /tmp/b
    /opt/node/bin/node '"/opt/node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"' rebuild \
      --target='"$ELECTRON_VERSION"' --arch=x64 --dist-url=https://electronjs.org/headers --devdir=/devdir
    cp build/Release/audio_capture.node /out/
    if [ -x build/Release/cl-wayland-overlay ]; then cp build/Release/cl-wayland-overlay /out/; fi'

test -f "$OUT/audio_capture.node"

# The native (hardware) share helper: plain C, MIT headers vendored in native/share-encoder/third_party, libc is its only DT_NEEDED
# (libva / libpipewire / libcuda / libnvidia-encode are dlopen()ed at run time), compiled in the same glibc-2.31 container. A failure here
# must NOT fail the addon build: without the helper the hardware share is simply unavailable and the app falls back to Chromium's encoder.
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$DESKTOP/native/share-encoder":/w/share-encoder:ro -v "$OUT":/out \
  "$IMAGE" bash -euc 'cp -r /w/share-encoder /tmp/se && cd /tmp/se && make vendored CFLAGS="-O2 -Wall -Wno-unused-parameter -Wno-missing-field-initializers" && cp build/share-encoder-helper /out/' \
  || echo "warning: share-encoder-helper did not build; this Linux release will have no hardware screen share" >&2
# Local builds check the floor here. CI sets SKIP_GLIBC_GUARD=1 because its build step is continue-on-error
# (a genuine compile failure must only warn); a glibc-floor violation must NOT be swallowed that way, so CI runs
# check-glibc-floor.sh as its own, fatal, step instead.
[ "${SKIP_GLIBC_GUARD:-}" = "1" ] && { echo "built $OUT (glibc floor check deferred to the caller)"; exit 0; }
# The helper is a second target of the same gyp run, so it is present whenever the addon is.
BINS=("$OUT/audio_capture.node")
[ -x "$OUT/share-encoder-helper" ] && BINS+=("$OUT/share-encoder-helper")
[ -x "$OUT/cl-wayland-overlay" ] && BINS+=("$OUT/cl-wayland-overlay")
bash "$HERE/check-glibc-floor.sh" "$GLIBC_FLOOR" "${BINS[@]}"
