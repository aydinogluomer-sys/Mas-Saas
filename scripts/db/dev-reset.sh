#!/usr/bin/env bash
# Dev database: same bootstrap+migrations+seed as verify, but persistent for the app.
#
# THIS SCRIPT DESTROYS mas_radar_dev.
# Fail-closed two-factor guard:
#   A) --i-understand-this-destroys-mas-radar-dev
#   B) MAS_ALLOW_DEV_DB_RESET=mas_radar_dev
set -euo pipefail

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-${MAS_PG_PORT:-5432}}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB=mas_radar_dev
CONFIRM_FLAG="--i-understand-this-destroys-mas-radar-dev"

# ── GUARD ────────────────────────────────────────────────────────────────────────────────────
flag_given=no
for arg in "$@"; do
  [ "$arg" = "$CONFIRM_FLAG" ] && flag_given=yes
done
env_given="${MAS_ALLOW_DEV_DB_RESET:-}"

if [ "$flag_given" != "yes" ] || [ "$env_given" != "$DB" ]; then
  {
    echo "GÜVENLİK DURDURMASI: $DB DROP EDİLMEDİ. Hiçbir komut çalıştırılmadı."
    echo
    echo "Bu script '$DB' veritabanını siler ve sıfırdan kurar. '$DB' bu projenin GERÇEK,"
    echo "veri taşıyan geliştirme veritabanıdır — silinen veri geri gelmez."
    echo
    echo "Durum:"
    echo "  onay bayrağı  : $([ "$flag_given" = yes ] && echo 'VAR' || echo "YOK  ($CONFIRM_FLAG)")"
    echo "  onay değişkeni: $([ "$env_given" = "$DB" ] && echo 'VAR' || echo "YOK  (MAS_ALLOW_DEV_DB_RESET=$DB)")"
    echo
    echo "İKİSİ BİRDEN gerekir. Gerçekten silmek istiyorsanız:"
    echo
    echo "  MAS_ALLOW_DEV_DB_RESET=$DB bash scripts/db/dev-reset.sh $CONFIRM_FLAG"
    echo
    echo "Harcanabilir bir veritabanı kurmak istiyorsanız bu script YANLIŞ araçtır;"
    echo "scripts/ci/provision-verify-db.sh <ad>_verify kullanın."
  } >&2
  exit 9
fi

# ── MEASURED IDENTITY ────────────────────────────────────────────────────────────────────────
bash "$(dirname "$0")/ensure.sh"

echo "== YIKIM ÖNCESİ ÖLÇÜLEN KİMLİK =="
echo "  endpoint       : ${PGHOST}:${PGPORT}"
if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB"; then
  measured_db="$(psql -d "$DB" -tAc 'select current_database()' 2>/dev/null || echo '?')"
  echo "  current_database: $measured_db"
  if [ "$measured_db" != "$DB" ]; then
    echo "GÜVENLİK DURDURMASI: ölçülen veritabanı ('$measured_db') beklenenden ($DB) farklı." >&2
    exit 9
  fi
  psql -d "$DB" -tAc \
    "select '  ' || relname || ' = ' || n_live_tup
       from pg_stat_user_tables
      where n_live_tup > 0 and schemaname = 'public'
      order by n_live_tup desc limit 8" 2>/dev/null || true
  echo "  (yukarıdaki satırların TAMAMI silinecek)"
else
  echo "  '$DB' henüz yok — bu bir kurulum, yıkım değil."
fi

if [ -t 0 ]; then
  printf "\nSilmek için tam olarak '%s' yazın: " "$DB"
  read -r typed
  if [ "$typed" != "$DB" ]; then
    echo "GÜVENLİK DURDURMASI: onay metni eşleşmedi. Hiçbir şey silinmedi." >&2
    exit 9
  fi
fi

# ── DESTRUCTIVE SECTION ──────────────────────────────────────────────────────────────────────
dropdb --force --if-exists "$DB"
createdb "$DB"
for f in scripts/db/local-bootstrap.sql supabase/migrations/*.sql supabase/seed.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
echo "dev db ready: $DB"
