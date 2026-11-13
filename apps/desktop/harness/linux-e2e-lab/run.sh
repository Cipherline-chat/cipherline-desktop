#!/usr/bin/env bash
# Linux e2e lab: two REAL Cipherline desktop clients in a call over an isolated local server stack.
#
#   harness/linux-e2e-lab/run.sh [desktop=sway|x11|kde|gnome] [scenario ...]     e.g.  run.sh desktop=sway share-1080-90 share-audio
#   harness/linux-e2e-lab/up.sh        bring the server stack + builds up (run.sh does it if needed)
#   harness/linux-e2e-lab/down.sh      tear everything down (clients, compose project, network, image)
#
# Scenarios (all by default): share-1080-90 share-source-90 share-audio change-source portal-chooser window-share annotation
#                             encode-stepdown webgl-onboarding vaapi
# Env: LAB_CPUS (sharer container --cpus, default 6)  LAB_GPU=0 (no /dev/dri)  LAB_RESULTS (output dir, default: session scratchpad linux-e2e/)
# Output: $LAB_RESULTS/results-<desktop>.json + results-<desktop>.md + shots/*.png. Nothing is printed that contains a password.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_SESSION=sway; SCEN=()
for a in "$@"; do case "$a" in desktop=*) DESKTOP_SESSION="${a#desktop=}" ;; *) SCEN+=("$a") ;; esac; done
curl -s -o /dev/null -m 3 http://127.0.0.1:13005/ || "$HERE/up.sh"
cleanup() { docker rm -f cle2e-sharer cle2e-viewer >/dev/null 2>&1 || true; }
trap cleanup EXIT
node "$HERE/driver/run.mjs" "$DESKTOP_SESSION" "${SCEN[@]}"
