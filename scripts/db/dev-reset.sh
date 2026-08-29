#!/usr/bin/env bash
# Dev database: same bootstrap+migrations+seed as verify, but persistent for the app.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# THIS SCRIPT DESTROYS mas_radar_dev. READ THE GUARD BELOW BEFORE EDITING IT.
#
# WHAT WAS WRONG. Until the P24B writer-surface audit this file opened, three lines in, with:
#
#     DB=mas_radar_dev
#     docker exec "$CONTAINER" dropdb -U postgres --if-exists "$DB"
#
# No flag, no confirmation, no dry run. `bash scripts/db/dev-reset.sh` — or `pnpm db:dev:reset`,
# or a tab-completed shell history entry — destroyed the real, data-carrying development database
# and everything in it. The rest of the audit spent its time proving that fixture scripts cannot
# be POINTED at mas_radar_dev by a stray environment variable; meanwhile the most destructive
# script in the repository had mas_radar_dev HARD-CODED and asked nobody anything.
#
# It was also listed in .claude/settings.json's Bash allow-list, so an agent could run it with no
# permission prompt at all.
#
# WHY A DISPOSABLE-NAME GATE CANNOT HELP HERE. requireDisposableOwnerDatabaseUrl() protects
# scripts whose target comes from the environment: it inspects the name and refuses protected
# ones. This script's target is not env-derived — destroying mas_radar_dev IS its purpose. A name
# check would either be a no-op or would break the tool. So the protection has to be a different
# shape: not "is this target safe?" but "did a human deliberately ask for this exact destruction?"
#
# THE MODEL: fail-closed, two INDEPENDENT confirmations, neither of which can be supplied by
# accident, both checked before ANY command runs — including ensure.sh.
#
#   A) an argument that spells out the consequence:  --i-understand-this-destroys-mas-radar-dev
#   B) an environment variable that names the target: MAS_ALLOW_DEV_DB_RESET=mas_radar_dev
#
# One alone is not enough. A stale exported variable cannot arm the script on its own, and neither
# can a copied command line. Interactive shells get a third, typed confirmation on top; that layer
# is deliberately NOT the load-bearing one, because CI and agents have no TTY and would skip it.
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CONTAINER="${MAS_DB_CONTAINER:-mas-radar-pg}"
DB=mas_radar_dev
CONFIRM_FLAG="--i-understand-this-destroys-mas-radar-dev"

# ── GUARD ────────────────────────────────────────────────────────────────────────────────────
# Runs before ensure.sh and before the first docker call. Nothing at all happens without both
# confirmations — not even starting the container.
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
# Both confirmations are present, so the operator has asked for this. Before destroying anything,
# SHOW them what they are about to destroy — measured from the server, not assumed. An operator
# who armed the script against the wrong cluster gets one last chance to notice here.
bash "$(dirname "$0")/ensure.sh"

echo "== YIKIM ÖNCESİ ÖLÇÜLEN KİMLİK =="
echo "  container      : $CONTAINER"
if docker exec "$CONTAINER" psql -U postgres -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB"; then
  measured_db="$(docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select current_database()' 2>/dev/null || echo '?')"
  echo "  current_database: $measured_db"
  if [ "$measured_db" != "$DB" ]; then
    echo "GÜVENLİK DURDURMASI: ölçülen veritabanı ('$measured_db') beklenenden ($DB) farklı." >&2
    exit 9
  fi
  docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc \
    "select '  ' || relname || ' = ' || n_live_tup
       from pg_stat_user_tables
      where n_live_tup > 0 and schemaname = 'public'
      order by n_live_tup desc limit 8" 2>/dev/null || true
  echo "  (yukarıdaki satırların TAMAMI silinecek)"
else
  echo "  '$DB' henüz yok — bu bir kurulum, yıkım değil."
fi

# Interactive shells only. CI, agents and pipes have no TTY and are already covered by the two
# confirmations above; this layer exists so a human who typed the command by muscle memory still
# has to stop and read the row counts printed above.
if [ -t 0 ]; then
  printf "\nSilmek için tam olarak '%s' yazın: " "$DB"
  read -r typed
  if [ "$typed" != "$DB" ]; then
    echo "GÜVENLİK DURDURMASI: onay metni eşleşmedi. Hiçbir şey silinmedi." >&2
    exit 9
  fi
fi

# ── DESTRUCTIVE SECTION ──────────────────────────────────────────────────────────────────────
docker exec "$CONTAINER" dropdb -U postgres --if-exists "$DB"
docker exec "$CONTAINER" createdb -U postgres "$DB"
for f in scripts/db/local-bootstrap.sql supabase/migrations/*.sql supabase/seed.sql; do
  docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < "$f"
done
docker exec "$CONTAINER" psql -U postgres -d "$DB" -qc "alter user postgres password 'postgres';"
echo "dev db ready: $DB"
