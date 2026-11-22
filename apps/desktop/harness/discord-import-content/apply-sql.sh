#!/usr/bin/env bash
# Apply the Discord import SQL files (history, claims, link move, member grants) to the ISOLATED harness DB only.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/../../../api/src/migrations/sql"
PG="${PG:-cl-ic-pg}"; DB="${PGDB:-clic}"
[[ "$PG" == cl-ic-* ]] || { echo "isolated DB only"; exit 2; }
for f in 20261121-discord-import-history.sql 20261121-discord-import-claims.sql 20261121-discord-link-move.sql 20261122-discord-import-member-grants.sql; do
  docker exec -i "$PG" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$SQL/$f" > /dev/null
  echo "applied $f"
done
