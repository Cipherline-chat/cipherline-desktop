#!/usr/bin/env bash
# Session 1: Wayland via sway headless + xdg-desktop-portal-wlr. The portal chooser is automated by xdpw's own
# `chooser_type=none` (it picks output_name without asking), so portal prompts are counted from the D-Bus traffic, not from UI.
start_session() {
  command -v sway >/dev/null || { log "sway not installed"; return 2; }
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway:wlroots
  export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_HEADLESS_OUTPUTS=1
  if [ -e /dev/dri/renderD128 ] && [ "${MATRIX_GPU:-1}" = 1 ]; then
    export WLR_RENDER_DRM_DEVICE=/dev/dri/renderD128
  else
    export WLR_RENDERER=pixman
  fi
  mkdir -p ~/.config/sway ~/.config/xdg-desktop-portal-wlr ~/.config/xdg-desktop-portal
  cat > ~/.config/sway/config <<EOF
default_border none
default_floating_border none
focus_follows_mouse no
output * mode --custom ${MATRIX_W:-1280}x${MATRIX_H:-720}@${MATRIX_HZ:-90}Hz
for_window [shell=".*"] floating enable
EOF
  cat > ~/.config/xdg-desktop-portal-wlr/config <<EOF
[screencast]
chooser_type=none
output_name=${MATRIX_XDPW_OUTPUT:-HEADLESS-1}
max_fps=${MATRIX_XDPW_MAX_FPS:-144}
EOF
  for f in portals.conf sway-portals.conf wlroots-portals.conf; do
    cat > ~/.config/xdg-desktop-portal/$f <<EOF
[preferred]
default=wlr
org.freedesktop.impl.portal.ScreenCast=wlr
org.freedesktop.impl.portal.Screenshot=wlr
EOF
  done
  local SW; SW=$(command -v sway)
  # Fedora ships sway with file capabilities (cap_sys_nice) a default container does not grant: exec then fails with
  # "Operation not permitted". A copy carries no file caps and runs unprivileged (without realtime scheduling).
  if ! "$SW" --version >/dev/null 2>&1; then mkdir -p ~/bin && cp "$SW" ~/bin/sway && SW=$HOME/bin/sway && echo "sway_binary_copied_to_drop_file_caps=1" >> "$OUT/facts.txt"; fi
  "$SW" -c ~/.config/sway/config >"$OUT/sway.log" 2>&1 & track $! sway
  wait_for 15 "sway wayland socket" have_wayland_socket || { cat "$OUT/sway.log" | tail -20 >&2; return 3; }
  export WAYLAND_DISPLAY=$(wayland_socket)
  export SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.* 2>/dev/null | head -1)
  dbus-update-activation-environment --all 2>/dev/null || true
  sleep 1
  swaymsg -t get_outputs 2>/dev/null | python3 -c 'import json,sys
for o in json.load(sys.stdin): print("OUTPUT", o["name"], o["current_mode"])' > "$OUT/outputs.txt" 2>&1 || true
  cat "$OUT/outputs.txt" >&2
  start_portals xdg-desktop-portal-wlr
}
session_meta() { echo "sway $(sway --version 2>/dev/null | head -1); xdpw $(dpkg -s xdg-desktop-portal-wlr 2>/dev/null | grep ^Version || rpm -q xdg-desktop-portal-wlr 2>/dev/null || pacman -Q xdg-desktop-portal-wlr 2>/dev/null)"; }
