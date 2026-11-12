#!/usr/bin/env bash
#
# Provision ONE fresh disposable database, migrated to head by the REAL ledger runner.
# Connects over loopback TCP (127.0.0.1:${MAS_PG_PORT:-5432}) — works identically on
# native PostgreSQL 16 and CI port-mapped PostgreSQL 16 with zero docker exec calls.

set -euo pipefail

db="${1:?kullanım: provision-verify-db.sh <disposable-db-adı>}"
port="${MAS_PG_PORT:-5432}"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="$port"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

# NOTE — THIS LIST MUST MATCH DISPOSABLE_MARKERS IN scripts/db/owner-url.ts.
case "$db" in
  *verify*|*test*|*tmp*|*temp*|*disposable*|*scratch*|*sandbox*|*fixture*|*clone*|*restore*|*snapshot*|*probe*|*drill*) ;;
  *)
    echo "GÜVENLİK DURDURMASI: '$db' disposable işaretlerinden hiçbirini taşımıyor." >&2
    echo "Bu script hedefi DROP eder; adının harcanabilir olduğunu söylemesi gerekir." >&2
    exit 1
    ;;
esac

case "$db" in
  mas_radar_dev|postgres|template0|template1)
    echo "GÜVENLİK DURDURMASI: '$db' korunan bir veritabanı." >&2
    exit 1
    ;;
esac

dropdb --force --if-exists "$db" >/dev/null
createdb "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f scripts/db/local-bootstrap.sql

MIGRATION_DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${port}/${db}" pnpm db:migrate >/dev/null

expected_count="$(find supabase/migrations -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
expected_max="$(find supabase/migrations -maxdepth 1 -name '*.sql' -printf '%f\n' | LC_ALL=C sort | tail -1 | cut -c1-4)"
actual="$(psql -At -d "$db" -c "select count(*)||'|'||max(version) from public.schema_migrations;")"

echo "ledger: expected=${expected_count}|${expected_max} actual=${actual} db=${db}"
if [ "$actual" != "${expected_count}|${expected_max}" ]; then
  echo "LEDGER ASSERTION FAILED: beklenen ${expected_count}|${expected_max}, gerçekleşen ${actual}" >&2
  exit 1
fi

psql -q -v ON_ERROR_STOP=1 -d "$db" -f supabase/seed.sql
MIGRATION_DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${port}/${db}" \
  pnpm exec tsx scripts/db/seed-system-actor.ts >/dev/null

if [ -n "${MAS_RADAR_APP_DB_PASSWORD:-}" ]; then
  MIGRATION_DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${port}/${db}" \
  MAS_RADAR_APP_DB_PASSWORD="$MAS_RADAR_APP_DB_PASSWORD" \
    pnpm db:app-role:password >/dev/null
fi
