#!/usr/bin/env bash
# Assemble the AMD/Intel (VA-API) tester bundle: cl-native-share-vaapi-test.tar.gz
#   bash make-bundle.sh [out dir]        (default: current directory)
# Self-contained: the helper sources, the Makefile and the MIT headers vendored in ../third_party (libva, nv-codec-headers, PipeWire/SPA).
# Nothing is compiled here. The tester unpacks it anywhere and runs `bash run.sh` (results land NEXT TO the tarball).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"; SE="$HERE/.."
OUT="${1:-$PWD}"
B="$(mktemp -d)/cl-native-share-vaapi-test"; mkdir -p "$B/third_party"
for f in pacer.h encoder.h enc_vaapi.c enc_nvenc.c enc_pcm.c share-encoder-helper.c share-capture.c share-capture.h capture.c capture.h portal.c portal.h dbus_mini.c dbus_mini.h Makefile; do cp "$SE/$f" "$B/"; done
cp -r "$SE/third_party/include" "$SE/third_party"/LICENSE.* "$B/third_party/"
cp "$HERE/run.sh" "$B/run.sh"; chmod +x "$B/run.sh"
cat > "$B/README.txt" <<'EOF'
Cipherline AMD / Intel hardware screen share test.
  tar xzf cl-native-share-vaapi-test.tar.gz && cd cl-native-share-vaapi-test && bash run.sh            (or: bash run.sh capture)
Needs gcc + make (nothing is installed, no root). report.json is written NEXT TO the tarball. Read the header of run.sh for exit codes.
Headers are bundled and all MIT (libva, nv-codec-headers, PipeWire/SPA); see third_party/LICENSE.*. The helper dlopen()s libva and libpipewire at run time.
EOF
tar -czf "$OUT/cl-native-share-vaapi-test.tar.gz" -C "$(dirname "$B")" cl-native-share-vaapi-test
echo "wrote $OUT/cl-native-share-vaapi-test.tar.gz"
