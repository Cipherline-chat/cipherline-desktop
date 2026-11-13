#!/usr/bin/env bash
# Inside the lab image: the helper's plain-X11 modes (src-native/wayland_overlay/x11_probe.inc) against a
# REAL X server (Xvfb) with a real window manager (openbox), real compositing managers (picom, xcompmgr)
# and real client windows (xeyes), driven by xdotool. Proves the two things the X11 annotation overlay
# needs from X (electron/annotation-overlay-x11.ts):
#   1. COMPOSITOR: `--x11-probe` says CM 0 under bare Xvfb and under openbox alone, CM 1 once picom (or
#      xcompmgr) runs; `--x11-watch` flips CM 1 -> CM 0 within ~1 s when picom is killed and back when
#      it is restarted — mid-run, no restart of the helper.
#   2. WINDOW: for a real window, `W ok x y w h` equals what xwininfo (an independent client of the same
#      X server) reports, follows xdotool moves and resizes, goes unmapped/minimized when iconified,
#      hidden when the desktop changes, back to ok when restored, `gone` when the client exits —
#      with a nonexistent id as the negative control (`gone` at once, never a rectangle).
# Writes logs to /out.
set -u
OUT=${OUT:-/out}; mkdir -p "$OUT"
SRC=/d/src-native/wayland_overlay
H=/tmp/cl-wayland-overlay
gcc -std=gnu11 -Wall -O2 -o $H $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
RC=0
pass () { echo "PASS $1"; }
fail () { echo "FAIL $1"; RC=1; }
check () { # label, expected, got
  if [ "$2" = "$3" ]; then pass "$1: '$3'"; else fail "$1: wanted '$2', got '$3'"; fi
}

export DISPLAY=:97
Xvfb $DISPLAY -screen 0 1280x800x24 +extension Composite +extension RENDER +extension DAMAGE > $OUT/x11-xvfb.log 2>&1 &
for i in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
xdpyinfo >/dev/null 2>&1 || { echo "FAIL Xvfb did not start"; exit 1; }

probe () { env -i DISPLAY=$DISPLAY timeout 5 $H --x11-probe 2>&1 | grep '^CM ' ; }

# ── 1. compositor ────────────────────────────────────────────────────────────
check "bare Xvfb (no WM, no compositor)" "CM 0" "$(probe)"
openbox > $OUT/x11-openbox.log 2>&1 &
sleep 1
check "openbox alone (a window manager is NOT a compositing manager)" "CM 0" "$(probe)"
picom --backend xrender --no-vsync > $OUT/x11-picom.log 2>&1 &
PICOM=$!
sleep 2
check "picom running" "CM 1" "$(probe)"
kill $PICOM; wait $PICOM 2>/dev/null; sleep 1
check "picom killed" "CM 0" "$(probe)"
xcompmgr > $OUT/x11-xcompmgr.log 2>&1 &
XCM=$!
sleep 2
check "xcompmgr running (a second, different compositor)" "CM 1" "$(probe)"
kill $XCM; wait $XCM 2>/dev/null; sleep 1

# long-lived watcher: stdin is a FIFO we keep open, stdout a log we poll
rm -f /tmp/w.in /tmp/w.out; mkfifo /tmp/w.in; : > /tmp/w.out
exec 3<>/tmp/w.in
env -i DISPLAY=$DISPLAY $H --x11-watch <&3 > /tmp/w.out 2>/dev/null &
WATCH=$!
ms () { date +%s%3N; }
lines () { wc -l < /tmp/w.out; }
# wait_line <pattern> <from-line> <timeout-ms>: prints elapsed ms, or TIMEOUT
wait_line () {
  local pat="$1" from="$2" limit="$3" t0; t0=$(ms)
  while [ $(( $(ms) - t0 )) -lt "$limit" ]; do
    if tail -n +$((from + 1)) /tmp/w.out | grep -qE "$pat"; then echo $(( $(ms) - t0 )); return; fi
    sleep 0.02
  done
  echo TIMEOUT
}
sleep 0.5
check "watcher's first answer with no compositor" "CM 0" "$(grep '^CM ' /tmp/w.out | head -1)"
n=$(lines); picom --backend xrender --no-vsync > $OUT/x11-picom2.log 2>&1 & PICOM=$!
t=$(wait_line '^CM 1$' $n 4000)
if [ "$t" = TIMEOUT ]; then fail "watcher did not report the compositor appearing"; else pass "watcher: compositor appeared -> CM 1 after ${t} ms"; fi
n=$(lines); kill $PICOM; wait $PICOM 2>/dev/null
t=$(wait_line '^CM 0$' $n 4000)
if [ "$t" = TIMEOUT ]; then fail "watcher did not report the compositor going away"; else
  if [ "$t" -le 1500 ]; then pass "watcher: picom killed mid-run -> CM 0 after ${t} ms (<= 1500)"; else fail "CM 0 took ${t} ms"; fi
fi
n=$(lines); picom --backend xrender --no-vsync > $OUT/x11-picom3.log 2>&1 & PICOM=$!
t=$(wait_line '^CM 1$' $n 4000)
if [ "$t" = TIMEOUT ]; then fail "watcher did not report the compositor returning"; else pass "watcher: picom restarted -> CM 1 after ${t} ms"; fi
check "CM lines were changes only (no repeats): sequence" "CM 0 CM 1 CM 0 CM 1" "$(grep '^CM ' /tmp/w.out | tr '\n' ' ' | sed 's/ $//')"

# ── 2. window ────────────────────────────────────────────────────────────────
xeyes -geometry 300x200+100+100 > /dev/null 2>&1 &
EYES=$!
for i in $(seq 50); do XID=$(xdotool search --onlyvisible --class xeyes 2>/dev/null | head -1); [ -n "$XID" ] && break; sleep 0.1; done
[ -n "${XID:-}" ] || { fail "xeyes window not found"; exit 1; }
echo "xeyes window id $XID"
truth () { # absolute client-area rectangle by an independent client (xwininfo)
  xwininfo -id "$XID" 2>/dev/null | awk '/Absolute upper-left X/{x=$4} /Absolute upper-left Y/{y=$4} /Width:/{w=$2} /Height:/{h=$2} END{print x, y, w, h}'
}
last_w () { grep '^W ' /tmp/w.out | tail -1; }
settle () { sleep 0.4; }
n=$(lines); echo "WIN $XID" >&3
t=$(wait_line '^W ok ' $n 2000)
[ "$t" = TIMEOUT ] && fail "no W line after WIN" || pass "window reported ${t} ms after WIN"
check "window rectangle == xwininfo's" "W ok $(truth)" "$(last_w)"

xdotool windowmove "$XID" 420 260; settle
check "after xdotool windowmove: follows the move" "W ok $(truth)" "$(last_w)"
case "$(last_w)" in "W ok 420 260 "*|"W ok 4"*) : ;; esac
xdotool windowsize "$XID" 500 350; settle
check "after xdotool windowsize: follows the resize" "W ok $(truth)" "$(last_w)"
echo "  (rectangle now: $(last_w))"

n=$(lines); xdotool windowminimize "$XID"
t=$(wait_line '^W (unmapped|minimized) ' $n 2000)
[ "$t" = TIMEOUT ] && fail "minimize not reported (last: $(last_w))" || pass "minimize -> '$(last_w)' after ${t} ms"
n=$(lines); xdotool windowmap "$XID"; xdotool windowactivate "$XID" 2>/dev/null
t=$(wait_line '^W ok ' $n 3000)
[ "$t" = TIMEOUT ] && fail "restore not reported (last: $(last_w))" || pass "restore -> '$(last_w)' after ${t} ms"

n=$(lines); xdotool set_desktop 1
t=$(wait_line '^W (workspace|unmapped|minimized) ' $n 3000)
[ "$t" = TIMEOUT ] && fail "other workspace not reported (last: $(last_w); desktops: $(xdotool get_num_desktops))" || pass "switch to another desktop -> '$(last_w)' after ${t} ms"
n=$(lines); xdotool set_desktop 0
t=$(wait_line '^W ok ' $n 3000)
[ "$t" = TIMEOUT ] && fail "back on the desktop not reported (last: $(last_w))" || pass "back on the window's desktop -> '$(last_w)' after ${t} ms"

n=$(lines); kill $EYES; wait $EYES 2>/dev/null
t=$(wait_line '^W gone ' $n 3000)
[ "$t" = TIMEOUT ] && fail "window exit not reported (last: $(last_w))" || pass "client exited -> '$(last_w)' after ${t} ms"

# negative control: an id that never existed must be 'gone', never a rectangle
n=$(lines); echo "WIN 16777000" >&3
t=$(wait_line '^W ' $n 2000)
check "nonexistent window id" "W gone 0 0 0 0" "$(last_w)"
n=$(lines); echo "WIN notanumber" >&3; echo "FOO" >&3
t=$(wait_line '^ERR bad_command' $n 2000)
[ "$t" = TIMEOUT ] && fail "malformed commands were not rejected" || pass "malformed WIN / unknown command -> ERR bad_command"

echo QUIT >&3; sleep 0.5
if kill -0 $WATCH 2>/dev/null; then fail "helper did not exit on QUIT"; else pass "helper exits on QUIT"; fi
cp /tmp/w.out $OUT/x11-watch.out
echo "overall: $([ $RC = 0 ] && echo PASS || echo FAIL)"
exit $RC
