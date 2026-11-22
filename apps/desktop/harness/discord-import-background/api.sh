#!/usr/bin/env bash
# Discord import final mapping pass: the ISOLATED API for the real-app check
# (never the shared dev stack, staging or prod).
#
#   api.sh build   compile packages/shared + apps/api from THIS tree into $OUT
#   api.sh run     run it on 127.0.0.1:$PORT against the throwaway containers
#                  cl-dib-pg (DB clib), cl-dib-redis (127.0.0.1:16493) and
#                  cl-dib-minio (127.0.0.1:9193)
#
# Containers (throwaway, no volumes):
#   docker run -d --name cl-dib-pg -e POSTGRES_PASSWORD=x -p 127.0.0.1:55583:5432 postgres:15-alpine
#   docker exec cl-dib-pg psql -U postgres -c "CREATE DATABASE clib"
#   docker run -d --name cl-dib-redis -p 127.0.0.1:16493:6379 redis:7-alpine redis-server --save "" --appendonly no
#   docker run -d --name cl-dib-minio -e MINIO_ROOT_USER=clib -e MINIO_ROOT_PASSWORD=<MINIO_PW from $OUT/secrets.env> -p 127.0.0.1:9193:9000 minio/minio:latest server /data
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
MAIN="${MAIN_NODE_MODULES:-/home/antigravity/Cipherline}"
OUT="${OUT:?set OUT to a scratch directory}"
PORT="${PORT:-13161}"
MOCK="${MOCK:-http://127.0.0.1:7991}"
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
  PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cl-dib-pg)"
  cd "$OUT/api"
  export DB_HOST="$PG_IP" DB_USER=postgres DB_PASS=x DB_NAME=clib DB_POOL_MAX=20
  export REDIS_HOST=127.0.0.1 REDIS_PORT=16493
  # Throwaway secrets, generated once per scratch build (never committed).
  [ -f "$OUT/secrets.env" ] || printf 'JWT_SECRET=%s\nJWT_2FA_SECRET=%s\nIMPORT_AUTHOR_HMAC_KEY=%s\nMINIO_PW=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 12)" > "$OUT/secrets.env"
  set -a; . "$OUT/secrets.env"; set +a
  # Presigned URLs on the harness Vite origin (it proxies /cipherline/ to MinIO): see vite.config.ts.
  export MINIO_PUBLIC_ENDPOINT="${MINIO_PUBLIC:-http://127.0.0.1:5284}" MINIO_ENDPOINT=http://127.0.0.1:9193 MINIO_ACCESS_KEY=clib MINIO_SECRET_KEY="${MINIO_PW}"
  export MIN_CLIENT_VERSION=0.0.0 REGISTER_POW_DIFFICULTY=0 PORT NODE_ENV=development
  export DISCORD_OAUTH_CLIENT_ID=123456789012345678 DISCORD_OAUTH_CLIENT_SECRET="${JWT_2FA_SECRET:0:24}"
  export DISCORD_OAUTH_ORIGIN="http://127.0.0.1:$PORT" DISCORD_OAUTH_TEST_BASE="$MOCK"
  export NODE_PATH="$OUT/api/node_modules:$MAIN/apps/api/node_modules:$MAIN/node_modules"
  exec -a clib-api node main.js
  ;;
*) echo "usage: api.sh build|run"; exit 2 ;;
esac
