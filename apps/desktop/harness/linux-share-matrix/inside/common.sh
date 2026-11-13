#!/usr/bin/env bash
# Sourced by every inside/ script. Runs INSIDE a matrix container, as the unprivileged user `tester`.
export PATH=/node/bin:$PATH
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/xdg-run}
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export HOME=${HOME:-/home/tester}
OUT=${OUT:-/out}
PIDS=$OUT/pids.txt          # every long-lived process we start, with its exact PID and what it is (cleanup + audit)
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/harness.log" >&2; }
track() { echo "$1 $2" >> "$PIDS"; }   # track <pid> <name>

# first existing executable named $1 anywhere the distros hide libexec binaries
findbin() {
  local n=$1 d
  command -v "$n" 2>/dev/null && return 0
  for d in /usr/libexec /usr/lib /usr/lib64 /usr/lib/x86_64-linux-gnu /usr/libexec/* /usr/lib/*/ /usr/bin /usr/sbin; do
    [ -x "$d/$n" ] && { echo "$d/$n"; return 0; }
  done
  find /usr /opt -name "$n" -type f -perm -u+x 2>/dev/null | head -1
}

wait_for() {   # wait_for <seconds> <description> <command...>   (wall-clock bound: a hanging command cannot stretch it)
  local t=$1 d=$2; shift 2
  local end=$((SECONDS + t))
  while [ $SECONDS -lt $end ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done
  log "TIMEOUT waiting for $d"; return 1
}

wayland_socket() { ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E '^wayland-[0-9]+$' | head -1; }

# Portal stack: backend(s) first, then the frontend, all manually started (no systemd in the container).
# $1 = space separated backend executables to start
start_portals() {
  local b bin
  for b in "$@"; do
    bin=$(findbin "$b") || true
    if [ -z "$bin" ]; then log "portal backend $b NOT FOUND"; echo "missing:$b" >> "$OUT/portal-missing.txt"; continue; fi
    "$bin" >"$OUT/portal-$b.log" 2>&1 & track $! "$b"
    log "started $b pid=$! ($bin)"
  done
  sleep 1
  local fe; fe=$(findbin xdg-desktop-portal) || true
  if [ -z "$fe" ]; then log "xdg-desktop-portal NOT FOUND"; return 1; fi
  "$fe" -r >"$OUT/portal-frontend.log" 2>&1 & track $! xdg-desktop-portal
  log "started xdg-desktop-portal pid=$! ($fe)"
  if wait_for 12 "portal frontend on the bus" gdbus call --timeout 3 --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop \
    --method org.freedesktop.DBus.Properties.Get org.freedesktop.portal.ScreenCast version; then echo portal_screencast_available=1 >> "$OUT/facts.txt"; else echo portal_screencast_available=0 >> "$OUT/facts.txt"; fi
  return 0
}

start_audio() {
  pipewire >"$OUT/pipewire.log" 2>&1 & track $! pipewire
  wait_for 10 pipewire pw-cli info 0
  wireplumber >"$OUT/wireplumber.log" 2>&1 & track $! wireplumber
  pipewire-pulse >"$OUT/pipewire-pulse.log" 2>&1 & track $! pipewire-pulse
  sleep 2
  pw-cli create-node adapter '{ factory.name=support.null-audio-sink node.name=cipherline-test-sink node.description="test sink" media.class=Audio/Sink audio.position=[FL FR] node.driver=true object.linger=true }' >/dev/null 2>&1
  sleep 1.5
}

portal_monitor() {
  stdbuf -oL dbus-monitor --session "interface='org.freedesktop.portal.ScreenCast'" "interface='org.freedesktop.impl.portal.ScreenCast'" \
    "interface='org.freedesktop.impl.portal.Request'" >"$OUT/dbus-portal.log" 2>&1 & track $! dbus-monitor
}
have_wayland_socket() { [ -n "$(wayland_socket)" ]; }

# is DISPLAY answering? (xdpyinfo is not installed on every distro's minimal X utilities)
x_ready() { xdpyinfo >/dev/null 2>&1 || xdotool getdisplaygeometry >/dev/null 2>&1 || xset q >/dev/null 2>&1; }
