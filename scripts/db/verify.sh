#!/usr/bin/env bash
# Phase 1 gate: full reset -> migrations in order -> seed -> assertions. Run twice to prove reset repeatability.
set -euo pipefail
DB=mas_radar_verify
run_psql() { su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f '$1'"; }
su postgres -c "dropdb --if-exists $DB && createdb $DB"
run_psql scripts/db/local-bootstrap.sql
for f in supabase/migrations/*.sql; do run_psql "$f"; done
run_psql supabase/seed.sql
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f scripts/db/assertions.sql" 2>&1 | grep -E "NOTICE|ERROR" | sed 's/^psql://'
