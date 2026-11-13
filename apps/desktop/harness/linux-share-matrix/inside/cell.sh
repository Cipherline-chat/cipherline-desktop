#!/usr/bin/env bash
# One matrix cell (distro x session), INSIDE the container. Usage: cell.sh <session>   (sway|x11|kde|gnome)
# Everything it starts is recorded in $OUT/pids.txt and killed by exact PID on exit.
set -u
SESSION=${1:?session}
H=/h
source $H/inside/common.sh
mkdir -p "$OUT"; : > "$OUT/harness.log"; : > "$PIDS"

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$SESSION"; fi

cleanup() {
  log "cleanup: killing tracked pids"
  tac "$PIDS" | while read -r pid name; do kill -- "$pid" 2>/dev/null && log "  killed $name pid=$pid"; done
  sleep 1
  tac "$PIDS" | while read -r pid name; do kill -9 -- "$pid" 2>/dev/null; done
}
trap cleanup EXIT

# ── facts about this distro ──
{
  . /etc/os-release; echo "distro=$PRETTY_NAME"
  echo "kernel=$(uname -r)"
  echo "pipewire=$(pipewire --version 2>/dev/null | tail -1)"
  echo "wireplumber=$(wireplumber --version 2>/dev/null | tail -1)"
  echo "portal_frontend=$(findbin xdg-desktop-portal | xargs -r -I{} sh -c '{} --version 2>&1 | head -1')"
} > "$OUT/facts.txt" 2>&1
log "cell: session=$SESSION"

# ── VA-API facts (before any session; the render node is passed in with --device /dev/dri) ──
if [ -e /dev/dri/renderD128 ]; then
  for drv in iHD i965 radeonsi nouveau; do
    LIBVA_DRIVER_NAME=$drv timeout 20 vainfo --display drm --device /dev/dri/renderD128 > "$OUT/vainfo-$drv.txt" 2>&1 || true
  done
else echo "no /dev/dri" > "$OUT/vainfo-iHD.txt"; fi

mkdir -p -m 1777 /tmp/.X11-unix 2>/dev/null
start_audio
portal_monitor
. $H/inside/session-$SESSION.sh
start_session; RC=$?
echo "session_start_rc=$RC" >> "$OUT/facts.txt"
session_meta >> "$OUT/facts.txt" 2>/dev/null || true
if [ $RC -ne 0 ]; then log "session failed to start (rc=$RC)"; echo '{"session_failed":true}' > "$OUT/app-default.json"; exit 0; fi

node /h-audio/tones.mjs /tmp/tones >/dev/null 2>&1
# A 1000 Hz tone from a process OUTSIDE every app tree, looping for the life of the cell. The Electron audio test needs a
# "someone else's audio" to keep while it excludes itself. Own session, so the whole loop dies with one exact group kill.
setsid bash -c 'while :; do pw-cat -p /tmp/tones/t1000.wav >/dev/null 2>&1; sleep 0.05; done' & TONE_PGID=$!; track -$TONE_PGID external-tone-loop-pgid

# If the ScreenCast portal never came up (KDE's backend hangs without a Plasma session), the capture stages can only wait out
# their timeouts: record that as the finding and run the stages that do not need a portal.
if grep -q '^portal_screencast_available=0' "$OUT/facts.txt" && [ "$SESSION" != x11 ]; then
  log "ScreenCast portal unavailable in this session: skipping sources/capture stages"
  export MATRIX_TESTS_PORTAL_DOWN=env,addon,webgl,gpu,audio
  export MATRIX_CELL_TIMEOUT=100     # an Electron that hangs at startup next to a wedged portal must not hold the matrix for 15 minutes
  echo "capture_stages_skipped=portal ScreenCast interface never appeared on the bus" >> "$OUT/facts.txt"
fi

run_electron() {   # run_electron <name> [env...]
  local name=$1; shift
  : > "$OUT/phases-$name.log"
  env "$@" CELL_OUT="$OUT/app-$name.json" PHASE_LOG="$OUT/phases-$name.log" ADDON=/addon/audio_capture.node ADDON_HOST=/addon-host/audio_capture.node TONES=/tmp/tones \
    MATRIX_W=${MATRIX_W:-1280} MATRIX_H=${MATRIX_H:-720} \
    timeout -k 5 ${MATRIX_CELL_TIMEOUT:-420} /electron/electron --no-sandbox --user-data-dir="$HOME/ud-$name" $EXTRA_ARGS $H/app \
    >"$OUT/electron-$name.log" 2>&1 &
  local p=$!; track $p "electron-$name"
  wait $p; echo "electron-$name exit=$?" >> "$OUT/facts.txt"
}

# Run 1 ("default"): exactly the app's switches; the real capture path (portal / X11) -> screen-sourced encode, window capture, audio.
#   NO fake-device flags here: --use-fake-device-for-media-stream replaces getDisplayMedia with a 20 fps fake generator.
# Run 2 ("sweep"): the same switches, codec sweep on a synthetic 1080p60 source (needs a fake camera so getStats exposes encoderImplementation).
# Run 3 ("hwenc"): CIPHERLINE_LINUX_HW_ENCODE=1 forced, same sweep. NOTE (2026-11-04): hardware encode is ON by default now, so
#   run 1 ("default") is the app's real default, run 2 ("sweep") pins CIPHERLINE_LINUX_HW_ENCODE=0 (the software baseline) and
#   run 3 is the explicit-on twin of run 1.
# MATRIX_ONLY_HWENC=1: only the hardware-encode run (experiments with MATRIX_EXTRA_FEATURES), nothing else.
if [ "${MATRIX_ONLY_HWENC:-0}" = 1 ]; then
  EXTRA_ARGS="--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --enable-logging=stderr --vmodule=*vaapi*=2,*gpu_video_encode*=2,*video_encode_accelerator*=2 ${MATRIX_HWENC_EXTRA_ARGS:-}" \
    run_electron hwenc MATRIX_RUN=hwenc CIPHERLINE_LINUX_HW_ENCODE=1 MATRIX_TESTS=env,gpu,encode-canvas MATRIX_VERBOSE=1
  log "only-hwenc mode done"; exit 0
fi
EXTRA_ARGS="${MATRIX_DEFAULT_EXTRA_ARGS:-}" run_electron default MATRIX_RUN=default ${MATRIX_TESTS_PORTAL_DOWN:+MATRIX_TESTS=$MATRIX_TESTS_PORTAL_DOWN}
# Run 1b ("flows"): what ONE user decision costs in desktop choosers, the app as it was (BEFORE: list, capture, applyConstraints per fps
# change, list + capture again to change source) next to the app as it is (AFTER: one capture, sender-side retunes, a clone for a
# republish, one more capture to change source). Counted from ScreenCast.Start per step - see app/main.js stages flow-before / flow-after.
# Not on X11 (no portal), not when the portal never came up, not in an experiment run (MATRIX_TESTS set by hand).
if [ -z "${MATRIX_TESTS_PORTAL_DOWN:-}" ] && [ "$SESSION" != x11 ] && [ -z "${MATRIX_TESTS:-}" ]; then
  EXTRA_ARGS="${MATRIX_DEFAULT_EXTRA_ARGS:-}" run_electron flows MATRIX_RUN=flows MATRIX_TESTS=env,flow
fi
analyze_portal() {
  node $H/inside/analyze-portal.mjs "$OUT/dbus-portal.log" "$OUT/phases-default.log" > "$OUT/portal.json" 2>"$OUT/portal-analyze.err" || true
  [ -s "$OUT/phases-flows.log" ] && { node $H/inside/analyze-portal.mjs "$OUT/dbus-portal.log" "$OUT/phases-flows.log" > "$OUT/portal-flows.json" 2>>"$OUT/portal-analyze.err" || true; }
}
[ "${MATRIX_QUICK:-0}" = 1 ] && { analyze_portal; log quick; exit 0; }
FAKE="--use-fake-device-for-media-stream --use-fake-ui-for-media-stream"
EXTRA_ARGS="$FAKE" run_electron sweep MATRIX_RUN=sweep CIPHERLINE_LINUX_HW_ENCODE=0 MATRIX_TESTS=env,gpu,encode-canvas
# diagnostics only (NOT app switches): surface VA-API / GPU video-encode decisions in the log
EXTRA_ARGS="$FAKE --enable-logging=stderr --vmodule=*vaapi*=2,*gpu_video_encode*=2,*video_encode_accelerator*=2 ${MATRIX_HWENC_EXTRA_ARGS:-}" \
  run_electron hwenc MATRIX_RUN=hwenc CIPHERLINE_LINUX_HW_ENCODE=1 MATRIX_TESTS=env,gpu,encode-canvas MATRIX_VERBOSE=1

# ── plain-node addon + PipeWire exclusion suite (kills the pipewire daemon in its last scenario, so it goes last) ──
[ "${MATRIX_QUICK:-0}" = 1 ] && { log "quick mode: skipping hwenc run + audio suite"; exit 0; }
kill -- -$TONE_PGID 2>/dev/null; pkill -x pw-cat 2>/dev/null; sleep 0.5   # the suite plays its own tones
log "addon exclusion suite (plain node)"
mkdir -p "$OUT/audio"
ADDON=/addon/audio_capture.node OUT="$OUT/audio" timeout 240 node /h-audio/capture-test.mjs > "$OUT/audio/capture-test.log" 2>&1
echo "audio_suite_exit=$?" >> "$OUT/facts.txt"

# ── fold the D-Bus traffic against the phase markers ──
analyze_portal
log "cell done"
