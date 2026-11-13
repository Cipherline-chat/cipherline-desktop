#!/usr/bin/env bash
# Inside the lab image (needs --cap-add=SYS_NICE: kwin_wayland carries a file capability): KWin 6.3
# running as a Wayland compositor NESTED in a virtual X server (`kwin_wayland --x11-display :99` on
# Xvfb) + GTK underlay (fullscreen, so this also shows the overlay ABOVE a fullscreen window) + the
# REAL helper + a real click through KWin (org_kde_kwin_fake_input).
#
# Why nested and not `--virtual`: the virtual backend composites with QPainter only, where KWin's
# ScreenShot2 effect is unsupported and no screencast interface is offered, so there is nothing to
# take a picture with. Nested in Xvfb the compositor's output IS an X window, and `import -window
# root` photographs exactly what KWin composited (overlay layer included). Writes PNGs/logs to /out.
set -u
declare -A GOT
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$@"; fi
OUT=${OUT:-/out}; mkdir -p "$OUT"
L=/d/harness/wayland-annotation/lab
SRC=/d/src-native/wayland_overlay
export LC_ALL=C.UTF-8
export XDG_RUNTIME_DIR=/tmp/xdg-kwin; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
gcc -std=gnu11 -Wall -O2 -o /tmp/cl-wayland-overlay $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
gcc -std=gnu11 -Wall -O2 -DCL_TEST_NEG_CONTROL=1 -o /tmp/cl-wayland-overlay-negctl $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
mkdir -p /tmp/kf && cd /tmp/kf
wayland-scanner client-header /usr/share/plasma-wayland-protocols/fake-input.xml fake-input-client.h
wayland-scanner private-code /usr/share/plasma-wayland-protocols/fake-input.xml fake-input.c
gcc -o kfake $L/kfake.c fake-input.c -I. -lwayland-client || exit 1

Xvfb :99 -screen 0 1920x1080x24 > $OUT/kwin-xvfb.log 2>&1 &
sleep 1
export KWIN_WAYLAND_NO_PERMISSION_CHECKS=1
kwin_wayland --x11-display :99 --width 1920 --height 1080 --socket wayland-kde --no-lockscreen --no-global-shortcuts > $OUT/kwin.log 2>&1 &
for i in $(seq 50); do [ -S $XDG_RUNTIME_DIR/wayland-kde ] && break; sleep 0.2; done
sleep 3
export WAYLAND_DISPLAY=wayland-kde
echo "$(kwin_wayland --version 2>/dev/null): layer-shell advertised: $(wayland-info 2>/dev/null | grep -c zwlr_layer_shell_v1)"
mkfifo /tmp/kf/fifo; (tail -f /tmp/kf/fifo | ./kfake > /tmp/kf/out.log 2>&1 &)
sleep 1; cat /tmp/kf/out.log
shot () { DISPLAY=:99 import -window root "$1" && echo "shot $1"; }
export UNDERLAY_LOG=$OUT/kwin-underlay.log; : > $UNDERLAY_LOG
UL_FULLSCREEN=1 GDK_BACKEND=wayland python3 $L/underlay.py 2>/dev/null &
for i in $(seq 50); do grep -q ready $UNDERLAY_LOG && break; sleep 0.2; done
sleep 2
shot $OUT/kwin-1-underlay-only.png

click_centre () {
  for pos in "200 200" "940 540" "950 540" "960 540" "970 540"; do echo "move $pos" > /tmp/kf/fifo; sleep 0.3; done   # a far-away start: always a fresh pointer-enter
  echo press > /tmp/kf/fifo; sleep 0.15; echo release > /tmp/kf/fifo; sleep 0.4
}
run_case () {   # $1=helper binary  $2=tag
  : > $UNDERLAY_LOG
  export DRIVE_LOG=$OUT/kwin-$2-drive.log; : > $DRIVE_LOG
  rm -f /tmp/drawn.flag; export DRIVE_FLAG=/tmp/drawn.flag
  python3 $L/drive.py $1 0 8 &
  DP=$!
  for i in $(seq 50); do [ -f /tmp/drawn.flag ] && break; sleep 0.2; done
  sleep 0.8
  shot $OUT/kwin-$2-overlay.png
  click_centre
  GOT[$2]=$(grep -E '^(press|release)' $UNDERLAY_LOG | tr '\n' ';')
  echo "[$2] underlay received: ${GOT[$2]}"
  wait $DP
  echo "[$2] helper said:"; sed 's/^/    /' $DRIVE_LOG
}
run_case /tmp/cl-wayland-overlay shipped
run_case /tmp/cl-wayland-overlay-negctl negctl
sleep 1
shot $OUT/kwin-4-after-quit.png
echo "[after QUIT] a click now reaches the underlay again:"; GOT[after]=; for try in 1 2 3; do : > $UNDERLAY_LOG; click_centre; GOT[after]=$(grep -E '^(press|release)' $UNDERLAY_LOG | tr '\n' ';'); [ -n "${GOT[after]}" ] && break; sleep 1; done; echo "${GOT[after]}"
pkill -f underlay.py; pkill kwin_wayland; pkill Xvfb
RC=0
case "${GOT[shipped]}" in *press*) echo "PASS click-through: the click reached the window under the strokes";; *) echo "FAIL click-through"; RC=1;; esac
[ -z "${GOT[negctl]}" ] && echo "PASS negative control: without the empty input region/shape the click is swallowed (the test can fail)" || { echo "FAIL negative control: the click still arrived, so the click test proves nothing"; RC=1; }
case "${GOT[after]}" in *press*) echo "PASS after QUIT the surface is gone and clicks arrive again";; *) echo "FAIL after QUIT"; RC=1;; esac
for f in $OUT/kwin-shipped-overlay*.png; do python3 $L/check-shot.py "$f" yes || { echo "FAIL no stroke at the expected place in $f"; RC=1; }; done
echo "overall: $([ $RC = 0 ] && echo PASS || echo FAIL)"
exit $RC
