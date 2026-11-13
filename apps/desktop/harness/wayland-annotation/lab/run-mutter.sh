#!/usr/bin/env bash
# Inside the lab image: headless Mutter 48 (GNOME's compositor: `mutter --headless --wayland
# --virtual-monitor 1920x1080`), which has NO wlr-layer-shell. Proves:
#   1. the helper reports `layer_shell=0` there, and (XWayland running) `x11=1`;
#   2. the XWayland fallback (SHOWX: X11 override-redirect ARGB window, empty XShape input region):
#      strokes are drawn ABOVE a fullscreen Wayland window and above a fullscreen window opened AFTER
#      the overlay, and a real pointer click falls through to the window below (negative control: the
#      same helper built without the empty input shape swallows it).
# Screenshots: org.gnome.Mutter.ScreenCast -> PipeWire -> gstreamer (what a GNOME screen share sees);
# input: org.gnome.Mutter.RemoteDesktop (lab/mutter-ctl.py). Writes PNGs/logs to /out.
set -u
declare -A GOT
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$@"; fi
OUT=${OUT:-/out}; mkdir -p "$OUT"
L=/d/harness/wayland-annotation/lab
SRC=/d/src-native/wayland_overlay
export LC_ALL=C.UTF-8
export XDG_RUNTIME_DIR=/tmp/xdg-mut; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
gcc -std=gnu11 -Wall -O2 -o /tmp/cl-wayland-overlay $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
gcc -std=gnu11 -Wall -O2 -DCL_TEST_NEG_CONTROL=1 -o /tmp/cl-wayland-overlay-negctl $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1

mkdir -p /tmp/.X11-unix; chmod 1777 /tmp/.X11-unix   # Mutter refuses to start XWayland without it
pipewire > $OUT/mutter-pipewire.log 2>&1 &
sleep 1
wireplumber >> $OUT/mutter-pipewire.log 2>&1 &
sleep 2
mutter --headless --wayland --virtual-monitor 1920x1080 --wayland-display wayland-mut > $OUT/mutter.log 2>&1 &
sleep 5
export WAYLAND_DISPLAY=wayland-mut
echo "mutter $(mutter --version | head -1): layer-shell advertised: $(wayland-info 2>/dev/null | grep -c zwlr_layer_shell_v1)"
# what a GNOME session exports to every app
export DISPLAY=$(ls /tmp/.X11-unix/ | head -1 | sed 's/^X/:/')
export XAUTHORITY=$(ls $XDG_RUNTIME_DIR/.mutter-Xwaylandauth.* | head -1)
echo "DISPLAY=$DISPLAY"

rm -f /tmp/mc.fifo; mkfifo /tmp/mc.fifo
setsid bash -c "tail -f /tmp/mc.fifo | python3 $L/mutter-ctl.py > /tmp/mc.out 2>&1" < /dev/null > /dev/null 2>&1 &
sleep 5; cat /tmp/mc.out
shot () {   # $1=out.png
  n=$(grep -c '^shot' /tmp/mc.out)
  echo "shot $1" > /tmp/mc.fifo
  for i in $(seq 60); do [ "$(grep -c '^shot' /tmp/mc.out)" -gt "$n" ] && break; sleep 0.5; done
  tail -1 /tmp/mc.out
}
click_centre () {
  for pos in "200 200" "940 540" "950 540" "960 540" "970 540"; do echo "move $pos" > /tmp/mc.fifo; sleep 0.4; done   # a far-away start: always a fresh pointer-enter
  echo press > /tmp/mc.fifo; sleep 0.3; echo release > /tmp/mc.fifo; sleep 0.8
}
export UNDERLAY_LOG=$OUT/mutter-underlay.log; : > $UNDERLAY_LOG
UL_FULLSCREEN=1 GDK_BACKEND=wayland setsid python3 $L/underlay.py < /dev/null > /dev/null 2>&1 &
for i in $(seq 50); do grep -q ready $UNDERLAY_LOG && break; sleep 0.2; done
sleep 2
shot $OUT/mutter-1-wayland-underlay-only.png

run_case () {   # $1=helper binary  $2=tag
  : > $UNDERLAY_LOG
  export DRIVE_LOG=$OUT/mutter-$2-drive.log; : > $DRIVE_LOG
  rm -f /tmp/drawn.flag; export DRIVE_FLAG=/tmp/drawn.flag
  python3 $L/drive.py $1 0 30 &
  DP=$!
  for i in $(seq 50); do [ -f /tmp/drawn.flag ] && break; sleep 0.2; done
  sleep 1
  shot $OUT/mutter-$2-overlay-over-fullscreen-wayland-window.png
  click_centre
  GOT[$2]=$(grep -E '^(press|release)' $UNDERLAY_LOG | tr '\n' ';')
  echo "[$2] underlay received: ${GOT[$2]}"
  if [ "$2" = shipped ]; then
    # a NEW fullscreen window opened after the overlay: is the overlay still above it?
    UL_FULLSCREEN=1 GDK_BACKEND=wayland UNDERLAY_LOG=/tmp/ul-late.log setsid python3 $L/underlay.py < /dev/null > /dev/null 2>&1 &
    sleep 4
    shot $OUT/mutter-$2-overlay-over-LATER-fullscreen-window.png
  fi
  kill $DP 2>/dev/null; wait $DP 2>/dev/null
  pkill -f cl-wayland-overlay; sleep 1
  echo "[$2] helper said:"; sed 's/^/    /' $DRIVE_LOG
}
run_case /tmp/cl-wayland-overlay shipped
pkill -f underlay.py; sleep 1
UL_FULLSCREEN=1 GDK_BACKEND=wayland setsid python3 $L/underlay.py < /dev/null > /dev/null 2>&1 &
sleep 4
run_case /tmp/cl-wayland-overlay-negctl negctl
shot $OUT/mutter-4-after-quit.png
echo "[after QUIT] a click now reaches the underlay again:"; GOT[after]=; for try in 1 2 3; do : > $UNDERLAY_LOG; click_centre; GOT[after]=$(grep -E '^(press|release)' $UNDERLAY_LOG | tr '\n' ';'); [ -n "${GOT[after]}" ] && break; sleep 1; done; echo "${GOT[after]}"
# -- the REAL main-process controller + the REAL helper, on GNOME (needs the host's node at /opt/node) --
RC=0
if [ -x /opt/node/bin/node ] && [ -f $OUT/controller-e2e.js ]; then
  echo "== controller e2e on Mutter: layer_shell=0 x11=1 -> the controller must pick the XWayland backend"
  rm -f /tmp/drawn.flag
  DISPLAYS_JSON='[{"id":1,"bounds":{"x":0,"y":0,"width":1920,"height":1080},"scaleFactor":1}]' FRAME_JSON='{"width":1920,"height":1080}' \
    HELPER=/tmp/cl-wayland-overlay HOLD_MS=14000 DRIVE_FLAG=/tmp/drawn.flag \
    /opt/node/bin/node $OUT/controller-e2e.js > $OUT/mutter-e2e.log 2>&1 &
  EP=$!
  for i in $(seq 40); do [ -f /tmp/drawn.flag ] && break; sleep 0.2; done
  sleep 1
  shot $OUT/mutter-e2e-overlay.png
  wait $EP; sed 's/^/    /' $OUT/mutter-e2e.log
  grep -q '"how":"wl-x11-only-display"' $OUT/mutter-e2e.log || { echo "FAIL e2e did not use the XWayland backend"; RC=1; }
  python3 $L/check-shot.py $OUT/mutter-e2e-overlay.png yes || RC=1
fi
echo quit > /tmp/mc.fifo
pkill -f underlay.py; pkill mutter
case "${GOT[shipped]}" in *press*) echo "PASS click-through: the click reached the window under the strokes";; *) echo "FAIL click-through"; RC=1;; esac
[ -z "${GOT[negctl]}" ] && echo "PASS negative control: without the empty input region/shape the click is swallowed (the test can fail)" || { echo "FAIL negative control: the click still arrived, so the click test proves nothing"; RC=1; }
case "${GOT[after]}" in *press*) echo "PASS after QUIT the surface is gone and clicks arrive again";; *) echo "FAIL after QUIT"; RC=1;; esac
for f in $OUT/mutter-shipped-overlay*.png; do python3 $L/check-shot.py "$f" yes || { echo "FAIL no stroke at the expected place in $f"; RC=1; }; done
echo "overall: $([ $RC = 0 ] && echo PASS || echo FAIL)"
exit $RC
