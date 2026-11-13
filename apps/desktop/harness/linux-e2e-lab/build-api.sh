#!/usr/bin/env bash
# Builds the API from THIS tree (tsc, decorator metadata intact) into out/api, plus the compiled @cipherline/shared it
# imports. Same recipe as harness/channel-keys/build.sh (steps 1-2). node_modules are never installed: the API container
# mounts the main checkout's installed trees read-only (NODE_PATH).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
MAIN_NM="${CLE2E_MAIN_NODE_MODULES:-/home/antigravity/Cipherline}"
OUT="$HERE/out"; mkdir -p "$OUT"
TSC="$MAIN_NM/node_modules/.bin/tsc"
rm -rf "$OUT/shared" "$OUT/api"
"$TSC" -p "$ROOT/packages/shared/tsconfig.json" --outDir "$OUT/shared"
cat > "$OUT/api-tsconfig.json" <<EOT
{
  "extends": "$ROOT/apps/api/tsconfig.build.json",
  "compilerOptions": {
    "outDir": "$OUT/api", "rootDir": "$ROOT/apps/api/src", "incremental": false, "sourceMap": false, "declaration": false,
    "baseUrl": "$ROOT/apps/api", "paths": { "@cipherline/shared": ["$OUT/shared/index.d.ts"] }
  },
  "include": ["$ROOT/apps/api/src/**/*"],
  "exclude": ["$ROOT/apps/api/src/**/*spec.ts", "$ROOT/apps/api/src/**/testing/**"]
}
EOT
( cd "$ROOT/apps/api" && "$TSC" -p "$OUT/api-tsconfig.json" ) || echo "[build-api] tsc reported type errors (emit continues; the shared env may lag the branch)"
test -f "$OUT/api/main.js" || { echo "[build-api] no main.js"; exit 1; }
mkdir -p "$OUT/api/node_modules/@cipherline/shared"
cp -r "$OUT/shared/." "$OUT/api/node_modules/@cipherline/shared/"
echo '{"name":"@cipherline/shared","main":"index.js"}' > "$OUT/api/node_modules/@cipherline/shared/package.json"
echo "[build-api] ok: $OUT/api/main.js"
