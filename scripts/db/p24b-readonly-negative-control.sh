#!/usr/bin/env bash
# SALT-OKUNUR SARMALAYICININ NEGATIF KONTROLU — HARCANABILIR klon uzerinde.
#
# NEDEN HARCANABILIR HEDEFTE. Bir korumanin calistigini kanitlamanin tek yolu onu ZORLAMAKTIR:
# yazma denemesi yapip reddedildigini gormek. Ama bu denemeyi GERCEK veritabaninda yapmak,
# korumanin calismadigi durumda tam da onlemeye calistigi hasari verir. Bu yuzden ayni
# `default_transaction_read_only=on` ayari harcanabilir bir klona uygulanir ve yazma orada
# denenir. Kanitlanan sey ayardir, veritabani degil.
#
# BEKLENEN: "cannot execute UPDATE in a read-only transaction"
# Yazma BASARILI olursa koruma calismiyordur ve script FAIL doner.
set -euo pipefail

CONTAINER="${MAS_PG_CONTAINER:-mas-radar-pg}"
PROBE="mas_radar_readonly_probe"

# ── Makine korumasi: hedef harcanabilir mi, korunan bir ad mi?
case "${PROBE}" in
  mas_radar_dev|postgres|template0|template1)
    echo "DURDUR: korunan hedef ${PROBE}" >&2; exit 9;;
esac
case "${PROBE}" in
  *probe*|*snapshot*) echo "GUARD OK: ${PROBE} harcanabilir" >&2;;
  *) echo "DURDUR: ${PROBE} disposable isareti tasimiyor" >&2; exit 9;;
esac

cleanup() {
  MSYS_NO_PATHCONV=1 docker exec "${CONTAINER}" psql -U postgres -tAc \
    "drop database if exists ${PROBE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

MSYS_NO_PATHCONV=1 docker exec "${CONTAINER}" psql -U postgres -tAc "drop database if exists ${PROBE}" >/dev/null
MSYS_NO_PATHCONV=1 docker exec "${CONTAINER}" psql -U postgres -tAc "create database ${PROBE}" >/dev/null
MSYS_NO_PATHCONV=1 docker exec "${CONTAINER}" psql -U postgres -d "${PROBE}" -tAc \
  "create table t(id int); insert into t values (1);" >/dev/null

# ── Pozitif kontrol: ayar gercekten 'on' mu?
RO=$(MSYS_NO_PATHCONV=1 docker exec -e PGOPTIONS="-c default_transaction_read_only=on" \
      "${CONTAINER}" psql -U postgres -d "${PROBE}" -tAc \
      "select current_setting('transaction_read_only')" | tr -d '[:space:]')
if [ "${RO}" != "on" ]; then
  echo "FAIL: transaction_read_only='${RO}', 'on' bekleniyordu" >&2
  exit 1
fi
echo "  PASS  ayar etkin: transaction_read_only=on"

# ── Negatif kontrol: yazma REDDEDILMELI.
if OUT=$(MSYS_NO_PATHCONV=1 docker exec -e PGOPTIONS="-c default_transaction_read_only=on" \
          "${CONTAINER}" psql -U postgres -d "${PROBE}" -v ON_ERROR_STOP=1 -tAc \
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

# ── SELECT hala calismali (koruma okumayi engellememeli).
N=$(MSYS_NO_PATHCONV=1 docker exec -e PGOPTIONS="-c default_transaction_read_only=on" \
      "${CONTAINER}" psql -U postgres -d "${PROBE}" -tAc "select count(*) from t" | tr -d '[:space:]')
if [ "${N}" != "1" ]; then
  echo "  FAIL  SELECT bozuldu (count=${N}, 1 bekleniyordu)" >&2
  exit 1
fi
echo "  PASS  SELECT calisiyor (count=1) — koruma yalniz yazmayi engelliyor"

echo "REAL_DB_READONLY_ENFORCEMENT: PASS"
