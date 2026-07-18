#!/usr/bin/env bash
# Start MAS Nakit Radar for local private production.
# Brings up the persistent PostgreSQL 16 (docker compose), initializes the app DB on
# FIRST run only (never wipes existing data), then serves the production build.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=mas-radar-pg
DB="${MAS_DB_NAME:-mas_radar_dev}"

echo "==> Postgres (persistent volume via docker compose)"
docker compose up -d
# wait for readiness
for i in $(seq 1 40); do
  docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break
  sleep 0.5
done

# initialize DB only if it does not exist yet (idempotent, non-destructive)
FIRST_RUN=false
if docker exec "$CONTAINER" psql -U postgres -lqt | cut -d'|' -f1 | grep -qw "$DB"; then
  echo "==> DB '$DB' already exists — running the migration ledger (safe on an existing DB)"
else
  FIRST_RUN=true
  echo "==> First run: creating '$DB'"
  docker exec "$CONTAINER" createdb -U postgres "$DB"
fi

docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < scripts/db/local-bootstrap.sql

echo "==> Migration ledger (schema_migrations): checksum-verified, backed up, applied"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/$DB" pnpm exec tsx scripts/db/migrate.ts

if [ "$FIRST_RUN" = true ]; then
  docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < supabase/seed.sql
  echo "==> DB initialized"
fi

echo "==> Env check"
pnpm exec tsx scripts/deploy/check-env.ts

echo "==> Production build"
pnpm build

echo "==> Starting Next.js (production) on http://127.0.0.1:${PORT:-3000}"
echo "    Stop with: bash scripts/deploy/local-stop.sh"
pnpm start
