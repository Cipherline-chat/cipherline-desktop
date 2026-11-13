#!/usr/bin/env bash
# Inside the lab image, with the REAL Electron binary mounted at /opt/electron (run.sh x11 does that when it
# can find one): the real X11 annotation overlay (electron/annotation-overlay.ts, bundled by run.sh) in a real
# Xvfb + openbox + picom session, screenshots taken from Xvfb's own framebuffer (what a share would see).
#   A. no compositor: the overlay is refused (the root window stays blue). Negative control: forced on with
#      CIPHERLINE_ANNOT_OVERLAY=1 the same session shows a black window over the screen.
#   B. SCREEN share with picom: strokes land on the whole screen; picom killed mid-share -> overlay taken
#      down (ENDED no_compositor, strokes gone); picom restarted -> shown again.
#   C. WINDOW share (a real xeyes window): the strokes' bounding box matches the window's frame (xwininfo), follows
#      xdotool moves and resizes, disappears while the window is minimized or on another desktop, comes back,
#      goes away with picom, and the overlay closes when the window exits. desktopCapturer's own thumbnail of the
#      window has the aspect ratio of the CLIENT area (what the rectangle is measured as), id form window:<XID>:0.
set -u
OUT=${OUT:-/out}; mkdir -p "$OUT"
L=/d/harness/wayland-annotation/lab
SRC=/d/src-native/wayland_overlay
RC=0
pass () { echo "PASS $1"; }
fail () { echo "FAIL $1"; RC=1; }
gcc -std=gnu11 -Wall -O2 -o /tmp/cl-wayland-overlay $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
[ -x /opt/electron/electron ] || { echo "SKIP no electron binary mounted at /opt/electron"; exit 0; }

export DISPLAY=:96 HOME=/tmp/elhome XDG_SESSION_TYPE=x11
mkdir -p $HOME /tmp/fb
unset WAYLAND_DISPLAY
Xvfb $DISPLAY -screen 0 1280x800x24 -fbdir /tmp/fb +extension Composite +extension RENDER +extension DAMAGE > $OUT/x11e-xvfb.log 2>&1 &
for i in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
display -window root xc:'#3a6ea5' 2>/dev/null || true   # (xsetroot alone does not repaint an already-mapped root)
openbox > $OUT/x11e-openbox.log 2>&1 &
sleep 1
echo "ARGB (depth 32) visuals on this X server: $(xdpyinfo | grep -c 'depth:    32 planes')"

shot () { # $1 = name; prints the analysis line
  convert xwd:/tmp/fb/Xvfb_screen0 "$OUT/x11e-$1.png" 2>/dev/null
  python3 $L/pink-bbox.py "$OUT/x11e-$1.png"
}
PICOM=0
picom_up () { picom --backend xrender --no-vsync > $OUT/x11e-picom.log 2>&1 & PICOM=$!; sleep 1.5; }
picom_down () { [ "$PICOM" != 0 ] && { kill $PICOM 2>/dev/null; wait $PICOM 2>/dev/null; PICOM=0; }; sleep 0.3; }
EL=0
start_overlay () { # $1 = source id, $2 = log name; extra env via the caller
  : > $OUT/x11e-$2.log
  CIPHERLINE_WAYLAND_OVERLAY_HELPER=/tmp/cl-wayland-overlay CL_SOURCE_ID="$1" \
    /opt/electron/electron --no-sandbox --ozone-platform=x11 --disable-gpu --disable-dev-shm-usage $OUT/x11e/main.js \
    >> $OUT/x11e-$2.log 2>&1 &
  EL=$!
}
stop_overlay () { [ "$EL" != 0 ] && { kill $EL 2>/dev/null; wait $EL 2>/dev/null; EL=0; }; pkill -f /opt/electron/electron 2>/dev/null; sleep 0.5; }
# wait_for <log> <extended-regexp> <timeout-s>
wait_log () { for i in $(seq $(( $3 * 10 ))); do grep -qE "$2" $OUT/x11e-$1.log && return 0; sleep 0.1; done; return 1; }
# wait_pink <shotname> <present|absent> <timeout-s>: re-shoots until pink is (not) on screen; prints the final analysis line
wait_pink () {
  local r
  for i in $(seq $(( $3 * 4 ))); do
    r=$(shot "$1")
    case "$2" in
      present) [ "${r%% *}" != "-1" ] && { echo "$r"; return 0; } ;;
      absent)  [ "${r%% *}" = "-1" ]  && { echo "$r"; return 0; } ;;
    esac
    sleep 0.25
  done
  echo "$r"; return 1
}
near () { # near <a> <b> <tol>
  local d=$(( $1 - $2 )); [ ${d#-} -le "$3" ]
}
bbox_matches () { # bbox_matches "<x0 y0 x1 y1 ...>" fx fy fw fh tol label
  local line=($1)
  local bx0=${line[0]} by0=${line[1]} bx1=${line[2]} by1=${line[3]} fx=$2 fy=$3 fw=$4 fh=$5 tol=$6 label=$7
  [ "$bx0" = "-1" ] && { fail "$label: no strokes on screen"; return; }
  local ex0=$(( fx + fw * 3 / 100 )) ey0=$(( fy + fh * 3 / 100 )) ex1=$(( fx + fw * 97 / 100 )) ey1=$(( fy + fh * 97 / 100 ))
  if near $bx0 $ex0 $tol && near $by0 $ey0 $tol && near $bx1 $ex1 $tol && near $by1 $ey1 $tol; then
    pass "$label: strokes bbox [$bx0 $by0 $bx1 $by1] ~ expected [$ex0 $ey0 $ex1 $ey1] (frame $fx,$fy ${fw}x$fh, tol $tol)"
  else
    fail "$label: strokes bbox [$bx0 $by0 $bx1 $by1] vs expected [$ex0 $ey0 $ex1 $ey1] (frame $fx,$fy ${fw}x$fh, tol $tol)"
  fi
}

# A bright, opaque client window under everything: "the overlay is transparent" is then a pixel fact
# (xeyes' white background stays visible through the overlay), and "it paints black" is one too.
xeyes -geometry 500x380+160+120 > $OUT/x11e-xeyes.log 2>&1 &
EYES=$!
for i in $(seq 100); do XID=$(xdotool search --class xeyes 2>/dev/null | head -1); [ -n "${XID:-}" ] && break; sleep 0.1; done
[ -n "${XID:-}" ] && { sleep 0.5; xdotool windowmap "$XID"; sleep 0.5; }   # this xeyes + openbox pair can leave the window unmapped until asked
[ -n "${XID:-}" ] || { fail "xeyes not found"; exit 1; }
# A bright, opaque GTK window as the pixel probe (its yellow centre square): ordinary xeyes / ImageMagick windows
# are not repainted into a compositor's picture, a GTK window is. PX,PY = that square's centre.
UL=0
start_underlay () {
  [ "$UL" != 0 ] && { kill $UL 2>/dev/null; wait $UL 2>/dev/null; }
  GDK_BACKEND=x11 UL_W=400 UL_H=300 UNDERLAY_LOG=/tmp/ul.log python3 $L/underlay.py > $OUT/x11e-underlay.log 2>&1 &
  UL=$!
  local w=""
  for i in $(seq 100); do w=$(xdotool search --name '^underlay$' 2>/dev/null | head -1); [ -n "$w" ] && break; sleep 0.1; done
  [ -n "$w" ] || { fail "probe window did not appear: $(tail -2 $OUT/x11e-underlay.log | tr '\n' ' ')"; return; }
  xdotool windowmove "$w" 700 450; sleep 1.2
  set -- $(xwininfo -id "$w" | awk '/Absolute upper-left X/{x=$4} /Absolute upper-left Y/{y=$4} /Width:/{w=$2} /Height:/{h=$2} END{print x, y, w, h}')
  PX=$(( $1 + $3 / 2 )); PY=$(( $2 + $4 / 2 ))
}
start_underlay
bright () { python3 $L/pix.py "$OUT/x11e-$1.png" $PX $PY; }
same_as () { # same_as <brightness> <baseline>: within 15 of it (and the baseline is not itself black)
  local d=$(( $1 - $2 )); [ "$2" -ge 60 ] && [ ${d#-} -le 15 ]
}
shot BASE-A > /dev/null; BASE_A=$(bright BASE-A)
echo "   baseline, no overlay, no compositor: brightness $BASE_A at $PX,$PY"

# ── A. no compositor ────────────────────────────────────────────────────────
echo "== A. no compositor"
start_overlay screen:0:0 A
wait_log A 'SHOW ' 15 || fail "A: no SHOW line"
check_line=$(grep 'HARNESS.*SHOW' $OUT/x11e-A.log | head -1 | sed 's/^HARNESS [0-9]* //')
if echo "$check_line" | grep -q '"reason":"no_compositor"'; then pass "A: refused: $check_line"; else fail "A: expected no_compositor, got: $check_line"; fi
sleep 1.5
r=$(shot A-guarded); echo "   screen: $r"
bf=${r##* }
if awk "BEGIN{exit !($bf > 0.5)}"; then pass "A: screen untouched (blue fraction $bf)"; else fail "A: screen changed with no compositor (blue fraction $bf)"; fi
b=$(bright A-guarded)
if same_as "$b" "$BASE_A"; then pass "A: the client window underneath is exactly as it was (brightness $b, baseline $BASE_A)"; else fail "A: client window changed (brightness $b, baseline $BASE_A)"; fi
stop_overlay
echo "   -- negative control: the same session with the overlay forced on (CIPHERLINE_ANNOT_OVERLAY=1)"
export CIPHERLINE_ANNOT_OVERLAY=1
start_overlay screen:0:0 A-forced
wait_log A-forced 'SHOW \{"ok":true' 15 || fail "A-forced: not shown"
sleep 2
r=$(shot A-forced); echo "   screen: $r"
bf=${r##* }
b=$(bright A-forced)
if awk "BEGIN{exit !($bf < 0.1)}" && [ "$b" -lt 40 ]; then pass "A negative control: forced on with no compositor the overlay paints BLACK over the whole screen (blue fraction $bf; brightness $b where the client window was) - exactly what the guard prevents"; else fail "A negative control: expected the forced overlay to blank the screen (blue fraction $bf, brightness $b)"; fi
stop_overlay
unset CIPHERLINE_ANNOT_OVERLAY

# ── B. screen share + compositor flips ──────────────────────────────────────
echo "== B. screen share with picom, killed and restarted mid-share"
picom_up
start_overlay screen:0:0 B
wait_log B 'SHOW \{"ok":true' 15 && pass "B: shown: $(grep 'SHOW' $OUT/x11e-B.log | head -1 | sed 's/^HARNESS [0-9]* //')" || fail "B: not shown ($(grep -E 'SHOW|annot' $OUT/x11e-B.log | tail -2 | tr '\n' ' '))"
r=$(wait_pink B-up present 8) && { echo "   screen: $r"; bbox_matches "$r" 0 0 1280 800 14 "B: whole-screen strokes"; } || fail "B: no strokes on screen"
t0=$(date +%s%3N)
picom_down
if wait_log B 'ENDED no_compositor' 5; then pass "B: picom killed -> ENDED no_compositor after $(( $(date +%s%3N) - t0 )) ms (log)"; else fail "B: no ENDED after picom was killed"; fi
r=$(wait_pink B-down absent 4) && pass "B: strokes gone from the screen once the compositor is gone ($r)" || fail "B: strokes still on screen without a compositor ($r)"
bf=${r##* }
b=$(bright B-down)
if awk "BEGIN{exit !($bf > 0.5)}" && same_as "$b" "$BASE_A"; then pass "B: and no black window left over the screen (blue fraction $bf; client window brightness $b)"; else fail "B: screen not clean after the compositor left (blue fraction $bf, brightness $b)"; fi
picom_up
r=$(wait_pink B-back present 10) && { echo "   screen: $r"; pass "B: compositor back -> overlay shown again"; } || fail "B: not shown again after the compositor returned ($(grep -E 'SHOW|OVERLAY' $OUT/x11e-B.log | tail -3 | tr '\n' ' '))"
stop_overlay

# ── B2. the overlay is transparent under a running compositor ───────────────
# (a fresh opaque probe window is made UNDER the running compositor and photographed, then the overlay is shown
#  and the same pixel must be unchanged. Had the overlay been an opaque black window it would read 0.)
echo "== B2. transparency under a running compositor (xcompmgr)"
xcompmgr -n > $OUT/x11e-compmgr.log 2>&1 &
XC=$!
sleep 1.5
start_underlay
shot BASE-B2 > /dev/null; BASE_B2=$(bright BASE-B2)
echo "   baseline, no overlay, xcompmgr running: brightness $BASE_B2 at $PX,$PY"
start_overlay screen:0:0 B2
wait_log B2 'SHOW \{"ok":true' 15 && pass "B2: shown under xcompmgr: $(grep 'SHOW' $OUT/x11e-B2.log | head -1 | sed 's/^HARNESS [0-9]* //')" || fail "B2: not shown ($(grep -E 'SHOW|annot' $OUT/x11e-B2.log | tail -2 | tr '\n' ' '))"
r=$(wait_pink B2-up present 8) && echo "   screen: $r" || fail "B2: no strokes on screen"
b=$(bright B2-up)
if same_as "$b" "$BASE_B2"; then pass "B2: the overlay is transparent: the probe window shows through it unchanged (brightness $b, baseline $BASE_B2)"; else fail "B2: overlay hides what is under it (brightness $b, baseline $BASE_B2)"; fi
stop_overlay
kill $XC 2>/dev/null; wait $XC 2>/dev/null
[ "$UL" != 0 ] && { kill $UL 2>/dev/null; wait $UL 2>/dev/null; UL=0; }

# ── C. window share ─────────────────────────────────────────────────────────
echo "== C. window share"
truth () { xwininfo -id "$XID" 2>/dev/null | awk '/Absolute upper-left X/{x=$4} /Absolute upper-left Y/{y=$4} /Width:/{w=$2} /Height:/{h=$2} END{print x, y, w, h}'; }
echo "   xeyes XID $XID, client rect $(truth)"
CL_LIST_SOURCES=1 start_overlay "window:$XID:0" C
wait_log C 'SHOW \{"ok":true' 20 && pass "C: shown: $(grep 'SHOW' $OUT/x11e-C.log | head -1 | sed 's/^HARNESS [0-9]* //')" || fail "C: not shown ($(grep -E 'SHOW|annot' $OUT/x11e-C.log | tail -2 | tr '\n' ' '))"
grep 'HARNESS.*SOURCE window' $OUT/x11e-C.log | sed 's/^HARNESS [0-9]* /   /' | head -3
src=$(grep "SOURCE window:$XID:0" $OUT/x11e-C.log | head -1)
if [ -n "$src" ]; then
  tw=$(echo "$src" | sed -n 's/.*thumb=\([0-9]*\)x\([0-9]*\)/\1/p'); th=$(echo "$src" | sed -n 's/.*thumb=\([0-9]*\)x\([0-9]*\)/\2/p')
  set -- $(truth)
  if [ -n "$tw" ] && [ "$tw" -gt 0 ] && awk "BEGIN{d=$tw/$th - $3/$4; exit !(d<0.02 && d>-0.02)}"; then pass "C: desktopCapturer lists window:$XID:0; its thumbnail ${tw}x${th} has the CLIENT area's aspect ($3x$4), not the decorated frame's"; else fail "C: thumbnail ${tw}x${th} vs client $3x$4"; fi
else fail "C: desktopCapturer did not list window:$XID:0"; fi

r=$(wait_pink C-0 present 8) && { echo "   screen: $r"; set -- $(truth); bbox_matches "$r" $1 $2 $3 $4 14 "C: strokes on the window's frame"; } || fail "C: no strokes on screen"
xdotool windowmove "$XID" 600 300; sleep 1.2
r=$(wait_pink C-1 present 6); set -- $(truth); echo "   moved: client rect $*"; bbox_matches "$r" $1 $2 $3 $4 14 "C: follows xdotool windowmove"
xdotool windowsize "$XID" 300 260; sleep 1.2
r=$(wait_pink C-2 present 6); set -- $(truth); echo "   resized: client rect $*"; bbox_matches "$r" $1 $2 $3 $4 14 "C: follows xdotool windowsize"
xdotool windowminimize "$XID"
r=$(wait_pink C-min absent 5) && pass "C: hidden while the window is minimized" || fail "C: strokes still shown while minimized ($r)"
xdotool windowmap "$XID"; xdotool windowactivate "$XID" 2>/dev/null
r=$(wait_pink C-3 present 8); sleep 1.5; r=$(shot C-3)    # the WM maps a restored window at a transient spot first; let it settle
[ "${r%% *}" != "-1" ] && { set -- $(truth); echo "   restored: client rect $*"; bbox_matches "$r" $1 $2 $3 $4 14 "C: back on the window after restore"; } || fail "C: not shown again after restore"
xdotool set_desktop 1
r=$(wait_pink C-ws absent 5) && pass "C: hidden while the window's desktop is not current" || fail "C: strokes still shown on another desktop ($r)"
xdotool set_desktop 0
r=$(wait_pink C-4 present 8) && pass "C: back with the desktop" || fail "C: not shown again after switching back"
picom_down
wait_log C 'ENDED no_compositor' 5 && pass "C: picom killed -> ENDED no_compositor" || fail "C: no ENDED after picom was killed"
r=$(wait_pink C-down absent 4) && pass "C: strokes gone with the compositor" || fail "C: strokes still on screen ($r)"
picom_up
r=$(wait_pink C-5 present 10) && pass "C: compositor back -> window overlay shown again" || fail "C: not shown again"
kill $EYES; wait $EYES 2>/dev/null
r=$(wait_pink C-gone absent 5) && pass "C: window exited -> overlay gone" || fail "C: strokes still on screen after the window exited ($r)"
stop_overlay
picom_down

echo "overall: $([ $RC = 0 ] && echo PASS || echo FAIL)"
exit $RC
