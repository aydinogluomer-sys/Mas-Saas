#!/usr/bin/env bash
# GERCEK DB SALT-OKUNUR SARMALAYICI — prompt sozu degil, PostgreSQL motor zorlamasi.
#
# NEDEN VAR. Kesif ajanlari `mas_radar_dev`'e `postgres` superuser'i ile baglaniyor. Superuser
# teknik olarak YAZABILIR; "yazma" yasagi yalnizca prompt metnindeydi. Bir prompt kurali,
# yanlis yazilmis tek bir SQL cumlesini durduramaz. Bu sarmalayici oturumu
# `default_transaction_read_only=on` ile acar: DELETE/UPDATE/INSERT/TRUNCATE/DDL denemesi
# PostgreSQL tarafindan REDDEDILIR ("cannot execute ... in a read-only transaction").
#
# Kapiyi acmadan once IKI seyi kanitlar:
#   1. Hedef tam olarak `mas_radar_dev` (baska hicbir ad kabul edilmez)
#   2. Baglanti gercekten salt-okunur: current_setting('transaction_read_only') = 'on'
#
# KULLANIM:
#   bash scripts/db/p24b-readonly-psql.sh -c "select count(*) from users"
#   bash scripts/db/p24b-readonly-psql.sh -f /tmp/sorgu.sql
#
# NEGATIF KONTROL: bu sarmalayicinin gercekten yazmayi engelledigini kanitlamak icin
# GERCEK DB'de yazma denemesi YAPILMAZ. Kanit HARCANABILIR bir klon uzerinde uretilir:
#   scripts/db/p24b-readonly-negative-control.sh
set -euo pipefail

CONTAINER="${MAS_PG_CONTAINER:-mas-radar-pg}"
TARGET="mas_radar_dev"

# ── Kapi 1: hedef adi. Degistirilebilir bir degisken degil, sabit.
if [ "${TARGET}" != "mas_radar_dev" ]; then
  echo "DURDUR: bu sarmalayici yalniz mas_radar_dev icindir." >&2
  exit 9
fi

# ── Kapi 2: baglantinin GERCEKTEN salt-okunur oldugunu kanitla (pozitif kontrol).
RO=$(MSYS_NO_PATHCONV=1 docker exec \
      -e PGOPTIONS="-c default_transaction_read_only=on" \
      "${CONTAINER}" psql -U postgres -d "${TARGET}" -tAc \
      "select current_setting('transaction_read_only')" 2>/dev/null | tr -d '[:space:]')

if [ "${RO}" != "on" ]; then
  echo "DURDUR: salt-okunur oturum kurulamadi (transaction_read_only='${RO}', 'on' bekleniyordu)." >&2
  echo "        Kanit uretilemeyen bir oturumda gercek DB'ye sorgu calistirilmaz." >&2
  exit 9
fi

echo "READONLY GUARD OK: db=${TARGET} transaction_read_only=on" >&2

# ── Kapi gecti: sorguyu ayni salt-okunur ayarla calistir.
MSYS_NO_PATHCONV=1 exec docker exec \
  -e PGOPTIONS="-c default_transaction_read_only=on" \
  "${CONTAINER}" psql -U postgres -d "${TARGET}" "$@"
