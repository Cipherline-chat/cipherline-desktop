#!/usr/bin/env bash
# build.sh <before|after>
#
# Builds, from ONE source tree, everything the channel-key harness runs:
#   out/<mode>/shared     packages/shared compiled (the API's @cipherline/shared)
#   out/<mode>/api        apps/api compiled with tsc (decorator metadata intact)
#   out/<mode>/client.cjs the headless device (client.ts) bundled with esbuild
#                         against that tree's apps/desktop/src + electron
#
#   after  = this checkout (the tree this script lives in)
#   before = `git archive $CKH_BASE` of this repo (default: the merge-base with
#            origin/staging), extracted under out/src-before — read-only git.
#
# node_modules are never installed: the extracted tree gets symlinks to the
# MAIN checkout's installed trees (same as every worktree).
set -euo pipefail
MODE="${1:?usage: build.sh <before|after>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
MAIN_NM="${CKH_MAIN_NODE_MODULES:-/home/antigravity/Cipherline}"
OUT="$HERE/out/$MODE"
mkdir -p "$OUT"

if [[ "$MODE" == "after" ]]; then
  ROOT="$REPO"
else
  BASE="${CKH_BASE:-$(git -C "$REPO" merge-base HEAD origin/staging)}"
  ROOT="$HERE/out/src-before"
  if [[ ! -f "$ROOT/.ckh-base" || "$(cat "$ROOT/.ckh-base")" != "$BASE" ]]; then
    rm -rf "$ROOT"; mkdir -p "$ROOT"
    git -C "$REPO" archive "$BASE" apps/api apps/desktop/src apps/desktop/electron packages/shared | tar -x -C "$ROOT"
    echo "$BASE" > "$ROOT/.ckh-base"
  fi
  ln -sfn "$MAIN_NM/node_modules" "$ROOT/node_modules"
  ln -sfn "$MAIN_NM/apps/api/node_modules" "$ROOT/apps/api/node_modules"
  ln -sfn "$MAIN_NM/apps/desktop/node_modules" "$ROOT/apps/desktop/node_modules"
fi
echo "[build:$MODE] source tree: $ROOT"
TSC="$MAIN_NM/node_modules/.bin/tsc"

# 1. shared
rm -rf "$OUT/shared"
"$TSC" -p "$ROOT/packages/shared/tsconfig.json" --outDir "$OUT/shared"

# 2. API
rm -rf "$OUT/api"
cat > "$OUT/api-tsconfig.json" <<EOF
{
  "extends": "$ROOT/apps/api/tsconfig.build.json",
  "compilerOptions": {
    "outDir": "$OUT/api",
    "rootDir": "$ROOT/apps/api/src",
    "incremental": false,
    "sourceMap": false,
    "declaration": false,
    "baseUrl": "$ROOT/apps/api",
    "paths": { "@cipherline/shared": ["$OUT/shared/index.d.ts"] }
  },
  "include": ["$ROOT/apps/api/src/**/*"],
  "exclude": ["$ROOT/apps/api/src/**/*spec.ts", "$ROOT/apps/api/src/**/testing/**"]
}
EOF
( cd "$ROOT/apps/api" && "$TSC" -p "$OUT/api-tsconfig.json" ) || echo "[build:$MODE] tsc reported type errors (emit continues)"
test -f "$OUT/api/main.js" || { echo "[build:$MODE] API build produced no main.js"; exit 1; }
mkdir -p "$OUT/api/node_modules/@cipherline/shared"
cp -r "$OUT/shared/." "$OUT/api/node_modules/@cipherline/shared/"
echo '{"name":"@cipherline/shared","main":"index.js"}' > "$OUT/api/node_modules/@cipherline/shared/package.json"

# 3. client bundle
CKH_ROOT="$ROOT" CKH_OUT="$OUT/client.cjs" CKH_NODE_MODULES="$MAIN_NM" node "$HERE/bundle.mjs"
echo "[build:$MODE] done"
