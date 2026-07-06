#!/usr/bin/env bash
# Dev database: same bootstrap+migrations+seed as verify, but persistent for the app.
set -euo pipefail
bash "$(dirname "$0")/ensure.sh"
CONTAINER=mas-radar-pg
DB=mas_radar_dev
docker exec "$CONTAINER" dropdb -U postgres --if-exists "$DB"
docker exec "$CONTAINER" createdb -U postgres "$DB"
for f in scripts/db/local-bootstrap.sql supabase/migrations/*.sql supabase/seed.sql; do
  docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < "$f"
done
docker exec "$CONTAINER" psql -U postgres -d "$DB" -qc "alter user postgres password 'postgres';"
echo "dev db ready: $DB"
