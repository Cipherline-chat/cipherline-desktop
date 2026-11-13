#!/usr/bin/env bash
# Build audio_capture.node against the OLDEST glibc the matrix covers (Ubuntu 22.04: glibc 2.35) so one binary loads on every
# distro. `npm run rebuild-native` on a recent dev box links the host's newer glibc (measured: an Ubuntu 24.04 build needs
# GLIBC_2.38 and fails to dlopen on Ubuntu 22.04 and Debian 12), which is a property of WHERE it is built, not of the source.
# The addon is N-API and loads PipeWire/X11 with dlopen(), so the only system dependency is libc/libstdc++.
#   build-addon.sh <outdir>
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/../.." && pwd)"
OUTDIR="$(mkdir -p "${1:?outdir}" && cd "$1" && pwd)"
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
NODE_VER="$(node -p 'process.versions.node')"
HEADERS="$HOME/.cache/node-gyp/$NODE_VER"
[ -d "$HEADERS/include/node" ] || { echo "no node headers at $HEADERS (run: npx node-gyp install)"; exit 2; }
docker run --rm -v "$DESKTOP/src-native":/w/src-native:ro -v "$DESKTOP/binding.gyp":/w/binding.gyp:ro \
  -v "$HEADERS":/headers:ro -v "$NODE_DIR":/node:ro -v "$OUTDIR":/out ubuntu:22.04 bash -c '
    set -e
    apt-get update -qq && apt-get install -y -qq --no-install-recommends g++ make python3 ca-certificates >/dev/null
    cp -r /w /b && cd /b
    /node/bin/node /node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=/headers > /out/build.log 2>&1
    cp build/Release/audio_capture.node /out/audio_capture.node
    chown '"$(id -u):$(id -g)"' /out/audio_capture.node /out/build.log'
echo "built: $OUTDIR/audio_capture.node (max glibc: $(grep -ao 'GLIBC_[0-9.]*' "$OUTDIR/audio_capture.node" | sort -u -V | tail -1))"
