#!/usr/bin/env bash
# SALT-OKUNUR SARMALAYICININ NEGATIF KONTROLU — HARCANABILIR klon uzerinde.
set -euo pipefail

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-${MAS_PG_PORT:-5432}}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
PROBE="mas_radar_readonly_probe"

case "${PROBE}" in
  mas_radar_dev|postgres|template0|template1)
    echo "DURDUR: korunan hedef ${PROBE}" >&2; exit 9;;
esac
case "${PROBE}" in
  *probe*|*snapshot*) echo "GUARD OK: ${PROBE} harcanabilir" >&2;;
  *) echo "DURDUR: ${PROBE} disposable isareti tasimiyor" >&2; exit 9;;
esac

cleanup() {
  psql -d postgres -tAc "drop database if exists ${PROBE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql -d postgres -tAc "drop database if exists ${PROBE}" >/dev/null
psql -d postgres -tAc "create database ${PROBE}" >/dev/null
psql -d "${PROBE}" -tAc "create table t(id int); insert into t values (1);" >/dev/null

RO=$(PGOPTIONS="-c default_transaction_read_only=on" \
      psql -d "${PROBE}" -tAc \
      "select current_setting('transaction_read_only')" | tr -d '[:space:]')
if [ "${RO}" != "on" ]; then
  echo "FAIL: transaction_read_only='${RO}', 'on' bekleniyordu" >&2
  exit 1
fi
echo "  PASS  ayar etkin: transaction_read_only=on"

if OUT=$(PGOPTIONS="-c default_transaction_read_only=on" \
          psql -d "${PROBE}" -v ON_ERROR_STOP=1 -tAc \
          "update t set id = 2" 2>&1); then
  echo "  FAIL  YAZMA GECTI — koruma CALISMIYOR. Cikti: ${OUT}" >&2
  echo "REAL_DB_READONLY_ENFORCEMENT: FAIL" >&2
  exit 1
fi

if echo "${OUT}" | grep -qi "read-only transaction"; then
  echo "  PASS  yazma reddedildi: $(echo "${OUT}" | grep -i 'read-only' | head -1 | tr -s ' ')"
else
  echo "  FAIL  yazma dustu ama sebep salt-okunur DEGIL: ${OUT}" >&2
  exit 1
fi

N=$(PGOPTIONS="-c default_transaction_read_only=on" \
      psql -d "${PROBE}" -tAc "select count(*) from t" | tr -d '[:space:]')
if [ "${N}" != "1" ]; then
  echo "  FAIL  SELECT bozuldu (count=${N}, 1 bekleniyordu)" >&2
  exit 1
fi
echo "  PASS  SELECT calisiyor (count=1) — koruma yalniz yazmayi engelliyor"

echo "REAL_DB_READONLY_ENFORCEMENT: PASS"
