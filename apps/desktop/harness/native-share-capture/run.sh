#!/usr/bin/env bash
# Prove the native capture path against a real portal + PipeWire without a GPU (pcm software backend).
#   bash run.sh        needs a built helper (make -C ../../native/share-encoder, see its Makefile for VA_INC/PW_INC/NV_INC)
# env: STOP_MODE=stop|disable|killportal, MAXW/MAXH/FPS, LAB_W/LAB_H/LAB_HZ (the compositor output mode), BACKEND
set -eu
HERE=$(cd "$(dirname "$0")" && pwd); SE=$HERE/../../native/share-encoder
OUT=${OUT:-/tmp/native-share-capture-out}; rm -rf "$OUT"; mkdir -p "$OUT"; chmod 777 "$OUT"
[ -x "$SE/build/share-encoder-helper" ] || { echo "build the helper first: make -C $SE"; exit 2; }
docker run --rm --user tester -e STOP_MODE -e MAXW -e MAXH -e FPS -e LAB_W -e LAB_H -e LAB_HZ -e BACKEND -e G_MESSAGES_DEBUG -e XDPW_DEBUG -e LAB_RENDERER \
  -v "$SE/build:/helper:ro" -v "$HERE/../linux-e2e-lab:/lab:ro" -v "$HERE/inside.sh:/inside.sh:ro" -v "$OUT:/out" \
  cle2e-desktop bash /inside.sh || true
python3 -I "$HERE/analyze.py" "$OUT"
