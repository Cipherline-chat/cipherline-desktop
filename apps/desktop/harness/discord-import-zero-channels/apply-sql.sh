#!/usr/bin/env bash
# Apply every manual SQL file this branch needs, in deploy order, to the ISOLATED harness DB only
# (run after the API's first boot: dev synchronize has created the base tables).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/../../../api/src/migrations/sql"
PG="${PG:-cl-dzc-pg}"; DB="${PGDB:-clzc}"
[[ "$PG" == cl-dzc-* ]] || { echo "isolated DB only"; exit 2; }
for f in 20261121-discord-import-history.sql 20261121-discord-import-claims.sql 20261121-discord-link-move.sql \
         20261122-channel-slowmode-age-restricted.sql 20261122-discord-import-member-grants.sql 20261122-role-icons.sql 20261122-server-stickers.sql \
         20261123-discord-import-member-since.sql; do
  docker exec -i "$PG" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$SQL/$f" > /dev/null
  echo "applied $f"
done
