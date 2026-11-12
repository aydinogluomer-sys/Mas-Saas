#!/usr/bin/env bash
# GERCEK DB SALT-OKUNUR SARMALAYICI — PostgreSQL motor zorlamasi (default_transaction_read_only=on).
set -euo pipefail

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-${MAS_PG_PORT:-5432}}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
TARGET="mas_radar_dev"

if [ "${TARGET}" != "mas_radar_dev" ]; then
  echo "DURDUR: bu sarmalayici yalniz mas_radar_dev icindir." >&2
  exit 9
fi

RO=$(PGOPTIONS="-c default_transaction_read_only=on" \
      psql -d "${TARGET}" -tAc \
      "select current_setting('transaction_read_only')" 2>/dev/null | tr -d '[:space:]')

if [ "${RO}" != "on" ]; then
  echo "DURDUR: salt-okunur oturum kurulamadi (transaction_read_only='${RO}', 'on' bekleniyordu)." >&2
  echo "        Kanit uretilemeyen bir oturumda gercek DB'ye sorgu calistirilmaz." >&2
  exit 9
fi

echo "READONLY GUARD OK: db=${TARGET} transaction_read_only=on" >&2

PGOPTIONS="-c default_transaction_read_only=on" \
  exec psql -d "${TARGET}" "$@"
