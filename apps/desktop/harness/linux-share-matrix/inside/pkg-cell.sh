#!/usr/bin/env bash
# Launch / smoke check of the PACKAGED staging build (AppImage or .deb) inside a distro container, under Xvfb, on an
# --internal docker network (no route to production). The app's own smoke mode (CIPHERLINE_SMOKE_TEST=1 +
# --cipherline-smoke-test + --user-data-dir, electron/smoke-mode.ts) makes it write smoke-report.json after the first paint.
#   pkg-cell.sh appimage|deb
set -u
KIND=${1:?appimage|deb}
H=/h
source $H/inside/common.sh
mkdir -p "$OUT"; : > "$OUT/harness.log"; : > "$PIDS"
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$KIND"; fi
cleanup() { tac "$PIDS" | while read -r pid name; do kill -- "$pid" 2>/dev/null && log "killed $name pid=$pid"; done; sleep 1; tac "$PIDS" | while read -r pid name; do kill -9 -- "$pid" 2>/dev/null; done; }
trap cleanup EXIT

W=/tmp/pkg; rm -rf $W; mkdir -p $W && cd $W
case $KIND in
  appimage)
    cp /pkg/Cipherline-*.AppImage $W/app.AppImage && chmod +x $W/app.AppImage
    ( cd $W && ./app.AppImage --appimage-extract >/dev/null 2>"$OUT/extract.err" ) ; ROOT=$W/squashfs-root ;;
  deb)
    command -v dpkg-deb >/dev/null || { echo '{"skipped":"no dpkg-deb on this distro"}' > "$OUT/pkg-deb.json"; exit 0; }
    dpkg-deb -x /pkg/cipherline_*_amd64.deb $W/root; ROOT=$W/root/opt/Cipherline
    [ -d "$ROOT" ] || ROOT=$(dirname "$(find $W/root -maxdepth 4 -name 'chrome-sandbox' | head -1)") ;;
esac
BIN=$(find "$ROOT" -maxdepth 2 -type f -perm -u+x \( -iname 'cipherline' -o -name 'AppRun' \) | head -1)
ADDON=$(find "$ROOT" -name audio_capture.node | head -1)
R=$OUT/pkg-$KIND.json
j() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
{
  echo "{"
  echo "\"kind\":\"$KIND\",\"root\":$(j "$ROOT"),\"bin\":$(j "${BIN:-}"),\"addon\":$(j "${ADDON:-}"),"
  echo "\"electronVersion\":$(j "$(cat $(dirname "$(find "$ROOT" -maxdepth 3 -name version | head -1)")/version 2>/dev/null)"),"
  if [ -n "${ADDON:-}" ]; then
    echo "\"addonGlibcMax\":$(j "$(grep -ao 'GLIBC_[0-9.]*' "$ADDON" | sort -u -V | tail -1)"),"
    echo "\"addonGlibcxxMax\":$(j "$(grep -ao 'GLIBCXX_[0-9.]*' "$ADDON" | sort -u -V | tail -1)"),"
    echo "\"addonLddMissing\":$(j "$(ldd "$ADDON" 2>&1 | grep 'not found' | tr -s ' \n' ' ')"),"
  fi
  echo "\"distroGlibc\":$(j "$(ldd --version 2>&1 | head -1)")"
  echo "}"
} > $R.static

# a bare X server; the smoke report only needs a first paint, not a compositor
Xvfb :99 -screen 0 1280x720x24 +extension GLX -nolisten tcp >"$OUT/xvfb.log" 2>&1 & track $! Xvfb
export DISPLAY=:99 XDG_SESSION_TYPE=x11
wait_for 10 Xvfb x_ready
start_audio
if [ -n "${ADDON:-}" ]; then
  node -e "const a=require('$ADDON');console.log('loaded; exports='+Object.keys(a).length+' isSupported(with PipeWire up)='+a.isSupported())" > $W/addon-plain-node.txt 2>&1
fi

UD=$W/userdata; mkdir -p $UD
log "launching packaged app: $BIN"
CIPHERLINE_SMOKE_TEST=1 timeout -k 5 90 "$BIN" --no-sandbox --cipherline-smoke-test --user-data-dir=$UD >"$OUT/pkg-$KIND.stdout" 2>&1 &
P=$!; track $P packaged-app
for i in $(seq 1 85); do [ -f "$UD/smoke-report.json" ] && break; kill -0 $P 2>/dev/null || break; sleep 1; done
sleep 1
REPORT=$(cat "$UD/smoke-report.json" 2>/dev/null || echo null)
python3 - "$R.static" "$OUT/pkg-$KIND.stdout" "$REPORT" > "$R" <<'PY'
import json, sys, re
static = json.load(open(sys.argv[1]))
out = open(sys.argv[2], errors='replace').read()
try: report = json.loads(sys.argv[3])
except Exception: report = None
static['smokeReport'] = report
static['addonPlainNodeLoad'] = open('/tmp/pkg/addon-plain-node.txt', errors='replace').read().strip()[:300] if __import__('os').path.exists('/tmp/pkg/addon-plain-node.txt') else None
static['addonLoadedInApp'] = ('Native audio capture addon loaded successfully' in out)
static['addonNotLoadedLine'] = next((l for l in out.splitlines() if 'addon NOT loaded' in l or 'Reason:' in l), None)
static['stdoutTail'] = out.splitlines()[-25:]
print(json.dumps(static, indent=1))
PY
kill $P 2>/dev/null
log "pkg-cell $KIND done"
