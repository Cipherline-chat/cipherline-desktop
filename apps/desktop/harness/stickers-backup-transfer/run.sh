#!/usr/bin/env bash
# run.sh <cdp-port> <action.mjs> <screenshot-label|-> [args...]   (S defaults to the harness scratch dir)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export S="${S:-/tmp/claude-1001/-home-antigravity-Cipherline/c1b8e2a2-0630-4d7c-a796-f35a1b8c396d/scratchpad/sbt}"
P="$1"; shift
exec timeout "${STEP_TIMEOUT:-600}" node "$HERE/pw.mjs" "$P" "$HERE/step-do.mjs" "$@"
