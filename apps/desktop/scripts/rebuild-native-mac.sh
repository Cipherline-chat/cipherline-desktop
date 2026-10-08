#!/usr/bin/env bash
# Build the macOS audio_capture addon (ScreenCaptureKit) as ONE universal binary.
#
# The macOS release ships arm64 and x64 from a single build, and electron-builder
# packages build/Release/audio_capture.node as-is for both — so it must contain
# both slices. node-gyp builds a single architecture per run, hence: build each,
# then lipo them together.
#
#   npm run rebuild-native:mac        (needs Xcode command line tools, macOS)
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "rebuild-native-mac.sh only runs on macOS" >&2
  exit 1
fi

ELECTRON_VERSION="$(node -p "require('./package.json').build.electronVersion")"
OUT=build/Release/audio_capture.node
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# Never leave a half build behind: an arm64-only (or stale) addon packaged
# into the x64 app fails to dlopen there. On any failure the addon is removed,
# so the release ships without it (main.ts degrades to no screenshare audio /
# no window-share overlay) and the workflow's warning step fires.
trap 'rm -f "$OUT"' ERR

for arch in arm64 x64; do
  echo "── audio_capture for darwin-$arch (Electron $ELECTRON_VERSION)"
  npx --package=@electron/rebuild -- electron-rebuild -f -w audio_capture -v "$ELECTRON_VERSION" --arch "$arch"
  cp "$OUT" "$STAGE/audio_capture-$arch.node"
done

lipo -create -output "$OUT" "$STAGE/audio_capture-arm64.node" "$STAGE/audio_capture-x64.node"
echo "── universal addon:"
lipo -info "$OUT"
# Both slices or nothing. (One arch per call: this lipo takes any further
# word after the first arch as another input file.)
lipo "$OUT" -verify_arch arm64
lipo "$OUT" -verify_arch x86_64
