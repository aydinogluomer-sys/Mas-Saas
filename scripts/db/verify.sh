#!/usr/bin/env bash
# Phase 1 gate: full reset -> migrations in order -> seed -> assertions. Run twice to prove reset repeatability.
set -euo pipefail
bash "$(dirname "$0")/ensure.sh"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-${MAS_PG_PORT:-5432}}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB=mas_radar_verify
run_psql() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1"; }
dropdb --force --if-exists "$DB"
createdb "$DB"
run_psql scripts/db/local-bootstrap.sql
for f in supabase/migrations/*.sql; do run_psql "$f"; done
run_psql supabase/seed.sql
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f scripts/db/assertions.sql 2>&1 | grep -E "NOTICE|ERROR" | sed 's/^psql://'
