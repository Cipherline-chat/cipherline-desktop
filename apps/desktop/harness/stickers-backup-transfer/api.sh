#!/usr/bin/env bash
# Stickers backup + device transfer, REAL-APP check: the ISOLATED API (never the shared dev stack, staging or prod).
#
#   api.sh build   compile packages/shared + apps/api from THIS tree into $OUT
#   api.sh run     run it on 127.0.0.1:$PORT against the throwaway containers below
#
# Containers (throwaway, no volumes, loopback ports):
#   docker run -d --name cl-sbt-pg -e POSTGRES_PASSWORD=x -p 127.0.0.1:55623:5432 postgres:15-alpine
#   docker exec cl-sbt-pg psql -U postgres -c "CREATE DATABASE clsbt"
#   docker run -d --name cl-sbt-redis -p 127.0.0.1:16623:6379 redis:7-alpine redis-server --save "" --appendonly no
#   docker run -d --name cl-sbt-minio -e MINIO_ROOT_USER=clsbt -e MINIO_ROOT_PASSWORD=clsbtclsbtclsbt -p 127.0.0.1:9323:9000 minio/minio:latest server /data
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
MAIN="${MAIN_NODE_MODULES:-/home/antigravity/Cipherline}"
OUT="${OUT:?set OUT to a scratch directory}"
PORT="${PORT:-13223}"
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
  PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cl-sbt-pg)"
  cd "$OUT/api"
  export DB_HOST="$PG_IP" DB_USER=postgres DB_PASS=x DB_NAME=clsbt DB_POOL_MAX=20
  export REDIS_HOST=127.0.0.1 REDIS_PORT=16623
  export JWT_SECRET="${JWT_SECRET:-clsbt-harness-secret-0123456789abcdef0123456789}"
  export JWT_2FA_SECRET=clsbt-harness-2fa-secret-0123456789abcdef0123
  # Presigned URLs on the harness Vite origin (it proxies /cipherline/ to MinIO): see vite.config.ts.
  export MINIO_PUBLIC_ENDPOINT="${MINIO_PUBLIC:-http://127.0.0.1:5323}" MINIO_ENDPOINT=http://127.0.0.1:9323 MINIO_ACCESS_KEY=clsbt MINIO_SECRET_KEY=clsbtclsbtclsbt
  export MIN_CLIENT_VERSION=0.0.0 REGISTER_POW_DIFFICULTY=0 PORT NODE_ENV=development
  export NODE_PATH="$OUT/api/node_modules:$MAIN/apps/api/node_modules:$MAIN/node_modules"
  exec -a clsbt-api node main.js
  ;;
*) echo "usage: api.sh build|run"; exit 2 ;;
esac
