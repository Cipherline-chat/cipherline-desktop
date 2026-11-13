#!/usr/bin/env bash
# One lab client, INSIDE its container, as the unprivileged user `tester`.   client.sh <role: sharer|viewer> <desktop: sway|kde|gnome|x11>
#
# Starts, in order (every PID tracked in $OUT/pids.txt and killed by exact PID on exit):
#   PipeWire + WirePlumber + pipewire-pulse + a null sink (the "speakers") + a dedicated silent/tone virtual microphone,
#   a dbus-monitor on the ScreenCast portal, the desktop session, the lab proxy (API/LiveKit on the renderer-CSP origin),
#   the pattern/tone app (sharer only: motion + a 1000 Hz tone, outside the Cipherline process tree), a CDP forwarder, and
#   the REAL app: Electron 43 running apps/desktop (dist-electron + dist) against the lab API.
set -u
ROLE=${1:?role}; DESKTOP=${2:?desktop}
H=${H:-/lab}
OUT=${LAB_OUT_BASE:-/out}/$ROLE; mkdir -p "$OUT"
export OUT H
source $H/inside/common.sh
mkdir -p "$OUT"; : > "$OUT/harness.log"; : > "$PIDS"

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$ROLE" "$DESKTOP"; fi

cleanup() {
  log "cleanup: killing tracked pids"
  tac "$PIDS" | while read -r pid name; do kill -- "$pid" 2>/dev/null && log "  killed $name pid=$pid"; done
  sleep 1
  tac "$PIDS" | while read -r pid name; do kill -9 -- "$pid" 2>/dev/null; done
}
trap cleanup EXIT TERM INT

{ . /etc/os-release; echo "distro=$PRETTY_NAME"; echo "kernel=$(uname -r)"; echo "pipewire=$(pipewire --version 2>/dev/null | tail -1)"; } > "$OUT/facts.txt" 2>&1

# VA-API facts (the render node is passed in with --device /dev/dri)
if [ -e /dev/dri/renderD128 ]; then
  for drv in iHD i965; do LIBVA_DRIVER_NAME=$drv timeout 20 vainfo --display drm --device /dev/dri/renderD128 > "$OUT/vainfo-$drv.txt" 2>&1 || true; done
else echo "no /dev/dri" > "$OUT/vainfo-iHD.txt"; fi

mkdir -p -m 1777 /tmp/.X11-unix 2>/dev/null
start_audio
# Dedicated virtual microphone. viewer: a 440 Hz tone ("the call's own audio" the sharer's app will play back).
# sharer: silence (so the sharer's MIC track never carries the desktop tones; the 1000 Hz can only arrive via SHARE audio).
pw-cli create-node adapter '{ factory.name=support.null-audio-sink node.name=lab-mic node.description="lab mic" media.class=Audio/Sink audio.position=[FL FR] object.linger=true }' >/dev/null 2>&1
sleep 1
# Chromium hides *.monitor sources from enumerateDevices, so expose the mic sink's monitor as a real input source.
pactl load-module module-remap-source master=lab-mic.monitor source_name=labmic source_properties=device.description=LabMic >/dev/null 2>&1
pactl set-default-source labmic >/dev/null 2>&1
node $H/inside/make-tones.mjs /tmp/tones >/dev/null 2>&1
if [ "$ROLE" = viewer ]; then
  setsid bash -c 'while :; do pw-cat -p --target lab-mic /tmp/tones/t440.wav >/dev/null 2>&1; sleep 0.02; done' & track -$! viewer-mic-440-loop-pgid
fi
portal_monitor
# A real desktop has a keyring (Secret Service); without one Electron's safeStorage falls back to a hard-coded key and the app
# (rightly) shows an "Encryption at rest disabled" dialog. Start gnome-keyring with an unlocked login collection.
# (--login creates + unlocks the login collection from the stdin password with no prompt; a bare daemon would wait on a GUI prompt forever.)
echo -n labkeyring | gnome-keyring-daemon --login --components=secrets >"$OUT/keyring.log" 2>&1
gnome-keyring-daemon --start --components=secrets >>"$OUT/keyring.log" 2>&1
track "$(pgrep -u "$(id -u)" -x gnome-keyring-d | head -1)" gnome-keyring
sleep 1
. $H/inside/session-$DESKTOP.sh
start_session; RC=$?
echo "session_start_rc=$RC" >> "$OUT/facts.txt"
session_meta >> "$OUT/facts.txt" 2>/dev/null || true
if [ $RC -ne 0 ]; then log "session failed to start (rc=$RC)"; echo "SESSION_FAILED" > "$OUT/ready"; sleep infinity; fi

node $H/inside/lab-proxy.mjs "${DESKTOP_DIR:?}/dist" >"$OUT/lab-proxy.log" 2>&1 & track $! lab-proxy
wait_for 10 "lab proxy" curl -s -o /dev/null http://127.0.0.1:15174/

if [ "$ROLE" = sharer ]; then
  # Motion + a 1000 Hz tone from a process OUTSIDE the Cipherline tree: the "tone app" of scenario 2.
  LAB_TONE=${LAB_TONE:-1}
  # The addon's exclude mode treats "the same executable as the excluded process" as ours too (audio_capture_linux.cc safety net),
  # and both apps would be /electron/electron: run the tone app from a copy of the binary under another name (symlinked resources).
  mkdir -p /tmp/pat && cp -rs /electron/* /tmp/pat/ 2>/dev/null; rm -f /tmp/pat/electron; cp /electron/electron /tmp/pat/lab-pattern
  /tmp/pat/lab-pattern --no-sandbox --user-data-dir=/tmp/ud-pattern --enable-features=WebRTCPipeWireCapturer --autoplay-policy=no-user-gesture-required \
    $H/pattern-app --hz=1000 --tone=$LAB_TONE >"$OUT/pattern.log" 2>&1 & track $! pattern-app
  sleep 2
fi

# CDP: Chromium binds --remote-debugging-port to loopback only; forward it so the host-side driver can reach it.
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 >/dev/null 2>&1 & track $! cdp-forward

: > "$OUT/electron.log"
( env VITE_DEV_SERVER_URL=http://127.0.0.1:15174 VITE_API_HOST=127.0.0.1:13005 ${LAB_APP_ENV:-} \
  /electron/electron --no-sandbox --enable-logging=stderr --remote-debugging-port=9222 --user-data-dir=/tmp/ud-app --password-store=gnome-libsecret ${LAB_APP_ARGS:-} "$DESKTOP_DIR" \
  >>"$OUT/electron.log" 2>&1; echo "[lab] electron exited rc=$?" >> "$OUT/electron.log" ) &
track $! cipherline-electron
log "app started (pid $!)"
echo READY > "$OUT/ready"
wait
