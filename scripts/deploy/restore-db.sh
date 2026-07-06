#!/usr/bin/env bash
# Restore a pg_dump (custom format) into a FRESH database. Refuses to overwrite an
# existing DB unless FORCE=1 (guards against clobbering live data).
# Usage: bash scripts/deploy/restore-db.sh <dump_file> <target_db>
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=mas-radar-pg
DUMP="${1:?usage: restore-db.sh <dump_file> <target_db>}"
TARGET="${2:?usage: restore-db.sh <dump_file> <target_db>}"
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 1; }

if docker exec "$CONTAINER" psql -U postgres -lqt | cut -d'|' -f1 | grep -qw "$TARGET"; then
  if [ "${FORCE:-0}" != "1" ]; then
    echo "target DB '$TARGET' already exists. Re-run with FORCE=1 to drop+recreate it." >&2
    exit 1
  fi
  echo "==> FORCE: dropping existing '$TARGET'"
  docker exec "$CONTAINER" dropdb -U postgres "$TARGET"
fi

echo "==> Ensuring cluster roles exist (idempotent; global, not in the DB dump)"
docker exec "$CONTAINER" psql -U postgres -d postgres -q -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end \$\$;"

echo "==> Creating fresh '$TARGET' and restoring (schema+data from dump)"
docker exec "$CONTAINER" createdb -U postgres "$TARGET"
docker exec -i "$CONTAINER" pg_restore -U postgres -d "$TARGET" --no-owner --role=postgres < "$DUMP"
echo "==> Restore complete. Point DATABASE_URL at .../$TARGET to serve the app from it."
