#!/usr/bin/env bash
# Phase 1 gate: full reset -> migrations in order -> seed -> assertions. Run twice to prove reset repeatability.
set -euo pipefail
bash "$(dirname "$0")/ensure.sh"
CONTAINER=mas-radar-pg
DB=mas_radar_verify
run_psql() { docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < "$1"; }
docker exec "$CONTAINER" dropdb -U postgres --if-exists "$DB"
docker exec "$CONTAINER" createdb -U postgres "$DB"
run_psql scripts/db/local-bootstrap.sql
for f in supabase/migrations/*.sql; do run_psql "$f"; done
run_psql supabase/seed.sql
docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < scripts/db/assertions.sql 2>&1 | grep -E "NOTICE|ERROR" | sed 's/^psql://'
