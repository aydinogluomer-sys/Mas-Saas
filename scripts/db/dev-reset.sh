#!/usr/bin/env bash
# Dev database: same bootstrap+migrations+seed as verify, but persistent for the app.
set -euo pipefail
pg_ctlcluster 16 main status >/dev/null 2>&1 || pg_ctlcluster 16 main start
DB=mas_radar_dev
su postgres -c "dropdb --if-exists $DB && createdb $DB"
for f in scripts/db/local-bootstrap.sql supabase/migrations/*.sql supabase/seed.sql; do
  su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f '$f'"
done
su postgres -c "psql -d $DB -qc \"alter user postgres password 'postgres';\""
echo "dev db ready: $DB"
