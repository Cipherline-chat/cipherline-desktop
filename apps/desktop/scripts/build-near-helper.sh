#!/usr/bin/env bash
# Build the near-helper (apps/desktop-host/near-helper: the Rust local-network history-transfer engine that Electron main
# drives over stdio) and place it at apps/desktop/build/Release/near-helper[.exe] for electron-builder's extraResources.
#
# FAIL-SAFE BY DESIGN. This script ALWAYS exits 0:
#   - the helper built    -> the real binary at build/Release/near-helper[.exe];
#   - no cargo / no docker / the build failed -> NO file and a ::warning:: line.
# package.json packages it with `extraResources: { from: "build/Release", filter: ["near-helper", "near-helper.exe"] }`: a filter
# copies what exists and silently skips what does not (measured with electron-builder here), so "no helper" becomes "the app
# ships without the local transfer feature" instead of "the release fails". An exact-path `extraResources` entry would ERROR on a
# missing source, and on Windows an empty placeholder .exe would break Authenticode signing, so neither is used. At run time
# electron/main.ts also ignores an empty file, and `nearProbe()` then answers "not available".
#
# Where it runs (all three are `shell: bash` steps of .github/workflows/release-desktop.yml, each `continue-on-error`; the glibc
# floor of the Linux result is checked here, non-fatally):
#   Linux   : inside `rust:1-bullseye`, PINNED BY DIGEST below (sha256:4730e387..., taken from the RepoDigests of the image pulled 2026-11-24; bump it deliberately) (Debian 11 = glibc 2.31, the same floor as the audio addon; this box's own toolchain
#             would link a newer glibc and load nowhere old). Needs docker; falls back to a native cargo build only when
#             there is no docker (the workflow's glibc-floor guard then checks the result).
#   macOS   : native cargo, both Apple targets, `lipo` into one universal Mach-O (electron-builder signs it with the app identity).
#   Windows : native cargo, x86_64-pc-windows-msvc (the owner's self-hosted runner has the MSVC build tools; Rust itself is
#             NOT known to be installed, hence the `command -v cargo` guard).
# The helper has its own workspace and Cargo.lock; `--locked` makes the build reproducible and read-only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
HOST_DIR="$(cd "$DESKTOP/../desktop-host" && pwd)"
OUT_DIR="$DESKTOP/build/Release"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS=windows; DEST="$OUT_DIR/near-helper.exe"; CARGO_BIN="cl-near-helper.exe" ;;
  Darwin)               OS=mac;     DEST="$OUT_DIR/near-helper";     CARGO_BIN="cl-near-helper" ;;
  *)                    OS=linux;   DEST="$OUT_DIR/near-helper";     CARGO_BIN="cl-near-helper" ;;
esac
mkdir -p "$OUT_DIR"
rm -f "$DEST"

warn() { echo "::warning title=Local history transfer::$1 - this $OS release ships WITHOUT the local transfer helper: moving history between devices will NOT work in it (the app says so on the sign-in history step). Install Rust on this runner."; }

build_linux() {
  if command -v docker >/dev/null 2>&1; then
    local tmp; tmp="$(mktemp -d)"
    docker run --rm --user "$(id -u):$(id -g)" \
      -e CARGO_HOME=/tmp/cargo -e CARGO_TARGET_DIR=/tmp/target \
      -v "$HOST_DIR":/w:ro -v "$tmp":/out \
      rust:1-bullseye@sha256:4730e387a220a08a365c77da3096544dde214f9d796c16284d4be45438cad4a9 bash -euc 'cd /w/near-helper && cargo build --release --locked && cp /tmp/target/release/cl-near-helper /out/near-helper' \
      && cp "$tmp/near-helper" "$DEST"
    local rc=$?
    rm -rf "$tmp"
    return $rc
  fi
  command -v cargo >/dev/null 2>&1 || return 127
  ( cd "$HOST_DIR/near-helper" && cargo build --release --locked ) && cp "$HOST_DIR/near-helper/target/release/$CARGO_BIN" "$DEST"
}

build_mac() {
  command -v cargo >/dev/null 2>&1 || return 127
  command -v lipo >/dev/null 2>&1 || return 127
  # rustup is how the second Apple target is added; without it only the host architecture exists
  command -v rustup >/dev/null 2>&1 && rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1
  ( cd "$HOST_DIR/near-helper" \
    && cargo build --release --locked --target aarch64-apple-darwin \
    && cargo build --release --locked --target x86_64-apple-darwin ) || return 1
  lipo -create -output "$DEST" \
    "$HOST_DIR/near-helper/target/aarch64-apple-darwin/release/$CARGO_BIN" \
    "$HOST_DIR/near-helper/target/x86_64-apple-darwin/release/$CARGO_BIN" && chmod +x "$DEST"
}

build_windows() {
  command -v cargo >/dev/null 2>&1 || return 127
  ( cd "$HOST_DIR/near-helper" && cargo build --release --locked --target x86_64-pc-windows-msvc ) \
    && cp "$HOST_DIR/near-helper/target/x86_64-pc-windows-msvc/release/$CARGO_BIN" "$DEST"
}

rc=0
case "$OS" in
  linux) build_linux; rc=$? ;;
  mac) build_mac; rc=$? ;;
  windows) build_windows; rc=$? ;;
esac

# Linux: the same glibc floor as every other native binary we ship (a helper that needs a newer glibc loads nowhere old). Unlike the
# audio addon's FATAL guard this one is not allowed to fail a release: a helper over the floor is dropped, with a warning.
if [ "$rc" -eq 0 ] && [ "$OS" = linux ] && [ -s "$DEST" ] && ! bash "$HERE/check-glibc-floor.sh" 2.31 "$DEST"; then
  rc=3
fi

if [ "$rc" -eq 0 ] && [ -s "$DEST" ]; then
  chmod +x "$DEST" 2>/dev/null || true
  echo "near-helper built: $DEST ($(wc -c < "$DEST") bytes)"
else
  if [ "$rc" -eq 127 ]; then warn "no Rust toolchain (or docker / lipo) on this runner"; else warn "the helper build failed (exit $rc)"; fi
  rm -f "$DEST"
fi
exit 0
