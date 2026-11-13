#!/usr/bin/env bash
# Session 4: plain X11. Xvfb + openbox. Chromium captures with XShm / X11 (no portal); no DRI3 under Xvfb, so
# VA-API is not expected to work here (measured, not assumed: see vainfo + encoder results in the cell JSON).
start_session() {
  command -v Xvfb >/dev/null || { log "Xvfb not installed"; return 2; }
  export XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=openbox
  unset WAYLAND_DISPLAY
  Xvfb :99 -screen 0 ${LAB_W:-1920}x${LAB_H:-1080}x24 +extension GLX +extension RANDR +extension RENDER +extension MIT-SHM -nolisten tcp >"$OUT/xvfb.log" 2>&1 & track $! Xvfb
  export DISPLAY=:99
  wait_for 10 "Xvfb" xdpyinfo
  openbox >"$OUT/openbox.log" 2>&1 & track $! openbox
  sleep 1
  start_portals || true     # frontend only: not used by the X11 capturer, but present on a real desktop
}
session_meta() { echo "Xvfb $(Xvfb -version 2>&1 | head -1); openbox $(openbox --version 2>&1 | head -1)"; }
