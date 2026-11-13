#!/usr/bin/env bash
# Runs INSIDE the cipherline-pw-test container (see run.sh). Brings up a PipeWire desktop-audio stack,
# checks isSupported() at each stage of it coming up, then runs capture-test.mjs.
set -u
# wireplumber (the session manager that links playback streams to the sink) needs a session bus.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0"; fi
export PATH=/opt/node/bin:$PATH
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export ADDON=/addon/audio_capture.node
export OUT=/out

supported() { node -e "const a=require('$ADDON');console.log(a.isSupported())"; }
step() { printf '\n=== %s\n' "$*"; }

run() {
  step "stage 1: libpipewire present, NO daemon running -> isSupported() must be false"
  echo "isSupported() = $(supported 2>/dev/null)"

  step "stage 2: daemon running, NO audio sink / session manager (a screen-capture-only PipeWire) -> must be false"
  pipewire >/tmp/pipewire.log 2>&1 &
  sleep 1.5
  echo "isSupported() = $(supported 2>/dev/null)"

  step "stage 3: + wireplumber, pipewire-pulse and a sink -> must be true"
  wireplumber >/tmp/wireplumber.log 2>&1 &
  pipewire-pulse >/tmp/pipewire-pulse.log 2>&1 &
  sleep 2
  pw-cli create-node adapter '{ factory.name=support.null-audio-sink node.name=cipherline-test-sink node.description="test sink" media.class=Audio/Sink audio.position=[FL FR] node.driver=true object.linger=true }' >/dev/null
  sleep 2
  echo "isSupported() = $(supported 2>/dev/null)"
  pw-cli ls Node 2>/dev/null | grep -c 'media.class = "Audio/Sink"' | sed 's/^/audio sinks: /'

  step "tones"
  node /h/tones.mjs /tmp/tones

  if [ "${APP_ONLY:-0}" = 1 ]; then
    step "per-application audio tests (app-test.mjs; the compiled main-process rules are mounted at /js)"
    node /h/app-test.mjs
    rc=$?
    echo "app-test exit code: $rc"
    return $rc
  fi
  step "capture tests"
  node /h/capture-test.mjs
  rc=$?
  echo "capture-test exit code: $rc"
  return $rc
}

# APP_ONLY=1 (run.sh's second container) runs app-test.mjs instead of capture-test.mjs and logs to run-app.log.
if [ "${APP_ONLY:-0}" = 1 ]; then LOG=/out/run-app.log; else LOG=/out/run.log; fi
set -o pipefail   # the container's exit code is the test's, not tee's
run 2>&1 | tee "$LOG"
