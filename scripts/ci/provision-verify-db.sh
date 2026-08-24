#!/usr/bin/env bash
#
# Provision ONE fresh disposable database, migrated to head by the REAL ledger runner.
#
# WHY THIS SCRIPT EXISTS AT ALL, INSTEAD OF TWENTY INLINE LINES OF YAML.
#
# The Faz 16 workflow provisioned its phase databases by replaying the migration directory
# through psql, one file per `docker exec`:
#
#     for f in supabase/migrations/*.sql; do
#       docker exec -i mas-radar-pg psql -q -v ON_ERROR_STOP=1 -U postgres -d mas_phase < "$f"
#     done
#
# That is NOT what an operator runs, and the difference is not cosmetic. Measured on this
# repository, on a disposable database:
#
#   1. `psql < file` WITHOUT `-1` runs each STATEMENT in its own implicit transaction. A file
#      that fails halfway leaves everything before the failure COMMITTED. Proven with a
#      three-statement file (create table / insert / select 1/0): psql exited 3, and the table
#      was still there afterwards with its row. `scripts/db/migrate.ts` instead wraps each
#      pending file in one explicit BEGIN/COMMIT (applyPendingSequentially) and rolls the whole
#      file back on error, so a half-applied migration cannot survive.
#   2. The raw loop writes NO `public.schema_migrations` row, so the replayed database cannot
#      answer "which migrations are applied?". The ledger assertion this plan requires
#      (count = files on disk, max = last file) is meaningless against it. migrate.ts inserts
#      the ledger row INSIDE the same transaction as the DDL, which is what makes the ledger
#      trustworthy in the first place.
#
# So CI was exercising a migration path that does not exist in production. Everything below
# goes through `pnpm db:migrate` — the same entrypoint a cutover uses.
#
# ONE HONEST LIMITATION, STATED SO NOBODY OVERCLAIMS THIS GATE. A fresh CI database is EMPTY.
# Migration 0056's "cannot ALTER TABLE because it has pending trigger events" hazard needs
# pre-existing operator rows for its UPDATE to match anything; with zero rows it queues no
# deferred trigger events and the statement is a no-op (0056's own header says so). No
# empty-database CI run — this one included — can catch that class of defect. Only a migration
# over a data-carrying clone can, which is why the golden-clone gate is a separate phase and
# is not replaced by this job.
#
# Usage:
#   scripts/ci/provision-verify-db.sh <database-name>
#
# The name MUST carry a disposable marker; see scripts/db/owner-url.ts. That gate normally
# lives inside the verify scripts, but provisioning drops the database first, so the check has
# to happen here too — before the dropdb, not after it.

set -euo pipefail

db="${1:?kullanım: provision-verify-db.sh <disposable-db-adı>}"
container="${MAS_PG_CONTAINER:-mas-radar-pg}"
# Overridable because the maintainer's machine cannot rehearse the role-security job in the
# default cluster: PostgreSQL roles are cluster-wide, so giving `mas_radar_app` a password in
# the cluster that also holds the real `mas_radar_dev` would hand out a login to the real
# database. A second container on another port has no real database in it, so the rehearsal is
# harmless there. On CI the defaults are correct and neither variable is set.
port="${MAS_PG_PORT:-5432}"

# NOTE — THIS LIST MUST MATCH DISPOSABLE_MARKERS IN scripts/db/owner-url.ts.
# The TypeScript callers all import that constant, so they cannot drift. This file is shell and
# cannot import it, which is exactly how it fell behind: "drill" was added to the canonical list
# for the Faz 7 rehearsal and this copy kept refusing `mas_radar_rollback_drill` — a name that
# says "drill" outright. If you add a marker there, add it here in the same commit.
case "$db" in
  *verify*|*test*|*tmp*|*temp*|*disposable*|*scratch*|*sandbox*|*fixture*|*clone*|*restore*|*snapshot*|*probe*|*drill*) ;;
  *)
    echo "GÜVENLİK DURDURMASI: '$db' disposable işaretlerinden hiçbirini taşımıyor." >&2
    echo "Bu script hedefi DROP eder; adının harcanabilir olduğunu söylemesi gerekir." >&2
    exit 1
    ;;
esac

case "$db" in
  mas_radar_dev|postgres|template0|template1)
    echo "GÜVENLİK DURDURMASI: '$db' korunan bir veritabanı." >&2
    exit 1
    ;;
esac

# --force terminates any leftover backend still holding the database. Without it this line
# fails intermittently: a verify script that has just exited can leave its pool socket in the
# server's view for a moment, dropdb reports "database is being accessed by other users", and
# under `set -e` the whole job dies for a reason that has nothing to do with the code under
# test. Observed exactly once while building this script, which is once more than a release
# gate should tolerate.
docker exec "$container" dropdb -U postgres --force --if-exists "$db" >/dev/null
docker exec "$container" createdb -U postgres "$db"
docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$db" < scripts/db/local-bootstrap.sql

MIGRATION_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${port}/${db}" pnpm db:migrate >/dev/null

# The expectation is DERIVED from the migration directory rather than hard-coded to 87/0087.
# A hard-coded 87 starts lying the day migration 0088 lands: the assertion would fail on a
# correct database and the natural "fix" is to bump the number, which is how a gate quietly
# becomes a formality. Derived, it keeps asserting the property that actually matters — every
# migration on disk is recorded in the ledger, and nothing else is.
expected_count="$(find supabase/migrations -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
expected_max="$(find supabase/migrations -maxdepth 1 -name '*.sql' -printf '%f\n' | LC_ALL=C sort | tail -1 | cut -c1-4)"
actual="$(docker exec "$container" psql -At -U postgres -d "$db" \
  -c "select count(*)||'|'||max(version) from public.schema_migrations;")"

echo "ledger: expected=${expected_count}|${expected_max} actual=${actual} db=${db}"
if [ "$actual" != "${expected_count}|${expected_max}" ]; then
  echo "LEDGER ASSERTION FAILED: beklenen ${expected_count}|${expected_max}, gerçekleşen ${actual}" >&2
  exit 1
fi

# ── Reference seed + system actor ────────────────────────────────────────────────────────
#
# A migrated-but-empty database is NOT a valid starting state for these gates, and this was
# measured rather than assumed. Provisioning without the two steps below, the sweep came back
# 24 PASS / 4 FAIL, and every failure named a missing precondition rather than a defect:
#
#   phase36, phase38  "users tablosu boş — fixture yok"   (they need a real user row to attach
#                                                          saved views / conversations to)
#   phase26           "7/30/90 günlük ufuklar mevcut — "  (treasury_liquidity_gap is a view over
#                                                          cash_accounts; with no accounts it
#                                                          returns nothing and the horizon list
#                                                          comes back empty)
#
# The Faz 16 workflow already applied both before its phase loop; dropping them here would have
# been a regression dressed up as simplification. They are reference data — accounts, categories,
# parties, settings, one system actor — not financial fixtures, so they change no assertion that
# is about money.
docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/seed.sql
MIGRATION_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${port}/${db}" \
  pnpm exec tsx scripts/db/seed-system-actor.ts >/dev/null

# ── Low-privilege runtime role ───────────────────────────────────────────────────────────
#
# phase35:verify runs an RLS BEHAVIOUR test as `mas_radar_app` and refuses to skip it when no
# password is available ("güvenlik kontrolü SESSİZCE ATLANAMAZ" — the right call: a security
# check that silently downgrades to a no-op is worse than no check, because it reports green).
# Giving the role its password here is what lets that assertion actually run.
if [ -n "${MAS_RADAR_APP_DB_PASSWORD:-}" ]; then
  MIGRATION_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${port}/${db}" \
  MAS_RADAR_APP_DB_PASSWORD="$MAS_RADAR_APP_DB_PASSWORD" \
    pnpm db:app-role:password >/dev/null
fi
