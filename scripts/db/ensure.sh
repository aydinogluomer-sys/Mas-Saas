#!/usr/bin/env bash
# Yerel PostgreSQL 16 (native servis) veya CI (MAS_PG_RUNTIME=docker) hazırlık yoklaması.
set -euo pipefail
exec node --import tsx "$(dirname "$0")/ensure.ts"
