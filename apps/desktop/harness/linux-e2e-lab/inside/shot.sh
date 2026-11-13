#!/usr/bin/env bash
# Screenshot of the sharer's COMPOSITOR output (what a person looking at the monitor sees, overlay windows included), run through
# `docker exec`.   shot.sh <desktop> <out.png> [output-name]     also writes <out>.rgb (raw 8-bit RGB) and prints "<w>x<h>".
export XDG_RUNTIME_DIR=/tmp/xdg-run
D=$1; OUT=$2; O=${3:-HEADLESS-1}
case "$D" in
  sway) export WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep -E '^wayland-[0-9]+$' | head -1); grim -o "$O" "$OUT" ;;
  x11)  DISPLAY=:99 import -window root "$OUT" ;;
  kde)  export WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep -E '^wayland-[0-9]+$' | head -1); spectacle -b -n -f -o "$OUT" ;;
  gnome) export WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep -E '^wayland-[0-9]+$' | head -1)
         gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT" ;;
  *) echo "no screenshot method for $D" >&2; exit 2 ;;
esac || exit 1
convert "$OUT" -depth 8 "rgb:${OUT%.png}.rgb" && identify -format '%wx%h\n' "$OUT"
