#!/usr/bin/env bash
# Assemble the tester bundle (sources + MIT headers + run.sh) as cl-native-share-test.tar.gz.
#   bash make-bundle.sh <dir with ffnvcodec/> <dir with va/ pipewire-0.3/ spa-0.2/> [out dir]
# The header trees come from nv-codec-headers (MIT), libva (MIT), libpipewire/libspa (MIT): e.g. `dpkg -x` of libffmpeg-nvenc-dev,
# libva-dev, libpipewire-0.3-dev, libspa-0.2-dev (see the Makefile header comment). Nothing is compiled here.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"; SE="$HERE/.."
NV="${1:?dir containing ffnvcodec/}"; OTHER="${2:?dir containing va/ pipewire-0.3/ spa-0.2/}"; OUT="${3:-$PWD}"
B="$(mktemp -d)/cl-native-share-test"; mkdir -p "$B/include" "$B/licenses"
cp "$SE"/{encoder.h,enc_vaapi.c,enc_nvenc.c,enc_pcm.c,share-encoder-helper.c,share-capture.c,share-capture.h,capture.c,capture.h,portal.c,portal.h,dbus_mini.c,dbus_mini.h,Makefile} "$B/"
cp "$HERE/run.sh" "$B/run.sh"; chmod +x "$B/run.sh"
cp -r "$NV/ffnvcodec" "$B/include/"; cp -r "$OTHER/va" "$OTHER/pipewire-0.3" "$OTHER/spa-0.2" "$B/include/"
cat > "$B/licenses/README.txt" <<'EOF'
Bundled headers, all MIT: nv-codec-headers (FFmpeg project, ffnvcodec/), libva (Intel, va/), PipeWire (pipewire-0.3/, spa-0.2/).
Nothing here is installed; the helper is compiled from these headers and dlopen()s libcuda, libnvidia-encode, libpipewire and links libva at run time.
EOF
tar -czf "$OUT/cl-native-share-test.tar.gz" -C "$(dirname "$B")" cl-native-share-test
echo "wrote $OUT/cl-native-share-test.tar.gz"
