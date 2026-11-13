#!/usr/bin/env bash
# The helper where its dependencies are missing: libwayland-client absent (an install without
# Wayland libraries), no Wayland session at all, a socket nobody listens on. Each must produce a
# one-line report main understands and a non-zero exit, never a crash or a hang. (Run inside the
# lab image; the library is moved aside for the first case, the container is disposable.)
set -u
SRC=/d/src-native/wayland_overlay
gcc -std=gnu11 -Wall -O2 -o /tmp/cl-wayland-overlay $SRC/cl_wayland_overlay.c -I$SRC -lm -ldl || exit 1
RC=0
expect () {   # $1=label  $2=expected last line  $3...=command
  local label="$1" want="$2"; shift 2
  got=$(timeout 10 "$@" < /dev/null 2>&1 | tail -1); rc=${PIPESTATUS[0]}
  if [ "$got" = "$want" ]; then echo "PASS $label: '$got'"; else echo "FAIL $label: wanted '$want', got '$got' (rc=$rc)"; RC=1; fi
}
export XDG_RUNTIME_DIR=/tmp/xdg-absent; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
echo "undefined Wayland/X symbols in the binary (must be 0, they are dlopen()ed): $(nm -D --undefined-only /tmp/cl-wayland-overlay | grep -c -E ' (wl_|X[A-Z])')"
echo "shared libraries it links: $(ldd /tmp/cl-wayland-overlay | awk '{print $1}' | grep -v -E 'linux-vdso|ld-linux' | tr '\n' ' ')"

expect "no Wayland session" "ERR no_wayland_display" env -i /tmp/cl-wayland-overlay
expect "socket nobody listens on" "ERR connect" env -i XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR WAYLAND_DISPLAY=wayland-nobody /tmp/cl-wayland-overlay

mkdir -p /tmp/hold
mv /usr/lib/x86_64-linux-gnu/libwayland-client.so.0* /tmp/hold/
expect "libwayland-client missing" "ERR no_libwayland" env -i XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR WAYLAND_DISPLAY=wayland-0 /tmp/cl-wayland-overlay
mv /tmp/hold/libwayland-client.so.0* /usr/lib/x86_64-linux-gnu/

# The plain-X11 modes (x11_probe.inc): main falls back to the desktop-name list on any ERR, so each
# failure must be one line and a non-zero exit, never a hang or a crash.
expect "x11-probe: no DISPLAY" "ERR no_display" env -i /tmp/cl-wayland-overlay --x11-probe
expect "x11-watch: no DISPLAY" "ERR no_display" env -i /tmp/cl-wayland-overlay --x11-watch
expect "x11-probe: no X server there" "ERR no_x_server" env -i DISPLAY=:77 /tmp/cl-wayland-overlay --x11-probe
mv /usr/lib/x86_64-linux-gnu/libX11.so.6* /tmp/hold/
expect "x11-probe: libX11 missing" "ERR no_libx11" env -i DISPLAY=:77 /tmp/cl-wayland-overlay --x11-probe
mv /tmp/hold/libX11.so.6* /usr/lib/x86_64-linux-gnu/
bad=$(echo "bogus" | timeout 5 env -i DISPLAY=:77 /tmp/cl-wayland-overlay --x11-watch 2>&1 | tail -1)
echo "info: x11-watch with no server ends with '$bad'"

echo "overall: $([ $RC = 0 ] && echo PASS || echo FAIL)"
exit $RC
