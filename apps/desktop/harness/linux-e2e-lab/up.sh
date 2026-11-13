#!/usr/bin/env bash
# Brings the lab up: image, API build, app build, server stack. Idempotent. Tear down with down.sh.
#   harness/linux-e2e-lab/up.sh            # everything
#   REBUILD=1 up.sh                        # force the API + app rebuild
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"; mkdir -p "$OUT"
say() { printf '\n== %s\n' "$*"; }

# ── secrets (random per checkout, gitignored, never printed) ──
if [ ! -f "$OUT/lab.env" ]; then
  r() { head -c 33 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  umask 077
  cat > "$OUT/lab.env" <<EOF
CLE2E_PG_PASS=$(r 24)
CLE2E_MINIO_PASS=$(r 24)
CLE2E_LK_KEY=lk$(r 10)
CLE2E_LK_SECRET=$(r 40)
CLE2E_JWT=$(r 48)
CLE2E_JWT2=$(r 48)
EOF
fi
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
grep -q '^CLE2E_NODE_DIR=' "$OUT/lab.env" || echo "CLE2E_NODE_DIR=$NODE_DIR" >> "$OUT/lab.env"
sed -i "s|^CLE2E_NODE_DIR=.*|CLE2E_NODE_DIR=$NODE_DIR|" "$OUT/lab.env"

# ── image ──
if ! docker image inspect cle2e-desktop >/dev/null 2>&1; then
  say "building image cle2e-desktop (first time: several minutes)"
  docker build -q -t cle2e-desktop -f "$HERE/docker/desktop.Dockerfile" "$HERE/docker"
fi

# ── API build (tsc from this tree) ──
if [ ! -f "$OUT/api/main.js" ] || [ "${REBUILD:-0}" = 1 ]; then say "building the API"; "$HERE/build-api.sh"; fi

# ── the real app: renderer (vite) with VITE_API_HOST at the lab API + dist-electron (tsc) + native addon ──
LAB_API_HOST=127.0.0.1:13005
STAMP="$OUT/app-build.stamp"
if [ ! -f "$DESKTOP/dist/index.html" ] || [ ! -f "$DESKTOP/dist-electron/entry.js" ] || [ ! -f "$STAMP" ] \
   || [ "$(cat "$STAMP")" != "$LAB_API_HOST" ] || [ "${REBUILD:-0}" = 1 ]; then
  say "building the desktop app (VITE_API_HOST=$LAB_API_HOST)"
  ( cd "$DESKTOP" && VITE_API_HOST=$LAB_API_HOST npx vite build >"$OUT/vite-build.log" 2>&1 && npx tsc -p tsconfig.electron.json >"$OUT/tsc-electron.log" 2>&1 ) \
    || { echo "app build failed, see $OUT/vite-build.log / tsc-electron.log"; exit 1; }
  echo "$LAB_API_HOST" > "$STAMP"
fi
if [ ! -f "$DESKTOP/build/Release/audio_capture.node" ]; then say "building the native addon (npm run rebuild-native)"; ( cd "$DESKTOP" && npm run rebuild-native >"$OUT/rebuild-native.log" 2>&1 ); fi

# ── Electron binary (43.x, from node_modules or the download cache) ──
EV="$(node -p "require('$DESKTOP/package.json').devDependencies.electron")"
ELECTRON_DIST="$DESKTOP/node_modules/electron/dist"
if [ ! -x "$ELECTRON_DIST/electron" ]; then
  ELECTRON_DIST="$OUT/electron-dist-$EV"
  if [ ! -x "$ELECTRON_DIST/electron" ]; then
    ZIP="$(ls ~/.cache/electron/*/electron-v$EV-linux-x64.zip 2>/dev/null | head -1)"
    [ -n "$ZIP" ] || { echo "Electron $EV is neither in node_modules/electron/dist nor in ~/.cache/electron"; exit 2; }
    mkdir -p "$ELECTRON_DIST" && unzip -q -o "$ZIP" -d "$ELECTRON_DIST"
  fi
fi
grep -q '^CLE2E_ELECTRON_DIST=' "$OUT/lab.env" && sed -i "s|^CLE2E_ELECTRON_DIST=.*|CLE2E_ELECTRON_DIST=$ELECTRON_DIST|" "$OUT/lab.env" || echo "CLE2E_ELECTRON_DIST=$ELECTRON_DIST" >> "$OUT/lab.env"
echo "electron $EV at $ELECTRON_DIST"

# ── server stack ──
say "starting the server stack (compose project cle2e)"
docker compose -f "$HERE/compose.yml" --env-file "$OUT/lab.env" up -d
for _ in $(seq 1 120); do curl -s -o /dev/null "http://127.0.0.1:13005/" && break; sleep 1; done
curl -s -o /dev/null "http://127.0.0.1:13005/" || { echo "API did not come up"; docker logs --tail 40 cle2e-api; exit 1; }
echo "lab API up on http://127.0.0.1:13005"
