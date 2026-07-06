#!/usr/bin/env bash
# Local PostgreSQL 16 lives in Docker (container: mas-radar-pg); self-heal if absent/stopped.
CONTAINER=mas-radar-pg
docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER" || \
  docker run -d --name "$CONTAINER" --restart unless-stopped \
    -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16 >/dev/null
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || docker start "$CONTAINER" >/dev/null
# wait until the server accepts connections
for i in $(seq 1 40); do
  docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && exit 0
  sleep 0.5
done
echo "postgres not reachable in container $CONTAINER" >&2; exit 1
