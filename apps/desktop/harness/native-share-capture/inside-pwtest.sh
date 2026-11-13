#!/usr/bin/env bash
# INSIDE cle2e-desktop, no compositor/GPU: the real PipeWire daemon + pw-test-source (a BGRx producer that behaves like a compositor's
# screencast: colour script, 3 s of NO frames, a mid-stream size renegotiation, then the stream disappears) captured by the helper's
# PipeWire consumer through --pw-node (portal-less dev path). The portal client is proven separately (inside.sh / dbus_mini_test).
set -u
export H=/lab OUT=/out
mkdir -p "$OUT"; source $H/inside/common.sh
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- bash "$0" "$@"; fi
: > "$PIDS"
start_audio >/dev/null 2>&1
/tools/pw-test-source > "$OUT/producer.log" 2>&1 &
PP=$!
sleep 1.5
NODE=$(pw-dump | python3 -c 'import json,sys
for o in json.load(sys.stdin):
    p=(o.get("info") or {}).get("props") or {}
    if p.get("node.name")=="cl-test-screen": print(o["id"]); break')
echo "node=$NODE" > "$OUT/node.txt"
[ -n "$NODE" ] || { echo "no producer node"; exit 3; }
sleep 22 | /helper/share-encoder-helper --capture --backend ${BACKEND:-pcm} --width ${MAXW:-640} --height ${MAXH:-360} --fps ${FPS:-30} --pw-node $NODE > "$OUT/au.bin" 2> "$OUT/helper.err"
echo "helper_exit=${PIPESTATUS[1]}" > "$OUT/exit.txt"
kill $PP 2>/dev/null
