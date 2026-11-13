#!/usr/bin/env bash
# RESEARCH, not shipped: can a client learn another window's geometry on KWin? (Window shares on
# Wayland need it.) Loads a KWin script over D-Bus (org.kde.KWin /Scripting) that prints every
# window's class, uuid, pid and frameGeometry. Result in the report: yes on KWin - but the portal
# never says WHICH window a share is, so geometry alone cannot place an overlay.
# Needs --cap-add=SYS_NICE. Writes /out/kwin-window-geometry.log.
set -u
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$@"; fi
OUT=${OUT:-/out}; mkdir -p "$OUT"
L=/d/harness/wayland-annotation/lab
export LC_ALL=C.UTF-8
export XDG_RUNTIME_DIR=/tmp/xdg-kwin3; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
Xvfb :99 -screen 0 1920x1080x24 > /dev/null 2>&1 &
sleep 1
export KWIN_WAYLAND_NO_PERMISSION_CHECKS=1 QT_LOGGING_RULES="kwin_scripting.debug=true;js.debug=true"
kwin_wayland --x11-display :99 --width 1920 --height 1080 --socket wayland-kde --no-lockscreen --no-global-shortcuts > $OUT/kwin-window-geometry-kwin.log 2>&1 &
for i in $(seq 50); do [ -S $XDG_RUNTIME_DIR/wayland-kde ] && break; sleep 0.2; done
sleep 2
export WAYLAND_DISPLAY=wayland-kde
UL_W=640 UL_H=480 UNDERLAY_LOG=/tmp/ul.log GDK_BACKEND=wayland python3 $L/underlay.py > /dev/null 2>&1 &
sleep 3
cat > /tmp/geom.js <<'JS'
var out = [];
workspace.windowList().forEach(function (w) {
    out.push({ cls: w.resourceClass, uuid: String(w.internalId), pid: w.pid, fullscreen: w.fullScreen,
               x: w.frameGeometry.x, y: w.frameGeometry.y, w: w.frameGeometry.width, h: w.frameGeometry.height });
});
print("CLGEOM " + JSON.stringify(out));
JS
gdbus call --session --dest org.kde.KWin --object-path /Scripting --method org.kde.kwin.Scripting.loadScript /tmp/geom.js geomprobe
gdbus call --session --dest org.kde.KWin --object-path /Scripting --method org.kde.kwin.Scripting.start
sleep 2
{ grep -h "CLGEOM" $OUT/kwin-window-geometry-kwin.log || echo "no CLGEOM line in the KWin log"; } | tee $OUT/kwin-window-geometry.log
pkill -f underlay.py; pkill kwin_wayland; pkill Xvfb
