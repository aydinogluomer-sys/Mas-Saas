# MAS Nexus — V2 Production Hardening Handoff Report (`Agent 04` · Financial Invariants & Cash Truth Engineer)

- **Agent:** `Agent 04` (Financial Invariants & Canonical KPIs Engineer)
- **Branch:** `remediation/v2-hardening` (Parent `HEAD`: `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Assigned Scope:** `F-03` (`P0` — Canonical Cash `UNKNOWN != 0`), `F-14` (`P1` — Live-Hybrid Schema-Drift Explicit Status), and `RG-05` / `I-009`..`I-012` Financial Reconciliation Preservation
- **Overall Agent Verdict:** **`PASS`** (`8 / 8` V2 negative & positive cash/schema tests green, `6 / 6` live read-only reconciliation tests green, `7 / 7` UI metric consistency tests green, `8 / 8` boundary checks `PASS`, `9 / 9` Phase 17 decimal checks `PASS`, `0` ESLint issues, `0` TypeScript errors across `src/**` and all Agent 04 files)
- **Safety & Privacy Invariants:** `prod_db_writes = 0` (enforced via `default_transaction_read_only = on` + pre/post financial table digest equality), `real_network_sends = 0`, `100%` redacted/synthetic identifiers in this V2 artifact (`F-01` hygiene).

---

## 1. V2 Structured Handoff Contract (`Agent 04 -> Agent 00`)

```json
{
  "schemaVersion": "mas-v2-agent-handoff-v1",
  "agentId": "Agent 04",
  "role": "Financial Invariants & Canonical KPIs Engineer",
  "branch": "remediation/v2-hardening",
  "parentCommitSha": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "measuredAtISO": "2026-11-20T05:09:30.000Z",
  "status": "PASS",
  "prod_db_writes": 0,
  "real_network_sends": 0,
  "exclusive_write_allowlist": [
    "src/lib/metrics/canonical-kpis.ts",
    "src/lib/cashflow/live-hybrid.ts",
    "src/lib/radar/queries.ts",
    "tests/financial/unknown-zero-source-integrity.test.ts",
    "tests/remediation/agent04-financial-reconciliation.test.ts",
    "docs/remediation/v2-agent04-financial-math.md"
  ],
  "files_modified": [
    "src/lib/metrics/canonical-kpis.ts",
    "src/lib/cashflow/live-hybrid.ts",
    "tests/remediation/agent04-financial-reconciliation.test.ts"
  ],
  "files_created": [
    "tests/financial/unknown-zero-source-integrity.test.ts",
    "docs/remediation/v2-agent04-financial-math.md"
  ],
  "files_verified_unchanged_in_allowlist": [
    "src/lib/radar/queries.ts"
  ],
  "files_modified_outside_allowlist": [],
  "findings": {
    "F-03": {
      "priority": "P0",
      "status": "PASS",
      "confidence": "D",
      "summary": "Eliminated every UNKNOWN -> 0 coercion path in loadCanonicalTreasuryCashKpi / loadCanonicalKpis (src/lib/metrics/canonical-kpis.ts): (a) 42703 fallback on missing unknown_opening_count now forces availableNowTry = null (and foreignBuckets[].availableNow = null), legacyUnverified = true, cashSourceStatus = 'LEGACY_UNVERIFIED'; (b) 42P01 missing view returns availableNowTry = null, cashSourceStatus = 'SCHEMA_INCOMPATIBLE' (or throws DomainError('CONFLICT', 'SCHEMA_INCOMPATIBLE: ...') when failOnSchemaDrift/failClosedOnSchemaError is enabled); (c) TRY row with available_now: null and unknown_opening_count: 0 returns availableNowTry = null and cashSourceStatus = 'SOURCE_UNAVAILABLE'; (d) unknown_opening_count > 0 returns availableNowTry = null, unknownCashAccountCount >= unknownOpeningCountTry, cashSourceStatus = 'PARTIAL_MISSING_OPENING'; (e) missing TRY row returns availableNowTry = null unless cash_accounts cleanly proves active_try_count = 0 && unknown_try_count = 0 on intact schema ('NO_ACTIVE_ACCOUNTS_VERIFIED'); (f) verified 0.00 balance across known active TRY accounts returns availableNowTry = 0 and cashSourceStatus = 'COMPLETE'."
    },
    "F-14": {
      "priority": "P1",
      "status": "PASS",
      "confidence": "D",
      "summary": "Eliminated silent rows: [] swallowing of 42P01 / 42703 schema errors in loadHybridCashMonths and loadHybridMonthDetail (src/lib/cashflow/live-hybrid.ts). Schema errors across cash_accounts, bank_transactions, liquidity_forecast_daily, financial_calendar, accounting_periods, cashflow_months, cashflow_lines (plus underlying payment_instances, checks, loan_installments, invoices) are tracked in schemaIncompatibleSources, surface sourceStatus = 'SCHEMA_INCOMPATIBLE', force openingBalance = null and per-month opening/closing = null (plus income/expense = null when live flow views fail), mark epistemicBasis = 'UNKNOWN' and confidence = 'SCHEMA_INCOMPATIBLE', and throw DomainError('CONFLICT', 'SCHEMA_INCOMPATIBLE: ...') when failOnSchemaDrift / failClosedOnSchemaError is enabled."
    }
  },
  "release_gate_signals": [
    {
      "id": "RG-05",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "pnpm exec vitest run tests/financial/unknown-zero-source-integrity.test.ts tests/remediation/agent04-financial-reconciliation.test.ts tests/ui/ia-and-metric-consistency.test.tsx -> 3/3 files, 21/21 tests PASS; unexplainedGapTry === 0 across 2026-06..2026-12; cancelledKnownTotal = 30,000 TRY preserved; live mas_radar_dev pre/post financial digest 100% identical."
    }
  ],
  "edge_cases_reproduced_and_fixed": [
    {
      "id": "EC-04-01",
      "symbol": "loadCanonicalTreasuryCashKpi (42703 fallback)",
      "defectBeforeFix": "Catching 42703 injected 0::int as unknown_opening_count and evaluated availableNowTry = available ?? 0, coercing unverified legacy balances or NULL cash into 0 TRY.",
      "minimalFix": "Tracked legacyFallback = true on 42703 and forced availableNowTry = null, foreignBuckets[].availableNow = null, legacyUnverified = true, cashSourceStatus = 'LEGACY_UNVERIFIED'."
    },
    {
      "id": "EC-04-02",
      "symbol": "loadCanonicalTreasuryCashKpi (42P01 & available_now = null)",
      "defectBeforeFix": "42P01 crashed uncategorized, and available ?? 0 on line 181 turned TRY rows with available_now = null and unknown_opening_count = 0 into 0 TRY.",
      "minimalFix": "Handled 42P01 as availableNowTry = null, cashSourceStatus = 'SCHEMA_INCOMPATIBLE' (or DomainError in strict mode), and required unknownOpeningCountTry === 0 && accountCountTry > 0 && Number.isFinite(tryAvailableParsed) before emitting numeric availableNowTry."
    },
    {
      "id": "EC-04-03",
      "symbol": "loadCanonicalTreasuryCashKpi (!sawTry empty/FX-only view)",
      "defectBeforeFix": "if (!sawTry) { availableNowTry = 0; } unconditionally emitted 0 TRY on empty or FX-only views without verifying active TRY cash_accounts.",
      "minimalFix": "Added read-only cash_accounts completeness check when !sawTry (or accountCountTry <= 0); returns 0 ('NO_ACTIVE_ACCOUNTS_VERIFIED') ONLY when active_try_count === 0 && unknown_try_count === 0 is explicitly returned by intact schema, otherwise null ('PARTIAL_MISSING_OPENING' | 'SCHEMA_INCOMPATIBLE' | 'SOURCE_UNAVAILABLE')."
    },
    {
      "id": "EC-04-04",
      "symbol": "loadHybridCashMonths & loadHybridMonthDetail (isMissingSchema)",
      "defectBeforeFix": "isMissingSchema(err) silently returned { rows: [] } and { total_opening: null, known_count: 0, unknown_count: 0 }, allowing imported opening balances or known cash_accounts openings to pair with missing bank_transactions / liquidity_forecast_daily as verified 0 flows under 'Canlı Banka (Actual)' / 'live_tms7'.",
      "minimalFix": "Recorded affected sources in schemaIncompatibleSources, exposed sourceStatus, openingBalance, epistemicBasis, and confidence, nulled opening/closing (and live income/expense on flow schema failure), prevented imported fallback from overwriting runningOpening during schema drift, and added failOnSchemaDrift / failClosedOnSchemaError strict throw mode."
    }
  ],
  "verification": {
    "redBaselineCommand": "pnpm exec vitest run tests/financial/unknown-zero-source-integrity.test.ts",
    "redBaselineResult": "exit_code = 1 (8/8 tests failed before patching canonical-kpis.ts and live-hybrid.ts)",
    "greenVitestCommand": "pnpm exec vitest run tests/financial/unknown-zero-source-integrity.test.ts tests/remediation/agent04-financial-reconciliation.test.ts tests/ui/ia-and-metric-consistency.test.tsx",
    "greenVitestResult": "exit_code = 0 (3/3 test files passed, 21/21 tests passed)",
    "boundaryCommand": "pnpm boundary:verify",
    "boundaryResult": "exit_code = 0 (8/8 PASS)",
    "phase17Command": "pnpm phase17:verify",
    "phase17Result": "exit_code = 0 (9/9 PASS)",
    "eslintCommand": "pnpm exec eslint src/lib/metrics/canonical-kpis.ts src/lib/cashflow/live-hybrid.ts src/lib/radar/queries.ts tests/financial/unknown-zero-source-integrity.test.ts tests/remediation/agent04-financial-reconciliation.test.ts",
    "eslintResult": "exit_code = 0 (0 errors, 0 warnings)",
    "typecheckNote": "0 TypeScript errors across src/** and all Agent 04 files (concurrent peer WIP errors observed only in Agent 01 scripts/db/migrate-verify.ts:618 and Agent 09 tests)"
  },
  "rollback_plan": "Restore src/lib/metrics/canonical-kpis.ts, src/lib/cashflow/live-hybrid.ts, and tests/remediation/agent04-financial-reconciliation.test.ts to 65f29251ad9a98b4a87d50b25a807c5f00da631a, and remove tests/financial/unknown-zero-source-integrity.test.ts and docs/remediation/v2-agent04-financial-math.md (pure TypeScript changes only; zero DB migrations or live data mutations)."
}
```

---

## 2. Test-First Red -> Green Evidence (`F-03` & `F-14`)

1. **Step 1 — Failing Negative Baseline (`exit_code = 1`, before production edits):**
   - Created [unknown-zero-source-integrity.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/financial/unknown-zero-source-integrity.test.ts) with 8 adversarial and control specifications (`F-03 (a)..(f)` and `F-14 (a)..(b)`).
   - Executed `pnpm exec vitest run tests/financial/unknown-zero-source-integrity.test.ts` against unpatched `65f29251ad9a98b4a87d50b25a807c5f00da631a`:
     - `F-03 (a)` (`42703` missing `unknown_opening_count`): **FAILED** (`received 0`, expected `null`).
     - `F-03 (b)` (`42P01` missing `treasury_position_summary`): **FAILED** (uncaught relation error instead of `SCHEMA_INCOMPATIBLE` / `null`).
     - `F-03 (c)` (`available_now: null, unknown_opening_count: 0`): **FAILED** (`received 0`, expected `null`).
     - `F-03 (d)` (`unknown_opening_count: 2` metadata): **FAILED** (`unknownCashAccountCount` & `cashSourceStatus` missing).
     - `F-03 (e)` (unverified empty view `!sawTry`): **FAILED** (`received 0`, expected `null`).
     - `F-14 (a)/(b)` (`42P01`/`42703` on `cash_accounts`, `bank_transactions`, `payment_instances`): **FAILED** (silently emitted `income: 0, expense: 0`, `"Canlı Banka (Actual)"`, and resolved instead of `SCHEMA_INCOMPATIBLE` / `DomainError`).
2. **Step 2 — Surgical Backward-Compatible Fixes (`exit_code = 0`):**
   - Updated [canonical-kpis.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/metrics/canonical-kpis.ts) with additive `cashSourceStatus: SourceCompletenessStatus`, `legacyUnverified: boolean`, `unknownCashAccountCount: number`, optional `CanonicalKpiLoadOptions` (`failClosedOnSchemaError` / `failOnSchemaDrift`), and `loadLiveCashPosition` alias while keeping all existing dashboard/overview/collections/insights callers 100% type-compatible.
   - Updated [live-hybrid.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/cashflow/live-hybrid.ts) with `schemaIncompatibleSources: string[]`, `sourceStatus: SourceCompletenessStatus`, `openingBalance: number | null`, `epistemicBasis: MonetaryEpistemicBasis`, `confidence: string`, optional `HybridCashflowLoadOptions`, and `loadLiveHybridCashflow` alias.
   - Verified [queries.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/radar/queries.ts) and extended [agent04-financial-reconciliation.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/remediation/agent04-financial-reconciliation.test.ts) (`Test 6`) to lock V2 `F-03` & `F-14` invariants (`availableNowTry === null`, `openingBalance === null`, `PARTIAL_MISSING_OPENING`, `schemaIncompatibleSources === []`) alongside the `30,000 TRY` `cancelledKnownTotal` and `unexplainedGapTry === 0` identity on live read-only `mas_radar_dev`.

---

## 3. Downstream Handoff Notes (`Agent 08`, `Agent 10`, `Agent 11`)

- **For `Agent 08` (CFO Reporting & Fact Lineage):**
  - `loadCanonicalTreasuryCashKpi` / `loadCanonicalKpis` (`@/lib/metrics/canonical-kpis`) now expose `cashSourceStatus: SourceCompletenessStatus`, `legacyUnverified: boolean`, and `unknownCashAccountCount: number`. Whenever `cashSourceStatus !== "COMPLETE" && cashSourceStatus !== "NO_ACTIVE_ACCOUNTS_VERIFIED"`, `availableNowTry` is guaranteed to be `null`.
  - `loadHybridCashMonths` / `loadHybridMonthDetail` (`@/lib/cashflow/live-hybrid`) now expose `sourceStatus`, `schemaIncompatibleSources`, `openingBalance`, `epistemicBasis`, and `confidence`, and support `{ failOnSchemaDrift: true }` / `{ failClosedOnSchemaError: true }`.
- **For `Agent 10` (Data Quality) & `Agent 11` (Independent QA):**
  - `UNKNOWN != 0` and `SCHEMA_INCOMPATIBLE` invariants are deterministically covered in `tests/financial/unknown-zero-source-integrity.test.ts` (zero DB dependency, `<50ms` runtime, safe for disposable CI and `RG-05`).
