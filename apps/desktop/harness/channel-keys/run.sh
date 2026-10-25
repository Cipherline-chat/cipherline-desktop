#!/usr/bin/env bash
# Channel-key scenario harness — one command:
#
#   apps/desktop/harness/channel-keys/run.sh [after|before|both] [scenario[,scenario…]|all] [runs=5]
#
# Stands up an ISOLATED Postgres + Redis (compose project `ckharness`,
# containers ckh-pg / ckh-redis, 127.0.0.1:5497 / :6397, tmpfs only), builds the
# API + a headless desktop device from the chosen source tree(s) (build.sh),
# runs each API against its own database (ckh_<mode>; before on :3197, after on
# :3198) and drives the scenarios in run.mjs: real API, real desktop crypto,
# real key-protocol modules, 15 holders + joiners as separate processes.
# `both` interleaves before/after run by run, so load from anything else on
# the box hits both alike. Never touches the shared dev stack, prod or staging.
#
#   after  = this checkout;  before = merge-base with origin/staging
#            (override with CKH_BASE=<commit>).
# Results: out/summary-<mode>.jsonl (pass/fail per scenario), out/results-<mode>.jsonl
# (every run), out/run.out, out/logs/. `CKH_KEEP_STACK=1` leaves the containers up.
# Knobs: CKH_HOLDERS (15), CKH_CHANNELS (20), CKH_EPOCHS (15), CKH_OBSERVE_MS (100000),
# CKH_REPLICAS (1; 2 = two API processes per mode).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHICH="${1:-after}"; SCEN="${2:-all}"; RUNS="${3:-5}"
case "$WHICH" in before|after) MODES="$WHICH" ;; both) MODES="before after" ;; *) echo "usage: run.sh [after|before|both] [scenario|all] [runs]"; exit 2 ;; esac
mkdir -p "$HERE/out"

docker compose -f "$HERE/compose.yml" up -d >/dev/null
for _ in $(seq 1 60); do docker exec ckh-pg psql -U ckh -d ckh -qc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
docker exec ckh-redis redis-cli FLUSHALL >/dev/null

port_of() { if [[ "$1" == before ]]; then echo 3197; else echo 3198; fi; }
stop_api() { pkill -f "^ckh-api-$1" 2>/dev/null || true; }
cleanup() { for m in $MODES; do stop_api "$m"; done; if [[ "${CKH_KEEP_STACK:-}" != "1" ]]; then docker compose -f "$HERE/compose.yml" down >/dev/null; fi; }
trap cleanup EXIT

for m in $MODES; do
  "$HERE/build.sh" "$m"
  docker exec ckh-pg psql -U ckh -d ckh -qc "DROP DATABASE IF EXISTS ckh_$m" >/dev/null
  docker exec ckh-pg psql -U ckh -d ckh -qc "CREATE DATABASE ckh_$m" >/dev/null
  stop_api "$m"
  CKH_PORT="$(port_of "$m")" "$HERE/api.sh" "$m" > "$HERE/out/api-$m.log" 2>&1 &
  # CKH_REPLICAS=2: a second API process on port+2 (same DB and Redis, like a
  # second prod pod); run.mjs alternates devices between the two.
  if [[ "${CKH_REPLICAS:-1}" == 2 ]]; then
    CKH_PORT="$(( $(port_of "$m") + 2 ))" "$HERE/api.sh" "$m" > "$HERE/out/api-$m-2.log" 2>&1 &
  fi
done
for m in $MODES; do
  ports="$(port_of "$m")"; [[ "${CKH_REPLICAS:-1}" == 2 ]] && ports="$ports $(( $(port_of "$m") + 2 ))"
  for p in $ports; do
    for _ in $(seq 1 120); do curl -s -o /dev/null "http://127.0.0.1:$p/" && break; sleep 1; done
    curl -s -o /dev/null "http://127.0.0.1:$p/" || { echo "API ($m, :$p) did not come up — see out/api-$m*.log"; tail -30 "$HERE/out/api-$m.log"; exit 1; }
  done
done
if [[ "${CKH_REPLICAS:-1}" == 2 ]]; then export CKH_API_BEFORE_2="http://127.0.0.1:3199/v1" CKH_API_AFTER_2="http://127.0.0.1:3200/v1"; fi

CKH_API_BEFORE="http://127.0.0.1:3197/v1" CKH_API_AFTER="http://127.0.0.1:3198/v1" \
  node "$HERE/run.mjs" "$WHICH" "$SCEN" "$RUNS" | tee "$HERE/out/run.out"
