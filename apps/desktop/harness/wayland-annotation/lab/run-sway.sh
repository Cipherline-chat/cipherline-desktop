#!/usr/bin/env bash
# Inside the lab image: headless Sway + GTK underlay + the REAL helper + grim screenshots + a real
# pointer click through the compositor's seat. Writes PNGs/logs to /out.
#   docker run --rm -v "$PWD/apps/desktop:/d:ro" -v "$OUT:/out" cl-wayland-lab bash /d/harness/wayland-annotation/lab/run-sway.sh
set -u
declare -A GOT
OUT=${OUT:-/out}; mkdir -p "$OUT"
L=/d/harness/wayland-annotation/lab
SRC=/d/src-native/wayland_overlay
export XDG_RUNTIME_DIR=/tmp/xdg-sway; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman
cat > /tmp/sway.conf <<CFG
default_border none
output HEADLESS-1 resolution 1920x1080 position 0 0
CFG
gcc -std=gnu11 -Wall -O2 -o /tmp/cl-wayland-overlay $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
# Negative control: the same helper compiled WITHOUT its empty input region. The click test must
# FAIL for this one, or it proves nothing.
gcc -std=gnu11 -Wall -O2 -DCL_TEST_NEG_CONTROL=1 -o /tmp/cl-wayland-overlay-negctl $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
# persistent virtual pointer (wlrctl makes one per invocation, so the seat never has a pointer)
mkdir -p /tmp/vp && cd /tmp/vp
wayland-scanner client-header $L/wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1-client.h
wayland-scanner private-code $L/wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1.c
gcc -o vptr $L/vptr.c wlr-virtual-pointer-unstable-v1.c -I. -lwayland-client || exit 1

sway -c /tmp/sway.conf > $OUT/sway.log 2>&1 &
for i in $(seq 50); do ls $XDG_RUNTIME_DIR/wayland-[0-9] >/dev/null 2>&1 && break; sleep 0.2; done
export WAYLAND_DISPLAY=$(basename "$(ls $XDG_RUNTIME_DIR/wayland-[0-9] | head -1)")
export SWAYSOCK=$(ls $XDG_RUNTIME_DIR/sway-ipc.*.sock | head -1)
echo "$(sway --version): $WAYLAND_DISPLAY outputs: $(swaymsg -t get_outputs | python3 -c 'import json,sys;print([(o["name"],o["current_mode"]["width"],o["current_mode"]["height"]) for o in json.load(sys.stdin)])')"
mkfifo /tmp/vp/fifo; (tail -f /tmp/vp/fifo | ./vptr 1920 1080 > /tmp/vp/out.log 2>&1 &)
sleep 1
export UNDERLAY_LOG=$OUT/sway-underlay.log; : > $UNDERLAY_LOG
GDK_BACKEND=wayland python3 $L/underlay.py &
for i in $(seq 50); do grep -q ready $UNDERLAY_LOG && break; sleep 0.2; done
sleep 1
grim $OUT/sway-1-underlay-only.png

click_centre () {
  for pos in "200 200" "940 540" "950 540" "960 540" "970 540"; do echo "move $pos" > /tmp/vp/fifo; sleep 0.3; done   # a far-away start: always a fresh pointer-enter   # enter first
  echo press > /tmp/vp/fifo; sleep 0.15; echo release > /tmp/vp/fifo; sleep 0.4
}
run_case () {   # $1=helper binary  $2=tag
  : > $UNDERLAY_LOG
  export DRIVE_LOG=$OUT/sway-$2-drive.log; : > $DRIVE_LOG
  rm -f /tmp/drawn.flag; export DRIVE_FLAG=/tmp/drawn.flag
  python3 $L/drive.py $1 0 6 &
  DP=$!
  for i in $(seq 50); do [ -f /tmp/drawn.flag ] && break; sleep 0.2; done
  sleep 0.6
  grim $OUT/sway-$2-overlay.png
  click_centre   # (960,540): under BOTH strokes
  GOT[$2]=$(grep -E '^(press|release)' $UNDERLAY_LOG | tr '\n' ';')
  echo "[$2] underlay received: ${GOT[$2]}"
  wait $DP
  echo "[$2] helper said:"; sed 's/^/    /' $DRIVE_LOG
}
run_case /tmp/cl-wayland-overlay shipped
run_case /tmp/cl-wayland-overlay-negctl negctl
sleep 1
grim $OUT/sway-4-after-quit.png
echo "[after QUIT] a click now reaches the underlay again:"; GOT[after]=; for try in 1 2 3; do : > $UNDERLAY_LOG; click_centre; GOT[after]=$(grep -E '^(press|release)' $UNDERLAY_LOG | tr '\n' ';'); [ -n "${GOT[after]}" ] && break; sleep 1; done; echo "${GOT[after]}"
pkill -f underlay.py; swaymsg exit >/dev/null 2>&1
RC=0
case "${GOT[shipped]}" in *press*) echo "PASS click-through: the click reached the window under the strokes";; *) echo "FAIL click-through"; RC=1;; esac
[ -z "${GOT[negctl]}" ] && echo "PASS negative control: without the empty input region the click is swallowed (the test can fail)" || { echo "FAIL negative control: the click still arrived, so the click test proves nothing"; RC=1; }
case "${GOT[after]}" in *press*) echo "PASS after QUIT the surface is gone and clicks arrive again";; *) echo "FAIL after QUIT"; RC=1;; esac
for f in $OUT/sway-shipped-overlay*.png; do python3 $L/check-shot.py "$f" yes || { echo "FAIL no stroke at the expected place in $f"; RC=1; }; done
echo "overall: $([ $RC = 0 ] && echo PASS || echo FAIL)"
exit $RC
