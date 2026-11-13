#!/usr/bin/env bash
# Session: Wayland via sway (headless, 2 outputs) + xdg-desktop-portal-wlr. Adapted from linux-share-matrix/session-sway.sh.
# The portal chooser is automated and COUNTED: xdpw runs chooser_type=dmenu with inside/xdpw-chooser.sh, which logs one line per
# invocation (= one chooser a real user would have seen) and answers from $OUT/chooser-pick (default: first output).
start_session() {
  command -v sway >/dev/null || { log "sway not installed"; return 2; }
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway:wlroots
  export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_HEADLESS_OUTPUTS=${LAB_OUTPUTS:-2}
  if [ -e /dev/dri/renderD128 ] && [ "${LAB_GPU:-1}" = 1 ]; then
    export WLR_RENDER_DRM_DEVICE=/dev/dri/renderD128
  else
    export WLR_RENDERER=pixman
  fi
  mkdir -p ~/.config/sway ~/.config/xdg-desktop-portal-wlr ~/.config/xdg-desktop-portal
  cat > ~/.config/sway/config <<EOF
default_border none
default_floating_border none
focus_follows_mouse no
output * mode --custom ${LAB_W:-1920}x${LAB_H:-1080}@${LAB_HZ:-90}Hz
output HEADLESS-1 pos 0 0
output HEADLESS-2 pos ${LAB_W:-1920} 0
for_window [shell=".*"] floating enable
EOF
  cat > ~/.config/xdg-desktop-portal-wlr/config <<EOF
[screencast]
chooser_type=dmenu
chooser_cmd=$H/inside/xdpw-chooser.sh
max_fps=${LAB_XDPW_MAX_FPS:-144}
EOF
  for f in portals.conf sway-portals.conf wlroots-portals.conf; do
    cat > ~/.config/xdg-desktop-portal/$f <<EOF
[preferred]
default=wlr
org.freedesktop.impl.portal.ScreenCast=wlr
org.freedesktop.impl.portal.Screenshot=wlr
EOF
  done
  export LAB_OUT=$OUT
  # Arch's sway carries file capabilities (cap_sys_nice) that a default container does not grant: exec fails with EPERM. A copy has none.
  mkdir -p ~/bin && cp "$(command -v sway)" ~/bin/sway && export PATH=$HOME/bin:$PATH
  sway -c ~/.config/sway/config >"$OUT/sway.log" 2>&1 & track $! sway
  wait_for 15 "sway wayland socket" have_wayland_socket || { tail -20 "$OUT/sway.log" >&2; return 3; }
  export WAYLAND_DISPLAY=$(wayland_socket)
  export SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.* 2>/dev/null | head -1)
  dbus-update-activation-environment --all 2>/dev/null || true
  sleep 1
  swaymsg -t get_outputs 2>/dev/null | python3 -c 'import json,sys
for o in json.load(sys.stdin): print("OUTPUT", o["name"], o["current_mode"])' > "$OUT/outputs.txt" 2>&1 || true
  cat "$OUT/outputs.txt" >&2
  start_portals xdg-desktop-portal-wlr
}
# screenshot of the sharer's COMPOSITOR output (what a person looking at the monitor sees): grim on wlroots
desktop_screenshot() { grim -o "${2:-HEADLESS-1}" "$1"; }
session_meta() { echo "sway $(sway --version 2>/dev/null | head -1); xdpw $(dpkg -s xdg-desktop-portal-wlr 2>/dev/null | grep ^Version)"; }
