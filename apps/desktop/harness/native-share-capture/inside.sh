#!/usr/bin/env bash
# INSIDE the cle2e-desktop container (sway headless + xdg-desktop-portal-wlr + PipeWire). Runs the REAL native capture helper against
# the real portal and drives the compositor through a scripted scenario. Output files land in /out; analyze.py reads them on the host.
set -u
export H=/lab OUT=/out
mkdir -p "$OUT"
source $H/inside/common.sh
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$@"; fi
: > "$PIDS"
sed "s/export WLR_RENDERER=pixman/export WLR_RENDERER=${LAB_RENDERER:-pixman}/" $H/inside/session-sway.sh > /tmp/session-sway-r.sh; source /tmp/session-sway-r.sh
if [ -n "${XDPW_DEBUG:-}" ]; then   # same as the lab's start_portals but xdpw runs with -l DEBUG
  start_portals() { /usr/libexec/xdg-desktop-portal-wlr -l DEBUG >"$OUT/portal-xdg-desktop-portal-wlr.log" 2>&1 & track $! xdpw; sleep 1; /usr/libexec/xdg-desktop-portal -r >"$OUT/portal-frontend.log" 2>&1 & track $! xdg-desktop-portal; sleep 2; }
fi
export LAB_W=${LAB_W:-1280} LAB_H=${LAB_H:-720} LAB_HZ=${LAB_HZ:-60} LAB_OUTPUTS=2
BACKEND=${BACKEND:-pcm}; MAXW=${MAXW:-640}; MAXH=${MAXH:-360}; FPS=${FPS:-30}
cleanup() { tac "$PIDS" | while read -r pid name; do kill -- "$pid" 2>/dev/null; done; sleep 0.5; tac "$PIDS" | while read -r pid name; do kill -9 -- "$pid" 2>/dev/null; done; }
trap cleanup EXIT
start_audio >/dev/null 2>&1
start_session || { log "session failed"; exit 3; }
sleep 1
export WAYLAND_DISPLAY=$(wayland_socket)
swaymsg 'output HEADLESS-1 bg #202020 solid_color' >/dev/null
echo HEADLESS-1 > "$OUT/chooser-pick"; export LAB_OUT=$OUT

grim -o HEADLESS-1 "$OUT/grim.png" > "$OUT/grim.log" 2>&1; echo "grim exit=$?" >> "$OUT/grim.log"
mkfifo "$OUT/ctl" 2>/dev/null
sleep 1000 > "$OUT/ctl" & track $! ctl-holder    # keeps the fifo open so the helper never sees EOF
for attempt in 1 2 3 4; do
  /helper/share-encoder-helper --capture --backend $BACKEND --width $MAXW --height $MAXH --fps $FPS < "$OUT/ctl" > "$OUT/au.bin" 2> "$OUT/helper.err" &
  HP=$!; track $HP helper
  for i in $(seq 1 60); do grep -q '"event":"format"' "$OUT/helper.err" 2>/dev/null && break; kill -0 $HP 2>/dev/null || break; sleep 0.1; done
  kill -0 $HP 2>/dev/null && break
  echo "attempt $attempt: $(tail -1 "$OUT/helper.err")" >> "$OUT/attempts.txt"; wait $HP; sleep 1
done
kill -0 $HP 2>/dev/null || { wait $HP; echo "helper_exit=$?" > "$OUT/exit.txt"; exit 0; }
now_ms() { date +%s%3N; }
mark() { echo "$(now_ms) $*" >> "$OUT/marks.txt"; }
: > "$OUT/marks.txt"
mark start
sleep 1.5
for c in ff0000 00ff00 0000ff; do swaymsg "output HEADLESS-1 bg #$c solid_color" >/dev/null; mark "color $c"; sleep 1.2; done
mark "static-begin"; sleep 3; mark "static-end"                                     # idle: no damage at all
mark "burst-begin"; end=$((SECONDS+3)); n=0
while [ $SECONDS -lt $end ]; do swaymsg "output HEADLESS-1 bg #$(printf '%02x%02x%02x' $((n*7%256)) $((n*13%256)) $((n*29%256))) solid_color" >/dev/null; n=$((n+1)); done
mark "burst-end $n"
swaymsg 'output HEADLESS-1 bg #ff0000 solid_color' >/dev/null
swaymsg 'output HEADLESS-1 mode --custom 1024x768@60Hz' >/dev/null; mark "resize 1024x768"; sleep 2
swaymsg 'output HEADLESS-1 bg #0000ff solid_color' >/dev/null; sleep 1; mark "blue-after-resize"; sleep 1
if [ "${STOP_MODE:-stop}" = disable ]; then
  swaymsg 'output HEADLESS-1 disable' >/dev/null; mark "output-disabled"
  for i in $(seq 1 60); do kill -0 $HP 2>/dev/null || break; sleep 0.2; done
elif [ "${STOP_MODE:-stop}" = killportal ]; then
  pkill -f xdg-desktop-portal-wlr; mark "portal-killed"
  for i in $(seq 1 60); do kill -0 $HP 2>/dev/null || break; sleep 0.2; done
else timeout 2 bash -c "echo STOP > $OUT/ctl" || true; fi
wait $HP; echo "helper_exit=$?" > "$OUT/exit.txt"; mark "helper-exited"
