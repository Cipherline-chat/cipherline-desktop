#!/usr/bin/env bash
# Build the Windows system helper (apps/desktop-host/win-helper, Rust) and place it at apps/desktop/build/Release/win-helper.exe for
# electron-builder's extraResources (which also Authenticode-signs it while copying it, like near-helper.exe).
#
# WHY: the Electron main process used to start hidden powershell.exe (some with -EncodedCommand), tasklist.exe and reg.exe to read
# running games, Now Playing, the update signature and a GPU preference. Behavioural security engines flag exactly that as malware.
# win-helper.exe does the same work by calling Windows APIs directly, so the packaged app starts no script host or system utility.
#
# FAIL-SAFE BY DESIGN, like build-near-helper.sh: ALWAYS exits 0. No cargo / a failed build -> NO file and a ::warning:: line, and the
# extraResources filter skips a missing file. A build without it detects no games / Now Playing and REFUSES updates it cannot verify
# (the signature check fails closed); the public stable workflow therefore adds a hard "file exists" check and -RequireFile.
#
# Windows only (a no-op elsewhere). The version resource (FileVersion / ProductVersion) comes from apps/desktop/package.json.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
CRATE="$(cd "$DESKTOP/../desktop-host/win-helper" && pwd)"
OUT_DIR="$DESKTOP/build/Release"
DEST="$OUT_DIR/win-helper.exe"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) echo "win-helper: Windows only, nothing to build on $(uname -s)"; exit 0 ;;
esac

mkdir -p "$OUT_DIR"
rm -f "$DEST"

warn() { echo "::warning title=Windows helper::$1 - this release ships WITHOUT win-helper.exe: game / Now Playing detection is off and app updates are refused (the signature check cannot run). Install Rust on this runner."; }

if ! command -v cargo >/dev/null 2>&1; then warn "no Rust toolchain on this runner"; exit 0; fi

VERSION="$(cd "$DESKTOP" && node -p "require('./package.json').version" 2>/dev/null || echo "")"
export CL_HELPER_VERSION="${VERSION:-0.0.0}"

if ( cd "$CRATE" && cargo build --release --locked --target x86_64-pc-windows-msvc ) \
   && cp "$CRATE/target/x86_64-pc-windows-msvc/release/cl-win-helper.exe" "$DEST" && [ -s "$DEST" ]; then
  echo "win-helper built: $DEST ($(wc -c < "$DEST") bytes, version $CL_HELPER_VERSION)"
else
  warn "the helper build failed"
  rm -f "$DEST"
fi
exit 0
