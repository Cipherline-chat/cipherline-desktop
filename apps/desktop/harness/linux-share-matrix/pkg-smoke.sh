#!/usr/bin/env bash
# Called by run.sh (PKG=1) once per distro: pkg-smoke.sh <distro> <image> <outRoot> <nodeDir> <electronDist>
# Launch / smoke check of the staging AppImage and .deb. They are downloaded by the caller into $PKG_DIR (a NEW empty
# scratch directory):
#   https://updates.cipherline.chat/Cipherline-1.0.24-staging.196.AppImage
#   https://updates.cipherline.chat/cipherline_1.0.24-staging.196_amd64.deb
set -u
D=$1; IMG=$2; OUT_ROOT=$3; NODE_DIR=$4
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="${PKG_DIR:?set PKG_DIR to the directory holding the staging AppImage and .deb}"
for KIND in appimage deb; do
  CELL="$OUT_ROOT/$D/pkg-$KIND"; rm -rf "$CELL"; mkdir -p "$CELL"; chmod 777 "$CELL"
  echo "== packaged $KIND on $D"
  NAME="clm-$D-pkg-$KIND"
  timeout 300 docker run --rm --init --name "$NAME" --network clm-internal --user 1001:1001 --shm-size=1g --memory=3g --cpus=4 \
    -v "$NODE_DIR":/node:ro -v "$HERE":/h:ro -v "$PKG_DIR":/pkg:ro -v "$CELL":/out -e OUT=/out \
    "$IMG" bash /h/inside/pkg-cell.sh "$KIND" > "$CELL/container.log" 2>&1
  docker rm -f "$NAME" >/dev/null 2>&1 || true
done
