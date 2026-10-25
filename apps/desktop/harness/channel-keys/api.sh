#!/usr/bin/env bash
# api.sh <before|after> — run the harness API (built by build.sh) in the
# foreground on 127.0.0.1:3197 against the isolated ckh-pg / ckh-redis.
set -euo pipefail
MODE="${1:?usage: api.sh <before|after>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="${CKH_MAIN_NODE_MODULES:-/home/antigravity/Cipherline}"
PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ckh-pg)"
cd "$HERE/out/$MODE/api"
export DB_HOST="$PG_IP" DB_USER=ckh DB_PASS=ckh DB_NAME="ckh_$MODE" DB_POOL_MAX=40
export REDIS_HOST=127.0.0.1 REDIS_PORT=6397
export JWT_SECRET="${CKH_JWT_SECRET:-ckh-harness-secret-0123456789abcdef0123456789}"
export JWT_2FA_SECRET=ckh-harness-2fa-secret-0123456789abcdef0123
export MINIO_ENDPOINT=http://127.0.0.1:9 MINIO_ACCESS_KEY=ckh MINIO_SECRET_KEY=ckhckhckhckh
export MIN_CLIENT_VERSION=0.0.0 REGISTER_POW_DIFFICULTY=0 PORT="${CKH_PORT:-3197}" NODE_ENV=development
export NODE_PATH="$HERE/out/$MODE/api/node_modules:$MAIN/apps/api/node_modules:$MAIN/node_modules"
exec -a "ckh-api-$MODE" node ${CKH_NODE_FLAGS:-} main.js  # CKH_NODE_FLAGS: e.g. --cpu-prof (with NODE_OPTIONS="-r <exit-on-SIGTERM preload>")
