#!/usr/bin/env bash
# Inside the lab image: WHICH output, and HiDPI. Headless Sway with TWO outputs of different size
# (1920x1080 at 0,0 and 1280x720 at 1920,0), then the first one rescaled (2x, 1.5x):
#   - the helper's OUT lines must carry each output's logical rectangle, scale and physical mode;
#   - `SHOW 1` must put the strokes on the SECOND output only (grim per output, pixel-measured);
#   - on a 2x and a 1.5x output the strokes must still span the same fractions of the output.
# Writes PNGs/logs to /out.
set -u
OUT=${OUT:-/out}; mkdir -p "$OUT"
L=/d/harness/wayland-annotation/lab
SRC=/d/src-native/wayland_overlay
export XDG_RUNTIME_DIR=/tmp/xdg-sway2; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman
cat > /tmp/sway2.conf <<CFG
default_border none
output HEADLESS-1 resolution 1920x1080 position 0 0
CFG
gcc -std=gnu11 -Wall -O2 -o /tmp/cl-wayland-overlay $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
sway -c /tmp/sway2.conf > $OUT/sway-outputs.log 2>&1 &
for i in $(seq 50); do ls $XDG_RUNTIME_DIR/wayland-[0-9] >/dev/null 2>&1 && break; sleep 0.2; done
export WAYLAND_DISPLAY=$(basename "$(ls $XDG_RUNTIME_DIR/wayland-[0-9] | head -1)")
export SWAYSOCK=$(ls $XDG_RUNTIME_DIR/sway-ipc.*.sock | head -1)
swaymsg create_output >/dev/null; sleep 0.5
swaymsg output HEADLESS-2 mode 1280x720 position 1920 0 >/dev/null; sleep 0.5
echo "outputs: $(swaymsg -t get_outputs | python3 -c 'import json,sys;print([(o["name"],o["rect"]["x"],o["rect"]["y"],o["rect"]["width"],o["rect"]["height"],o["scale"]) for o in json.load(sys.stdin)])')"
GDK_BACKEND=wayland python3 $L/underlay.py > /dev/null 2>&1 &
sleep 2

draw_on () {   # $1=output idx  $2=tag  : strokes for 5 s on that output index, shots of both outputs
  export DRIVE_LOG=$OUT/sway-$2-drive.log; : > $DRIVE_LOG
  rm -f /tmp/drawn.flag; export DRIVE_FLAG=/tmp/drawn.flag
  python3 $L/drive.py /tmp/cl-wayland-overlay $1 5 &
  DP=$!
  for i in $(seq 50); do [ -f /tmp/drawn.flag ] && break; sleep 0.2; done
  sleep 0.8
  grim -o HEADLESS-1 $OUT/sway-$2-out1.png; grim -o HEADLESS-2 $OUT/sway-$2-out2.png
  wait $DP
  grep -E "OUT |SHOWN" $DRIVE_LOG | sed 's/^/    /'
}
RC=0
echo "== 2 outputs: SHOW 1 (the 1280x720 one on the right)"
draw_on 1 two-outputs
python3 $L/check-shot.py $OUT/sway-two-outputs-out2.png yes || RC=1
python3 $L/check-shot.py $OUT/sway-two-outputs-out1.png no || { echo "  -> stroke leaked onto output 1"; RC=1; }
echo "== 2 outputs: SHOW 0"
draw_on 0 two-outputs-0
python3 $L/check-shot.py $OUT/sway-two-outputs-0-out1.png yes || RC=1
python3 $L/check-shot.py $OUT/sway-two-outputs-0-out2.png no || { echo "  -> stroke leaked onto output 2"; RC=1; }

for sc in 2 1.5; do
  echo "== output 1 at scale $sc"
  swaymsg output HEADLESS-1 scale $sc >/dev/null; sleep 1
  draw_on 0 scale-$sc
  python3 $L/check-shot.py $OUT/sway-scale-$sc-out1.png yes || RC=1
done

# ── the REAL main-process controller + the REAL helper (needs the host's node at /opt/node) ──
if [ -x /opt/node/bin/node ] && [ -f $OUT/controller-e2e.js ]; then
  swaymsg output HEADLESS-1 scale 1 >/dev/null; sleep 1
  D1='{"id":1,"bounds":{"x":0,"y":0,"width":1920,"height":1080},"scaleFactor":1}'
  e2e () {   # $1=displays json  $2=frame json  $3=tag
    rm -f /tmp/drawn.flag
    DISPLAYS_JSON="[$1]" FRAME_JSON="$2" HELPER=/tmp/cl-wayland-overlay HOLD_MS=4000 DRIVE_FLAG=/tmp/drawn.flag \
      /opt/node/bin/node $OUT/controller-e2e.js > $OUT/sway-e2e-$3.log 2>&1 &
    EP=$!
    for i in $(seq 40); do [ -f /tmp/drawn.flag ] && break; sleep 0.2; done
    sleep 0.8
    grim -o HEADLESS-1 $OUT/sway-e2e-$3-out1.png; grim -o HEADLESS-2 $OUT/sway-e2e-$3-out2.png
    wait $EP; sed 's/^/    /' $OUT/sway-e2e-$3.log
  }
  D2='{"id":2,"bounds":{"x":1920,"y":0,"width":1280,"height":720},"scaleFactor":1}'
  echo "== controller e2e: frame 1280x720 -> the right-hand output"
  e2e "$D1,$D2" '{"width":1280,"height":720}' right
  python3 $L/check-shot.py $OUT/sway-e2e-right-out2.png yes || RC=1
  python3 $L/check-shot.py $OUT/sway-e2e-right-out1.png no || { echo "  -> leaked onto output 1"; RC=1; }
  echo "== controller e2e: frame 1920x1080 -> the left-hand output"
  e2e "$D1,$D2" '{"width":1920,"height":1080}' left
  python3 $L/check-shot.py $OUT/sway-e2e-left-out1.png yes || RC=1
  python3 $L/check-shot.py $OUT/sway-e2e-left-out2.png no || { echo "  -> leaked onto output 2"; RC=1; }
  echo "== controller e2e: a 640x480 share is not a whole screen -> refused, nothing drawn"
  e2e "$D1,$D2" '{"width":640,"height":480}' notscreen
  grep -q '"reason":"not_whole_screen"' $OUT/sway-e2e-notscreen.log || { echo "  -> expected not_whole_screen"; RC=1; }
  python3 $L/check-shot.py $OUT/sway-e2e-notscreen-out1.png no || RC=1
  echo "== controller e2e: two IDENTICAL 1920x1080 outputs -> ambiguous -> refused, nothing drawn"
  swaymsg output HEADLESS-2 mode 1920x1080 position 1920 0 >/dev/null; sleep 1
  D2B='{"id":2,"bounds":{"x":1920,"y":0,"width":1920,"height":1080},"scaleFactor":1}'
  e2e "$D1,$D2B" '{"width":1920,"height":1080}' ambiguous
  grep -q '"reason":"no_display_match"' $OUT/sway-e2e-ambiguous.log || { echo "  -> expected no_display_match"; RC=1; }
  python3 $L/check-shot.py $OUT/sway-e2e-ambiguous-out1.png no || RC=1
  python3 $L/check-shot.py $OUT/sway-e2e-ambiguous-out2.png no || RC=1
else
  echo "(controller e2e skipped: no /opt/node or no bundle)"
fi
echo "overall: $([ $RC = 0 ] && echo PASS || echo FAIL)"
pkill -f underlay.py; swaymsg exit >/dev/null 2>&1
exit $RC
