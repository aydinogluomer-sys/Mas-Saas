#!/usr/bin/env bash
#
# Run the Class A (CI-safe, data-independent) phase verifies, each against its own freshly
# migrated disposable database.
#
# WHY A FRESH DATABASE PER PHASE AND NOT ONE SHARED DATABASE. `public.audit_logs` has been
# append-only since migration 0022 — BEFORE triggers refuse UPDATE, DELETE and TRUNCATE even
# for a superuser. Several of these scripts assert an exact audit row count. Run back to back
# in one database, phase N+1 sees phase N's audit rows, and the count assertions fail for a
# reason that has nothing to do with the code. The Faz 16 workflow already knew this; the
# per-phase database is inherited from it deliberately.
#
# WHICH SCRIPTS ARE HERE AND WHY THE LIST IS NOT `phase*:verify`. See
# docs/release-evidence/phase-verify-classification.md. Short version: the fourteen scripts
# that read the private workbooks under data/ CANNOT pass on a clean checkout, and making them
# "pass" with a synthetic fixture would be worse than leaving them out — they assert exact
# figures from the real files, so a fixture would turn a real assertion into a tautology. They
# stay a local gate (LOCAL_PRIVATE_DATA_GATE) and are listed in that document, not here.
#
# FAILURE PROPAGATION. No `|| true` anywhere. A controlled accumulator records every failure
# and the script exits non-zero if any phase failed, so one red phase cannot be hidden by a
# later green one, and the log still shows every result rather than stopping at the first.

set -uo pipefail

# Source-only checks: no connection string, no database, no container. Kept separate because
# provisioning a database for them would be theatre.
SOURCE_ONLY_PHASES="phase17 phase18"

# Database-backed, data-independent. Each gets a fresh database migrated to head.
DB_PHASES="phase11b phase13b phase14b phase14c phase14d phase14e \
phase19 phase20 phase21 phase22 phase23 phase24a phase25 phase26 phase27 phase28 phase29 \
phase30 phase31 phase32 phase33 phase34 phase35 phase36 phase37 phase38"

DB_NAME="${PHASE_VERIFY_DB:-mas_radar_phase_verify}"
APP_PASSWORD="${CI_APP_DB_PASSWORD:-ci-only-not-a-secret-0123456789}"

# DATABASE_URL is overridable for one specific, non-hypothetical reason. PostgreSQL roles are
# CLUSTER-wide, not database-wide. On the maintainer's machine the same `mas-radar-pg` cluster
# also holds the real `mas_radar_dev`, so giving `mas_radar_app` a password there in order to
# rehearse this job would hand a login to the real database as a side effect. On a CI runner
# the cluster is created and destroyed with the job and no real database exists in it, so the
# app-role URL is the right default there. Locally, export PHASE_VERIFY_DATABASE_URL to point
# at the owner identity instead. Nothing in Class A actually authenticates with this value —
# every one of them resolves through MIGRATION_DATABASE_URL (scripts/db/owner-url.ts prefers
# it) — but it is pinned to the same disposable database so a stale value in the environment
# can never become the fallback target.
APP_DB_URL="${PHASE_VERIFY_DATABASE_URL:-postgres://mas_radar_app:${APP_PASSWORD}@127.0.0.1:${MAS_PG_PORT:-5432}/${DB_NAME}}"

fail=0
passed=""
failed=""

for p in $SOURCE_ONLY_PHASES; do
  echo "::group::${p}:verify (source-only)"
  if pnpm "${p}:verify"; then
    echo "PASS ${p}:verify"; passed="$passed $p"
  else
    echo "FAIL ${p}:verify"; failed="$failed $p"; fail=1
  fi
  echo "::endgroup::"
done

for p in $DB_PHASES; do
  echo "::group::${p}:verify (fresh disposable database)"
  if ! bash scripts/ci/provision-verify-db.sh "$DB_NAME"; then
    echo "FAIL ${p}:verify — provisioning failed"; failed="$failed $p(provision)"; fail=1
    echo "::endgroup::"
    continue
  fi

  # Both identities are exported on purpose. MIGRATION_DATABASE_URL is what the verify scripts
  # resolve through requireDisposableOwnerDatabaseUrl(); DATABASE_URL is pinned to the SAME
  # disposable database because owner-url.ts falls back to it, and an owner URL left over in
  # the parent environment would otherwise win and point a TRUNCATE somewhere else entirely.
  # Pinning both is the documented rule in scripts/db/owner-url.ts, not a belt-and-braces guess.
  if MIGRATION_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${MAS_PG_PORT:-5432}/${DB_NAME}" \
     DATABASE_URL="$APP_DB_URL" \
     pnpm "${p}:verify"; then
    echo "PASS ${p}:verify"; passed="$passed $p"
  else
    echo "FAIL ${p}:verify"; failed="$failed $p"; fail=1
  fi
  echo "::endgroup::"
done

echo "──────────────────────────────────────────────"
echo "PASSED:$passed"
echo "FAILED:$failed"
echo "exit=$fail"
exit "$fail"
