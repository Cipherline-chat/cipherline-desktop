#!/usr/bin/env bash
# Prove the PipeWire consumer (format negotiation, SHM, stride, pacing, idle keep-alive, size change, stream end) against the REAL
# PipeWire daemon, using the BGRx test producer pw-test-source.c. No GPU, no compositor.
#   bash run-pwtest.sh      needs the built helper (make -C ../../native/share-encoder ...) and PW_INC=<dir with pipewire-0.3/ spa-0.2/>
set -eu
HERE=$(cd "$(dirname "$0")" && pwd); SE=$HERE/../../native/share-encoder
OUT=${OUT:-/tmp/native-share-pwtest-out}; TOOLS=${TOOLS:-/tmp/native-share-pwtools}
PW_INC=${PW_INC:-/usr/include}
rm -rf "$OUT"; mkdir -p "$OUT" "$TOOLS"; chmod 777 "$OUT"
gcc -O2 -I"$PW_INC/pipewire-0.3" -I"$PW_INC/spa-0.2" "$HERE/pw-test-source.c" -o "$TOOLS/pw-test-source" -ldl
docker run --rm --user tester -e CL_CAP_DEBUG -e BACKEND -e MAXW -e MAXH -e FPS \
  -v "$SE/build:/helper:ro" -v "$TOOLS:/tools:ro" -v "$HERE/../linux-e2e-lab:/lab:ro" -v "$HERE/inside-pwtest.sh:/t.sh:ro" -v "$OUT:/out" \
  cle2e-desktop bash /t.sh || true
python3 -I "$HERE/analyze.py" "$OUT"
