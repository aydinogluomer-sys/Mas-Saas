#!/usr/bin/env bash
# Back up the MAS Nakit Radar database to a timestamped compressed dump.
# Output goes to ./backups (gitignored — dumps contain private financial data).
# Usage: bash scripts/deploy/backup-db.sh [db_name]
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=mas-radar-pg
DB="${1:-${MAS_DB_NAME:-mas_radar_dev}}"
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/${DB}-${STAMP}.dump"

echo "==> pg_dump ${DB} → ${OUT} (custom format)"
docker exec "$CONTAINER" pg_dump -U postgres -Fc "$DB" > "$OUT"
SIZE=$(wc -c < "$OUT")
echo "==> Backup complete: ${OUT} (${SIZE} bytes)"
echo "    Restore with: bash scripts/deploy/restore-db.sh ${OUT} <target_db>"
