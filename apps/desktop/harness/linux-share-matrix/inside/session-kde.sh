#!/usr/bin/env bash
# Session 2: KDE. kwin_wayland --virtual + xdg-desktop-portal-kde (no plasmashell). The portal's own Qt chooser appears
# and nothing here answers it unless chooser-bot.sh manages to (see below): that is itself a measurement. KWin is started with
# KWIN_WAYLAND_NO_PERMISSION_CHECKS=1 so the portal may use the screencast protocol without being a registered .desktop client.
start_session() {
  command -v kwin_wayland >/dev/null || { log "kwin_wayland not installed"; return 2; }
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE KDE_FULL_SESSION=true XDG_SESSION_DESKTOP=KDE
  export KWIN_WAYLAND_NO_PERMISSION_CHECKS=1
  if [ ! -e /dev/dri/renderD128 ] || [ "${MATRIX_GPU:-1}" != 1 ]; then export LIBGL_ALWAYS_SOFTWARE=1 KWIN_COMPOSE=Q; fi
  mkdir -p ~/.config/xdg-desktop-portal
  for f in portals.conf kde-portals.conf; do
    cat > ~/.config/xdg-desktop-portal/$f <<EOF
[preferred]
default=kde
org.freedesktop.impl.portal.ScreenCast=kde
org.freedesktop.impl.portal.Screenshot=kde
EOF
  done
  # kwin_wayland carries file capabilities (cap_sys_nice) that a default container does not grant, so exec of the packaged
  # file fails with "Operation not permitted". A copy has no file caps and runs unprivileged (without realtime scheduling).
  mkdir -p ~/bin && cp "$(command -v kwin_wayland)" ~/bin/kwin_wayland && export PATH=$HOME/bin:$PATH
  local extra=""; kwin_wayland --help 2>&1 | grep -q -- --no-lockscreen && extra="$extra --no-lockscreen"
  kwin_wayland --virtual --width ${MATRIX_W:-1280} --height ${MATRIX_H:-720} --socket wayland-0 --xwayland $extra >"$OUT/kwin.log" 2>&1 & track $! kwin_wayland
  wait_for 25 "kwin wayland socket" have_wayland_socket || { tail -20 "$OUT/kwin.log" >&2; return 3; }
  export WAYLAND_DISPLAY=$(wayland_socket)
  dbus-update-activation-environment --all 2>/dev/null || true
  sleep 2
  # The portal's dialog is made an X11 window (Xwayland) so chooser-bot-kde.sh can type into it; MATRIX_KDE_QPA=wayland keeps it native.
  export QT_QPA_PLATFORM=${MATRIX_KDE_QPA:-xcb}
  export KDE_XDISPLAY=$(ls /tmp/.X11-unix 2>/dev/null | sed -n 's/^X/:/p' | head -1); [ -n "$KDE_XDISPLAY" ] && export DISPLAY=$KDE_XDISPLAY
  start_portals xdg-desktop-portal-kde
  unset DISPLAY; unset QT_QPA_PLATFORM
  bash $H/inside/chooser-bot-kde.sh >"$OUT/chooser-bot.log" 2>&1 & track $! chooser-bot
  return 0
}
session_meta() { echo "kwin $(kwin_wayland --version 2>&1 | head -1); portal-kde $(dpkg -s xdg-desktop-portal-kde 2>/dev/null | grep ^Version || rpm -q xdg-desktop-portal-kde 2>/dev/null || pacman -Q xdg-desktop-portal-kde 2>/dev/null)"; }
