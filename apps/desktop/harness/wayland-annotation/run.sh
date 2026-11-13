#!/usr/bin/env bash
# Re-runnable proof harness for the Wayland annotation overlay helper (src-native/wayland_overlay).
#
#   apps/desktop/harness/wayland-annotation/run.sh [tables|absent|sway|kwin|mutter|x11|all] [outdir]
#
# Everything runs in the `cl-wayland-lab` Docker image (built on first use): real headless
# compositors, no GPU, nothing installed on the host. The helper source is mounted read-only and
# compiled inside the container with the same flags binding.gyp uses. Each stage prints PASS/FAIL
# lines and "overall: ..."; this script exits non-zero when any stage failed (it still runs the rest).
#
#   tables  the hand-written protocol / X11 ABI tables against wayland-scanner and the real headers
#   absent  the helper where libwayland (or a compositor) is missing: it must report, never crash
#   sway    wlroots: strokes over a window (screenshot), click-through (+ negative control), two outputs,
#           2x and 1.5x scale, and the real main-process controller driving the real helper
#   kwin    KDE: strokes over a FULLSCREEN window, click-through (+ negative control)
#   x11     plain X11 (Xvfb + openbox + picom/xcompmgr + xeyes + xdotool): the compositor probe/watch flips when picom is killed
#           and restarted, and window tracking (move, resize, minimize, desktop switch, exit) matches xwininfo
#   mutter  GNOME: no layer-shell -> the XWayland fallback: above fullscreen windows (also one opened
#           later), click-through (+ negative control), and the real controller picking that backend
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/../.." && pwd)"
WHAT="${1:-all}"
OUT="${2:-${CL_WAYLAND_OUT:-$HERE/output}}"
mkdir -p "$OUT"
docker image inspect cl-wayland-lab >/dev/null 2>&1 || docker build -q -t cl-wayland-lab "$HERE"
# The lab also runs the REAL main-process controller (electron/annotation-overlay-wayland.ts) against the
# REAL helper: bundle it with esbuild here and run it with this machine's node, mounted read-only.
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
( cd "$DESKTOP" && npx --no-install esbuild harness/wayland-annotation/lab/controller-e2e.ts --bundle --platform=node --target=node20 \
    --outfile="$OUT/controller-e2e.js" --log-level=warning ) || exit 1
# The X11 stage also drives the REAL Electron overlay (electron/annotation-overlay.ts, bundled here) with a real
# Electron binary: CL_ELECTRON_DIST=<dir containing `electron`> (default: apps/desktop/node_modules/electron/dist).
# Without one that part prints SKIP and the helper-level proof still runs.
ELECTRON_DIST="${CL_ELECTRON_DIST:-}"
[ -z "$ELECTRON_DIST" ] && [ -x "$DESKTOP/node_modules/electron/dist/electron" ] && ELECTRON_DIST="$DESKTOP/node_modules/electron/dist"
if [ "$WHAT" = x11 ] || [ "$WHAT" = all ]; then
  ( cd "$DESKTOP" \
    && npx --no-install esbuild harness/wayland-annotation/lab/x11-overlay-main.ts --bundle --platform=node --target=node22 \
         --external:electron --outfile="$OUT/x11e/main.js" --log-level=warning \
    && npx --no-install esbuild electron/annotation-overlay-preload.ts --bundle --platform=node --format=cjs \
         --external:electron --outfile="$OUT/x11e/annotation-overlay-preload.js" --log-level=warning ) || exit 1
fi
FAILED=()
run() { # script [extra docker args...]
  local script="$1"; shift
  docker run --rm "$@" -v "$NODE_DIR":/opt/node:ro -v "$DESKTOP":/d:ro -v "$OUT":/out cl-wayland-lab bash "/d/harness/wayland-annotation/$script" || FAILED+=("$script")
}
case "$WHAT" in
  tables) run check-protocol-tables.sh; run check-x11-abi.sh ;;
  absent) run lab/run-absent.sh ;;
  sway)   run lab/run-sway.sh; run lab/run-sway-outputs.sh ;;
  kwin)   run lab/run-kwin.sh --cap-add=SYS_NICE ;;
  mutter) run lab/run-mutter.sh ;;
  x11)    run lab/run-x11.sh; run lab/run-x11-electron.sh --shm-size=1g ${ELECTRON_DIST:+-v "$ELECTRON_DIST":/opt/electron:ro} ;;
  all)    run check-protocol-tables.sh; run check-x11-abi.sh; run lab/run-absent.sh; run lab/run-sway.sh; run lab/run-sway-outputs.sh
          run lab/run-kwin.sh --cap-add=SYS_NICE; run lab/run-mutter.sh
          run lab/run-x11.sh; run lab/run-x11-electron.sh --shm-size=1g ${ELECTRON_DIST:+-v "$ELECTRON_DIST":/opt/electron:ro} ;;
  *) echo "usage: $0 [tables|absent|sway|kwin|mutter|x11|all] [outdir]"; exit 2 ;;
esac
if [ ${#FAILED[@]} -gt 0 ]; then echo "FAILED stages: ${FAILED[*]}"; exit 1; fi
echo "all stages passed"
