#!/usr/bin/env bash
# Stop the local PostgreSQL container. The Next.js server is stopped with Ctrl-C in its
# own terminal. Data is preserved in the named volume (mas_radar_pgdata).
set -euo pipefail
cd "$(dirname "$0")/../.."
echo "==> Stopping Postgres (data volume preserved)"
docker compose stop
echo "==> Stopped. Data intact. Remove volume only with: docker compose down -v (DESTROYS DATA)"
