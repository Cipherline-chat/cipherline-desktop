#!/usr/bin/env bash
# Discord import final mapping pass: the ISOLATED API for the real-app check
# (never the shared dev stack, staging or prod).
#
#   api.sh build   compile packages/shared + apps/api from THIS tree into $OUT
#   api.sh run     run it on 127.0.0.1:$PORT against the throwaway containers
#                  cl-dif-pg (DB clif), cl-dif-redis (127.0.0.1:16491) and
#                  cl-dif-minio (127.0.0.1:9191), with the loopback MOCK Discord
#                  OAuth provider ($MOCK, harness/discord-claims-mock.mjs)
#
# Containers (throwaway, no volumes):
#   docker run -d --name cl-dif-pg -e POSTGRES_PASSWORD=x -p 127.0.0.1:55581:5432 postgres:15-alpine
#   docker exec cl-dif-pg psql -U postgres -c "CREATE DATABASE clif"
#   docker run -d --name cl-dif-redis -p 127.0.0.1:16491:6379 redis:7-alpine redis-server --save "" --appendonly no
#   docker run -d --name cl-dif-minio -e MINIO_ROOT_USER=clif -e MINIO_ROOT_PASSWORD=cliffcliffcliff -p 127.0.0.1:9191:9000 minio/minio:latest server /data
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
MAIN="${MAIN_NODE_MODULES:-/home/antigravity/Cipherline}"
OUT="${OUT:?set OUT to a scratch directory}"
PORT="${PORT:-13151}"
MOCK="${MOCK:-http://127.0.0.1:7981}"
TSC="$MAIN/node_modules/.bin/tsc"

case "${1:-}" in
build)
  mkdir -p "$OUT"
  rm -rf "$OUT/shared" "$OUT/api"
  "$TSC" -p "$REPO/packages/shared/tsconfig.json" --outDir "$OUT/shared"
  cat > "$OUT/api-tsconfig.json" <<EOF
{
  "extends": "$REPO/apps/api/tsconfig.build.json",
  "compilerOptions": { "outDir": "$OUT/api", "rootDir": "$REPO/apps/api/src", "incremental": false, "sourceMap": false,
    "declaration": false, "baseUrl": "$REPO/apps/api", "paths": { "@cipherline/shared": ["$OUT/shared/index.d.ts"] } },
  "include": ["$REPO/apps/api/src/**/*"],
  "exclude": ["$REPO/apps/api/src/**/*spec.ts", "$REPO/apps/api/src/**/testing/**", "$REPO/apps/api/src/**/*.test-helpers.ts"]
}
EOF
  ( cd "$REPO/apps/api" && "$TSC" -p "$OUT/api-tsconfig.json" ) || echo "[build] tsc reported type errors (emit continues)"
  test -f "$OUT/api/main.js"
  mkdir -p "$OUT/api/node_modules/@cipherline/shared"
  cp -r "$OUT/shared/." "$OUT/api/node_modules/@cipherline/shared/"
  echo '{"name":"@cipherline/shared","main":"index.js"}' > "$OUT/api/node_modules/@cipherline/shared/package.json"
  echo "[build] done: $OUT/api/main.js"
  ;;
run)
  PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cl-dif-pg)"
  cd "$OUT/api"
  export DB_HOST="$PG_IP" DB_USER=postgres DB_PASS=x DB_NAME=clif DB_POOL_MAX=20
  export REDIS_HOST=127.0.0.1 REDIS_PORT=16491
  export JWT_SECRET="${JWT_SECRET:-clif-harness-secret-0123456789abcdef0123456789}"
  export JWT_2FA_SECRET=clif-harness-2fa-secret-0123456789abcdef0123
  # Presigned URLs on the harness Vite origin (it proxies /cipherline/ to MinIO): see vite.config.ts.
  export MINIO_PUBLIC_ENDPOINT="${MINIO_PUBLIC:-http://127.0.0.1:5274}" MINIO_ENDPOINT=http://127.0.0.1:9191 MINIO_ACCESS_KEY=clif MINIO_SECRET_KEY=cliffcliffcliff
  export MIN_CLIENT_VERSION=0.0.0 REGISTER_POW_DIFFICULTY=0 PORT NODE_ENV=development
  export IMPORT_AUTHOR_HMAC_KEY="${IMPORT_AUTHOR_HMAC_KEY:-clif-harness-import-hmac-key-0123456789abcdef}"
  export DISCORD_OAUTH_CLIENT_ID=123456789012345678 DISCORD_OAUTH_CLIENT_SECRET=harness-client-secret-0123456789
  export DISCORD_OAUTH_ORIGIN="http://127.0.0.1:$PORT" DISCORD_OAUTH_TEST_BASE="$MOCK"
  export NODE_PATH="$OUT/api/node_modules:$MAIN/apps/api/node_modules:$MAIN/node_modules"
  exec -a clif-api node main.js
  ;;
*) echo "usage: api.sh build|run"; exit 2 ;;
esac
