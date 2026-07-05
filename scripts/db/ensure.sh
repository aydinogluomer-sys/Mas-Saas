#!/usr/bin/env bash
# Container reaps background daemons between shell sessions; self-heal.
pg_lsclusters | grep -q online || pg_ctlcluster 16 main start
# wait for TCP
for i in $(seq 1 20); do
  (echo > /dev/tcp/127.0.0.1/5432) >/dev/null 2>&1 && exit 0
  sleep 0.3
done
echo "postgres TCP not reachable" >&2; exit 1
