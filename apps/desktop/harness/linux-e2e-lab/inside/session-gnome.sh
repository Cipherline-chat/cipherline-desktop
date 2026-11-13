#!/usr/bin/env bash
# Session 3: GNOME. mutter headless (or gnome-shell --headless when it is new enough) + xdg-desktop-portal-gnome.
# The portal's GTK chooser appears; chooser-bot.sh tries to answer it (best effort, logged).
start_session() {
  command -v mutter >/dev/null || { log "mutter not installed"; return 2; }
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome
  if [ ! -e /dev/dri/renderD128 ] || [ "${LAB_GPU:-1}" != 1 ]; then export LIBGL_ALWAYS_SOFTWARE=1; fi
  mkdir -p ~/.config/xdg-desktop-portal
  for f in portals.conf gnome-portals.conf; do
    cat > ~/.config/xdg-desktop-portal/$f <<EOF
[preferred]
default=gnome
org.freedesktop.impl.portal.ScreenCast=gnome
org.freedesktop.impl.portal.Screenshot=gnome
EOF
  done
  # gsettings/dconf need a writable profile; use the in-memory backend so nothing is persisted
  export GSETTINGS_BACKEND=memory
  local mode=mutter
  if [ "${LAB_GNOME_SHELL:-1}" = 1 ] && command -v gnome-shell >/dev/null && gnome-shell --help 2>&1 | grep -q -- --headless; then mode=shell; fi
  if [ $mode = shell ]; then
    gnome-shell --headless --wayland --wayland-display=wayland-0 --virtual-monitor ${LAB_W:-1920}x${LAB_H:-1080} >"$OUT/gnome-shell.log" 2>&1 & track $! gnome-shell
  else
    mutter --headless --wayland --wayland-display=wayland-0 --no-x11 --virtual-monitor ${LAB_W:-1920}x${LAB_H:-1080} >"$OUT/mutter.log" 2>&1 & track $! mutter
  fi
  echo "gnome_mode=$mode" >> "$OUT/facts.txt"
  wait_for 40 "gnome wayland socket" have_wayland_socket || { tail -20 "$OUT"/mutter.log "$OUT"/gnome-shell.log >&2 2>/dev/null; return 3; }
  export WAYLAND_DISPLAY=$(wayland_socket)
  dbus-update-activation-environment --all 2>/dev/null || true
  sleep 3
  start_portals xdg-desktop-portal-gnome
  [ -n "${LAB_CHOOSER_BOT:-1}" ] && bash $H/inside/chooser-bot.sh gnome >"$OUT/chooser-bot.log" 2>&1 & track $! chooser-bot
  return 0
}
session_meta() { echo "mutter $(mutter --version 2>&1 | head -1); gnome-shell $(gnome-shell --version 2>&1 | head -1); portal-gnome $(dpkg -s xdg-desktop-portal-gnome 2>/dev/null | grep ^Version || rpm -q xdg-desktop-portal-gnome 2>/dev/null || pacman -Q xdg-desktop-portal-gnome 2>/dev/null)"; }
