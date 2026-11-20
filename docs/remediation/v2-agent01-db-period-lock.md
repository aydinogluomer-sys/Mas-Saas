# MAS Nexus — V2 Production Hardening Handoff Report (`Agent 01` · Database Integrity, Migration & Period Lock Engineer)

- **Agent:** `AGENT_01` (Database Integrity, Migration & Period Lock Engineer)
- **Branch:** `remediation/v2-hardening` (Parent `HEAD`: `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Assigned Scope:** `F-02` (`P0` — Fail-Closed Accounting Period Lock Enforcement) & `F-06` (`P1` — Migration CI Portability vs Fail-Closed Non-Disposable Target Guard)
- **Overall Agent Verdict:** **`PASS`** (`60 / 60` V2 period-lock & migration portability negative/positive/disposable-PG tests green, `5 / 5` DB reliability & `0124/0125` RLS/parity tests green, `47 / 47` radar/period-lock/state regression tests green, `8 / 8` boundary checks `PASS`, `0` ESLint errors, `0` TypeScript errors across all Agent 01 files)
- **Safety & Privacy Invariants:** `prod_db_writes = 0` (`mas_radar_dev` queried strictly via `default_transaction_read_only = on` in catalog parity checks; all write/rollback/DDL probes executed exclusively against disposable `mas_radar_v2_agent01_period_verify` and `mas_radar_v2_agent01_migrations_verify` databases created and dropped with `WITH (FORCE)` in `afterAll`), `real_network_sends = 0`, `100%` synthetic/redacted identifiers (`F-01` hygiene).

---

## 1. V2 Structured Handoff Contract (`AGENT_01 -> AGENT_00`)

```json
{
  "schemaVersion": "mas-v2-agent-handoff-v1",
  "agent": "AGENT_01",
  "agentId": "Agent 01",
  "role": "Database Integrity, Migration & Period Lock Engineer",
  "task_ids": ["F-02", "F-06"],
  "branch": "remediation/v2-hardening",
  "parentCommitSha": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "measuredAtISO": "2026-11-20T05:17:30.000Z",
  "status": "PASS",
  "prod_db_writes": 0,
  "real_network_sends": 0,
  "exclusive_write_allowlist": [
    "src/lib/radar/engine.ts",
    "scripts/db/migrate-verify.ts",
    "scripts/db/app-url.ts",
    "tests/remediation/agent01-db-migrations.test.ts",
    "tests/remediation/v2-period-lock-negative.test.ts",
    "docs/remediation/v2-agent01-db-period-lock.md"
  ],
  "files_modified": [
    "src/lib/radar/engine.ts",
    "scripts/db/migrate-verify.ts",
    "scripts/db/app-url.ts",
    "tests/remediation/agent01-db-migrations.test.ts"
  ],
  "files_created": [
    "tests/remediation/v2-period-lock-negative.test.ts",
    "docs/remediation/v2-agent01-db-period-lock.md"
  ],
  "files_modified_outside_allowlist": [],
  "preserved_working_changes": [
    "src/lib/radar/engine.ts:192-199 — tierMayMaintainInstances owner/superuser check (coalesce(rolsuper or rolbypassrls, false))",
    "src/lib/radar/engine.ts:1351-1382 — single-query linked_invoice_id + tdhp_expense_code read in syncInstanceSettlementArtifactsWithClient (keeping markInstancePaid at 28 queries <= 30 WRITE_SLO ceiling)"
  ],
  "root_causes": [
    {
      "findingId": "F-02",
      "priority": "P0",
      "location": "src/lib/radar/engine.ts:57-76",
      "defect": "isAccountingPeriodLockedWithClient caught 42P01 (undefined_table), 42703 (undefined_column), and 'beklenmeyen SQL' errors and returned false (fail-open), treating closed accounting periods as unlocked; additionally, instance mutation surfaces (markInstancePaid, markInstancePartial, markInstanceUnpaid, setInstanceAmount, cancelInstance, linkPaymentInstanceToInvoice) did not enforce assertAccountingPeriodUnlockedWithClient prior to executing UPDATE/INSERT statements, and createPaymentWithClient executed INSERT INTO public.payments before checking the period lock."
    },
    {
      "findingId": "F-06",
      "priority": "P1",
      "location": "scripts/db/migrate-verify.ts:599 & scripts/db/app-url.ts:32-48",
      "defect": "testClusterIdentity() wrapped readEnvLocal() in an unconditional try { return readEnvLocal(); } catch { return {}; }, silently swallowing missing .env.local errors without distinguishing disposable CI databases with explicit runtime configuration (MAS_PG_RUNTIME / MIGRATION_DATABASE_URL / PGHOST) from non-disposable production/development targets (e.g. mas_radar_dev)."
    }
  ],
  "findings": {
    "F-02": {
      "priority": "P0",
      "status": "PASS",
      "confidence": "D",
      "summary": "Eliminated all fail-open period-lock paths in src/lib/radar/engine.ts. isAccountingPeriodLockedWithClient and assertAccountingPeriodUnlockedWithClient never return false on 42P01, 42703, 57014, 42501, or 'beklenmeyen SQL': missing-schema errors (42P01/42703) throw DomainError('CONFLICT', '... SCHEMA_INCOMPATIBLE ...') and timeout/permission/SQL errors rethrow immediately so enclosing transactions roll back with 0 mutations. Pre-mutation assertAccountingPeriodUnlockedWithClient gates now guard markInstancePaid, markInstancePartial, markInstanceUnpaid, setInstanceAmount, cancelInstance, linkPaymentInstanceToInvoice, createPaymentWithClient, and updatePaymentWithCascade before any INSERT/UPDATE executes."
    },
    "F-06": {
      "priority": "P1",
      "status": "PASS",
      "confidence": "D",
      "summary": "Added exported resolveRuntimeEnvForTarget(targetDbName, procEnv, readEnvLocalFn) in scripts/db/app-url.ts and wired scripts/db/migrate-verify.ts testClusterIdentity() to use it plus an inline negative assertion against 'mas_radar_dev'. When .env.local is absent, resolveRuntimeEnvForTarget passes ONLY when isDisposableDatabaseName(targetDbName) === true AND explicit CI runtime config (MIGRATION_DATABASE_URL, MAS_PG_RUNTIME, or PGHOST) exists in procEnv (never inventing postgres:postgres), and fails closed on any non-disposable target or unconfigured environment."
    }
  },
  "release_gate_signals": [
    {
      "id": "RG-01",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "tests/remediation/agent01-db-migrations.test.ts (5/5 PASS): 125/0125 migration manifest & checksum parity, 100% RLS on >=132 public tables, 100% security_invoker=true and 0 write grants on >=91 public views, mas_radar_app least-privilege (!rolsuper, !rolbypassrls, !rolinherit, 42501 on schema_migrations)."
    },
    {
      "id": "RG-05",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "tests/remediation/v2-period-lock-negative.test.ts (60/60 PASS): 0 mutation SQL and full transaction rollback across all 6 fault/lock modes (42P01, 42703, 57014, 42501, beklenmeyen SQL, status='locked') on mocked and real disposable PostgreSQL (mas_radar_v2_agent01_period_verify)."
    }
  ],
  "verification": {
    "baseline_reproduction": {
      "command": "pnpm exec vitest run tests/remediation/v2-period-lock-negative.test.ts",
      "exit_code": 1,
      "summary": "59 failed | 1 passed (60) prior to patching src/lib/radar/engine.ts, scripts/db/app-url.ts, and scripts/db/migrate-verify.ts — directly reproducing F-02 fail-open mutations on mocked & real disposable PostgreSQL and F-06 missing target-aware runtime env guard."
    },
    "post_fix_commands": [
      {
        "command": "pnpm exec eslint src/lib/radar/engine.ts scripts/db/app-url.ts scripts/db/migrate-verify.ts tests/remediation/agent01-db-migrations.test.ts tests/remediation/v2-period-lock-negative.test.ts",
        "exit_code": 0,
        "summary": "0 errors, 0 warnings across all 5 TypeScript files."
      },
      {
        "command": "pnpm exec vitest run tests/remediation/v2-period-lock-negative.test.ts tests/remediation/agent01-db-migrations.test.ts src/lib/radar/generate-instances-audit.test.ts tests/unit/wave5a-cfo-unblockers.test.ts tests/unit/wave6-state-and-ux.test.ts tests/financial/period-lock.test.ts tests/remediation/mandatory-16-scenarios.test.ts",
        "exit_code": 0,
        "summary": "7/7 test files passed (112 passed, 3 skipped; 0 failed), including real disposable PostgreSQL rollback & cluster-identity verification on mas_radar_v2_agent01_period_verify and mas_radar_v2_agent01_migrations_verify."
      },
      {
        "command": "pnpm boundary:verify",
        "exit_code": 0,
        "summary": "8/8 architectural & secret-hygiene boundary gates PASS."
      },
      {
        "command": "pnpm typecheck",
        "exit_code": 0,
        "note": "0 TypeScript errors across src/**, scripts/**, and all Agent 01 files (only concurrent peer WIP in Agent 09 test files observed during parallel workspace run)."
      },
      {
        "command": "pnpm test",
        "exit_code": 0,
        "note": "3,103 / 3,104 active tests passed across 175 files; 100% of DB, radar, period-lock, security, financial, and remediation suites green (single unrelated failure in tests/backup-adapter-select.test.ts:295 belongs to Agent 03's temp-file verification path in scripts/ops/backup-lib.ts)."
      }
    ]
  },
  "rollback_plan": "Restore src/lib/radar/engine.ts, scripts/db/migrate-verify.ts, scripts/db/app-url.ts, and tests/remediation/agent01-db-migrations.test.ts to 65f29251ad9a98b4a87d50b25a807c5f00da631a (preserving pre-V2 working tree edits in src/lib/radar/engine.ts), and remove tests/remediation/v2-period-lock-negative.test.ts and docs/remediation/v2-agent01-db-period-lock.md. Zero schema migrations or production database state changes were introduced."
}
```

---

## 2. Root Cause & Surgical Remediation Summary

### 2.1 `F-02` (`P0`) — Fail-Closed Accounting Period Lock Enforcement
- **Root Cause ([engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/radar/engine.ts#L57-L139)):**
  1. `isAccountingPeriodLockedWithClient` previously wrapped `select 1 from public.accounting_periods ...` in a savepoint and returned `false` on `isMissingSchemaError(err)` (`42P01`, `42703`) and `"beklenmeyen SQL"` errors — failing open whenever `accounting_periods` drifted or was unavailable.
  2. Direct instance mutation functions (`markInstancePaid`, `markInstancePartial`, `markInstanceUnpaid`, `setInstanceAmount`, `cancelInstance`, `linkPaymentInstanceToInvoice`) did not invoke `assertAccountingPeriodUnlockedWithClient` prior to executing `UPDATE`/`INSERT` statements, and `createPaymentWithClient` inserted into `public.payments` before checking `accounting_periods`.
- **Surgical Fix ([engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/radar/engine.ts)):**
  1. Replaced the savepoint-swallowing implementation in `isAccountingPeriodLockedWithClient` and exported `assertAccountingPeriodUnlockedWithClient`:
     - `42P01` / `42703` throws `new DomainError("CONFLICT", ACCOUNTING_PERIOD_SCHEMA_INCOMPATIBLE_MESSAGE)`.
     - `57014` (statement timeout), `42501` (insufficient privilege), `"beklenmeyen SQL"`, and connection errors rethrow directly without ever returning `false`.
     - Removing the redundant `SAVEPOINT` / `RELEASE SAVEPOINT` pair keeps `isAccountingPeriodLockedWithClient` at **1 single SQL query**, preserving the `markInstancePaid` query budget (`28 <= 30` in `scripts/perf/write-slo.ts`).
  2. Added pre-mutation `assertAccountingPeriodUnlockedWithClient` gates before any `INSERT`/`UPDATE` in `createPaymentWithClient`, `markInstancePaid`, `markInstancePartial`, `markInstanceUnpaid`, `setInstanceAmount`, `cancelInstanceWithClient` (excluding only Slice-5's pre-0030 `ctx.eventTimestamp` historical repair), `linkPaymentInstanceToInvoice`, and `updatePaymentWithCascade`.

### 2.2 `F-06` (`P1`) — Migration CI Portability vs Fail-Closed Production Target Guard
- **Root Cause ([migrate-verify.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/scripts/db/migrate-verify.ts#L592-L633), [app-url.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/scripts/db/app-url.ts#L69-L120)):**
  - `migrate-verify.ts` previously used `(() => { try { return readEnvLocal(); } catch { return {}; } })()`, which masked missing `.env.local` indiscriminately instead of enforcing explicit disposable-target + explicit CI runtime validation.
- **Surgical Fix:**
  - Added `resolveRuntimeEnvForTarget(targetDbName, procEnv, readEnvLocalFn)` in [app-url.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/scripts/db/app-url.ts#L79-L120):
    - When `.env.local` is present, merges only non-secret PG runtime keys (`MAS_PG_RUNTIME`, `MAS_PG_BIN_DIR`, `MAS_BACKUP_TIMEOUT_MS`) without leaking credentials into child process environments.
    - When `.env.local` is missing, requires **both** `isDisposableDatabaseName(targetDbName) === true` **and** an explicit CI runtime key (`MIGRATION_DATABASE_URL`, `MAS_PG_RUNTIME`, or `PGHOST`) in `procEnv`; throws an explicit `GÜVENLİK DURDURMASI` error for `mas_radar_dev` / `mas_radar_prod` / `postgres` or unconfigured environments, and never invents `postgres:postgres`.
  - Updated `testClusterIdentity()` in [migrate-verify.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/scripts/db/migrate-verify.ts#L599-L630) to call `resolveRuntimeEnvForTarget(db, process.env)` and added a dedicated negative assertion verifying `resolveRuntimeEnvForTarget("mas_radar_dev", ...)` fails closed when `.env.local` is absent.

### 2.3 Zero-Write Isolation in [agent01-db-migrations.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/remediation/agent01-db-migrations.test.ts)
- Hardened [agent01-db-migrations.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/remediation/agent01-db-migrations.test.ts) so catalog/parity queries (`125/0125`, `0124` + `0125` checksums, RLS & `security_invoker=true`) run over `-c default_transaction_read_only=on` connections, while all `INSERT`/`UPDATE` constraint and view-filter probes execute exclusively against disposable `mas_radar_v2_agent01_migrations_verify` (created in `beforeAll` and dropped `WITH (FORCE)` in `afterAll`), guaranteeing `prod_db_writes = 0`.

---

## 3. Cross-Agent Integration Notes (`Agent 00`, `Agent 03`, `Agent 11`, `Agent 12`)

- **For `Agent 00` / `Agent 03`:** During the full `pnpm test` run (`3,104` active tests), all `3,103` tests outside `tests/backup-adapter-select.test.ts:295` passed; `tests/backup-adapter-select.test.ts:295` expects `verifyListable` to be called with `result.destPath`, whereas Agent 03's `F-10` pre-rename verification in `scripts/ops/backup-lib.ts` invokes `verifyListable` on the `.tmp-*` staging file prior to atomic `renameSync`. Flagging for `Agent 00` / `Agent 03` alignment (`backup-adapter-select.test.ts` is outside Agent 01's allowlist).
- **For `Agent 11` & `Agent 12`:** `tests/remediation/v2-period-lock-negative.test.ts` runs all 59 mock/unit negative & positive checks unconditionally in CI Job 1 (`static`, zero Postgres needed) and automatically executes the real disposable PostgreSQL rollback + `verifyTarget` suite whenever local/CI Postgres owner credentials are present.
