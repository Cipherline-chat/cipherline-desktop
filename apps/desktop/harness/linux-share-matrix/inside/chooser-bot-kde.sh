#!/usr/bin/env bash
# Best-effort answerer for xdg-desktop-portal-kde's chooser. The portal is started with QT_QPA_PLATFORM=xcb so its dialog is an
# X11 window inside KWin's Xwayland, which xdotool (XTEST) can focus and type into; a native-Wayland Qt dialog accepts input only
# from the compositor, and KWin offers no D-Bus input injection. Logged verbatim: if it cannot answer, the report says so.
H=/h
source $H/inside/common.sh
OUT=${OUT:-/out}
LOG=$OUT/dbus-portal.log
export DISPLAY=${KDE_XDISPLAY:-:0}
echo "bot start (DISPLAY=$DISPLAY)"
wait_for 20 "kwin xwayland" x_ready || { echo "no X display from kwin: cannot drive the dialog"; exit 0; }
win() { xdotool search --onlyvisible --class "xdg-desktop-portal-kde" 2>/dev/null | head -1; }
ATTEMPTS=("Return" "Tab Return" "Tab Tab Return" "space Return" "Tab Tab Tab Return")
seen=0
while :; do
  n=$(grep -c "interface=org.freedesktop.impl.portal.ScreenCast; member=Start" "$LOG" 2>/dev/null); n=${n:-0}
  if [ "$n" -gt "$seen" ]; then
    seen=$n
    echo "$(date +%T) backend Start #$n: looking for the dialog"
    for i in $(seq 1 20); do [ -n "$(win)" ] && break; sleep 0.5; done
    W=$(win)
    echo "  dialog window id: ${W:-none}  ($(xdotool getwindowname "$W" 2>/dev/null))"
    if [ -n "$W" ]; then
      for a in "${ATTEMPTS[@]}"; do
        xdotool windowfocus "$W" 2>/dev/null; sleep 0.3
        echo "  keys: $a"
        for k in $a; do xdotool key --window "$W" "$k" 2>/dev/null; xdotool key "$k" 2>/dev/null; sleep 0.3; done
        sleep 2
        if [ -z "$(win)" ]; then echo "  dialog gone after: $a"; break; fi
      done
      [ -n "$(win)" ] && echo "  dialog still open: NOT answered"
    fi
  fi
  sleep 0.5
done
