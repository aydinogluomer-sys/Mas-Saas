# MAS Nexus — V2 Production Hardening Handoff Report (`AGENT_10` · Valid Imports & 6D Data Quality Engineer)

- **Agent:** `AGENT_10` (`Agent 10` — Valid Imports & Data Quality Engineer)
- **Branch:** `remediation/v2-hardening` (Parent `HEAD`: `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Assigned Scope:** `F-15` (`P0/O` code-side freshness & `BLANK != ZERO` invariants), `F-16` (`P1/O` duplicate check candidate human-review queue without auto-merge), and `RG-09` (`Data-Quality Transparency` across all 6 dimensions)
- **Code & Gate Deliverable Verdict (`RG-09`):** **`PASS`** (`11 / 11` tests in `tests/remediation/agent10-data-quality.test.ts` + `16 / 16` in `tests/remediation/mandatory-16-scenarios.test.ts` = `27 / 27` green; `8 / 8` `boundary:verify` `PASS`; `9 / 9` `phase17:verify` `PASS`; `0` ESLint errors/warnings; `0` TypeScript errors in owned files)
- **Live Data Operational Steward Status (`F-15`, `F-16` on `mas_radar_dev`):** **`OPEN_FOR_HUMAN_STEWARD` / `BLOCKED` on authorized finance inputs** (code-side guards `PASS` and surface staleness/missingness/duplicates fail-closed; live database intentionally untouched pending authorized fresh workbook import, verified cash opening statements, and physical check voucher review per `Agent 14`)
- **Safety & Privacy Invariants:** `prod_db_writes = 0` (`default_transaction_read_only = on` + `SQLSTATE 25006` write-rejection probe + pre/post 15-metric DB digest equality), `real_network_sends = 0`, `100%` redacted (`0` real counterparty/person names, `0` unmasked workbook titles/OS paths, `0` live full UUIDs, `0` secrets).

---

## 1. Mandatory V2 JSON Handoff Contract (`AGENT_10 -> AGENT_00`)

```json
{
  "schemaVersion": "mas-v2-agent-handoff-v1",
  "agent": "AGENT_10",
  "agentId": "Agent 10",
  "role": "Valid Imports & Data Quality Engineer",
  "branch": "remediation/v2-hardening",
  "audit_base_commit": "39c780f668011c52fd7e9ba2b7343009b88e1dde",
  "parent_commit": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "parentCommitSha": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "measuredAtISO": "2026-11-20T05:32:00.000Z",
  "task_ids": ["F-15", "F-16"],
  "release_gate_ids": ["RG-09"],
  "status": "PASS",
  "deliverables_status": "PASS",
  "operational_data_status": "BLOCKED",
  "prod_db_writes": 0,
  "real_network_sends": 0,
  "write_allowlist": [
    "src/lib/data-quality/remediation-metrics.ts",
    "tests/remediation/agent10-data-quality.test.ts",
    "docs/remediation/v2-agent10-data-quality.md"
  ],
  "exclusive_write_allowlist": [
    "src/lib/data-quality/remediation-metrics.ts",
    "tests/remediation/agent10-data-quality.test.ts",
    "docs/remediation/v2-agent10-data-quality.md"
  ],
  "files_modified": [
    "src/lib/data-quality/remediation-metrics.ts",
    "tests/remediation/agent10-data-quality.test.ts"
  ],
  "files_created": [
    "docs/remediation/v2-agent10-data-quality.md"
  ],
  "files_modified_outside_allowlist": [],
  "read_only_enforcement": {
    "sessionOption": "-c default_transaction_read_only=on",
    "negativeWriteProbeSqlState": "25006",
    "beforeAfterDigestIdentical": true,
    "mutationsPerformed": 0
  },
  "findings": {
    "F-15": {
      "priority": "P0/O",
      "code_invariant_status": "PASS",
      "operational_steward_status": "BLOCKED",
      "confidence": "D",
      "summary": "Hardened valid-import freshness and BLANK != ZERO evaluators in src/lib/data-quality/remediation-metrics.ts: (1) empty (0 import_rows), all-rejected (nonRejectedImportRowCount = 0), failed, pending, or corrupt-timestamp workbooks never advance latestValidImport or clear the >= 45d stale warning (44d -> FRESH / isStale: false; 45d -> STALE / isStale: true); (2) evaluateValidImportFreshnessFromDb fails closed on 42P01/42703 (isStale: true, freshnessStatus: 'SCHEMA_INCOMPATIBLE', latestValidImport: null, or DomainError('CONFLICT') when failOnSchemaDrift is enabled) and on 42501 / unreadable / null-parity responses (isStale: true, freshnessStatus: 'UNKNOWN'); (3) added CashAccountCompletenessMetrics (evaluateCashAccountCompleteness) and amount_status='missing' enforcement so NULL/missing obligation amounts and cash_accounts.opening_balance IS NULL (6/6 active TRY accounts on live DB -> PARTIAL_MISSING_OPENING) are surfaced explicitly without ever coercing NULL to 0."
    },
    "F-16": {
      "priority": "P1/O",
      "code_invariant_status": "PASS",
      "operational_steward_status": "BLOCKED",
      "confidence": "D",
      "summary": "Hardened evaluateUniquenessDimension for canonical (party_id, amount, maturity_date) and Turkish-normalized counterparty clustering while respecting distinct non-empty check serial numbers (mirroring public.control_duplicate_checks). Exposed duplicateCheckHumanReviewCandidates with auditable reviewStatus ('PENDING_HUMAN_DOCUMENT_REVIEW' | 'OPEN_MAPPING_REVIEW' | 'ACCEPTED_DISTINCT_INSTRUMENT' | 'RESOLVED_EXCLUDED_DUPLICATE'), humanReviewRequiredCount, autoMergedCount: 0, autoDeletedCount: 0, and mutationsPerformed: 0. Verified mapAcceptedChecks excludes 'resolved' duplicate_check reviews unless explicitly 'accepted'."
    }
  },
  "release_gate_signals": [
    {
      "id": "RG-09",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "pnpm exec vitest run tests/remediation/agent10-data-quality.test.ts tests/remediation/mandatory-16-scenarios.test.ts -> 27/27 tests PASS (10 deterministic CI-safe tests + 1 live read-only 6D verification + 16 mandatory scenarios); hasZeroJoinMultiplication === true (536 = 536), isConsistent === true (30/30 months aligned), blank != zero preserved across templates/instances/cash_accounts, autoMergedCount === 0, autoDeletedCount === 0, mutationsPerformed === 0."
    }
  ],
  "edge_cases_reproduced_and_fixed": [
    {
      "id": "EC-10-01",
      "symbol": "evaluateValidImportFreshnessFromDb (42P01 / 42703 / 42501 / null parity)",
      "defectBeforeFix": "evaluateValidImportFreshnessFromDb had no SQL error handling (throwing raw uncaught 42P01/42703 errors instead of structured fail-closed freshness state), coerced null/undefined in_valid_view via Boolean(r.in_valid_view) to false, and lacked freshnessStatus and latestValidImport.",
      "minimalFix": "Added fail-closed error classification returning isStale: true, viewParityVerified: false, latestValidImport: null, and freshnessStatus: 'SCHEMA_INCOMPATIBLE' on 42P01/42703/42883/42804 (or throwing DomainError('CONFLICT', 'SCHEMA_INCOMPATIBLE: ...') when failOnSchemaDrift / failClosedOnSchemaError is true) and freshnessStatus: 'UNKNOWN' on 42501, malformed rows, or null/unverified view parity."
    },
    {
      "id": "EC-10-02",
      "symbol": "evaluateTimelinessDimension & isWorkbookValidImport (>= 45d threshold, all-rejected rows & corrupt timestamps)",
      "defectBeforeFix": "evaluateTimelinessDimension used latestValidImportAgeDays > staleThresholdDays (treating exact 45-day-old workbooks as fresh instead of >= 45d stale), threw RangeError if any failed/pending row had an empty/corrupt importedAt, and did not exclude workbooks whose import_rows were 100% rejected/errored.",
      "minimalFix": "Changed staleness predicate to latestValidImportAgeDays >= staleThresholdDays (44d -> FRESH, 45d -> STALE), excluded workbooks with nonRejectedImportRowCount < 1, safely sorted via parseTimestampMsOrNull, and failed closed to freshnessStatus: 'UNKNOWN' (isStale: true) if a candidate parsed/mapped workbook has an unparseable timestamp."
    },
    {
      "id": "EC-10-03",
      "symbol": "evaluateInstanceCompleteness & evaluateCashAccountCompleteness (BLANK != ZERO)",
      "defectBeforeFix": "remediation-metrics.ts did not inspect amount_status = 'missing' when paired with numeric strings and had zero completeness tracking for cash_accounts.opening_balance IS NULL.",
      "minimalFix": "Treated normalizedAmountStatus === 'missing' as missing alongside moneyOrNull(amount) === null, added evaluateCashAccountCompleteness + cashAccountGrain on CompletenessDimensionMetrics, and queried public.cash_accounts read-only in evaluateRemediationDataQuality (surfacing 6/6 missing opening balances as PARTIAL_MISSING_OPENING without coercing NULL to 0)."
    },
    {
      "id": "EC-10-04",
      "symbol": "evaluateUniquenessDimension (F-16 party_id clustering, serial_no disambiguation & human-review state)",
      "defectBeforeFix": "CheckUniquenessCandidate lacked partyId (missing (party_id, amount, maturity_date) duplicates when free-text counterparty labels differed), grouped checks even when two non-empty serial numbers were distinct, and lacked auditable humanReviewRequiredCount / duplicateCheckHumanReviewCandidates / autoDeletedCount / mutationsPerformed.",
      "minimalFix": "Canonicalized counterparty keys by partyId when present, separated checks with distinct non-empty serialNo values (matching public.control_duplicate_checks), and emitted duplicateCheckHumanReviewCandidates with reviewStatus, requiresHumanReview, autoMergedCount: 0, autoDeletedCount: 0, and mutationsPerformed: 0."
    },
    {
      "id": "EC-10-05",
      "symbol": "tests/remediation/agent10-data-quality.test.ts (Disposable CI Static Job Coverage)",
      "defectBeforeFix": "The entire file was gated behind describe.skipIf(!hasLiveDbConfig()), causing CI static unit-test runs without DATABASE_URL to skip all pure data-quality tests.",
      "minimalFix": "Moved all 10 deterministic unit and mock-pool adversarial tests into an unconditional describe suite (0 DB dependency) while keeping the live read-only 6-dimension PostgreSQL test under describe.skipIf(!hasLiveDbConfig()) with SQLSTATE 25006 write-protection verification."
    }
  ],
  "verification": {
    "redBaselineCommand": "pnpm exec vitest run tests/remediation/agent10-data-quality.test.ts",
    "redBaselineResult": "exit_code = 1 (5 failed | 6 passed out of 11 tests before patching src/lib/data-quality/remediation-metrics.ts)",
    "greenVitestCommand": "pnpm exec vitest run tests/remediation/agent10-data-quality.test.ts tests/remediation/mandatory-16-scenarios.test.ts",
    "greenVitestResult": "exit_code = 0 (2/2 test files passed, 27/27 tests passed)",
    "boundaryCommand": "pnpm boundary:verify",
    "boundaryResult": "exit_code = 0 (8/8 PASS)",
    "phase17Command": "pnpm phase17:verify",
    "phase17Result": "exit_code = 0 (9/9 PASS)",
    "eslintCommand": "pnpm exec eslint src/lib/data-quality/remediation-metrics.ts tests/remediation/agent10-data-quality.test.ts",
    "eslintResult": "exit_code = 0 (0 errors, 0 warnings)"
  },
  "rollback_plan": "Restore src/lib/data-quality/remediation-metrics.ts and tests/remediation/agent10-data-quality.test.ts to 65f29251ad9a98b4a87d50b25a807c5f00da631a and remove docs/remediation/v2-agent10-data-quality.md. Pure TypeScript changes only; zero database migrations or row mutations were executed."
}
```

---

## 2. Test-First Red -> Green Evidence (`F-15`, `F-16`, `RG-09`)

1. **Step 1 — Failing Negative Baseline (`exit_code = 1`, prior to production code edits):**
   - Added adversarial specifications `Tests 7..10` and V2 read-only assertions in `Test 11` to `tests/remediation/agent10-data-quality.test.ts` and ran `pnpm exec vitest run tests/remediation/agent10-data-quality.test.ts`:
     - `Test 7` (`42P01` / `42703` / `42501` / `null` view parity on `evaluateValidImportFreshnessFromDb`): **FAILED** (uncaught `42P01` relation error instead of fail-closed `isStale: true`, `freshnessStatus: "SCHEMA_INCOMPATIBLE"`).
     - `Test 8` (`44d` vs `45d` stale threshold + all-rejected `import_rows` + empty timestamp): **FAILED** (`freshnessStatus` undefined, `45d` boundary previously used `>` instead of `>=`, and empty timestamp threw `RangeError`).
     - `Test 9` (`amount_status = 'missing'` + `cash_accounts.opening_balance IS NULL`): **FAILED** (`missingAmountCount` returned `1` instead of `2`, and `cashAccountGrain` was absent).
     - `Test 10` (`(party_id, amount, maturity_date)` duplicate check human-review queue vs distinct `serial_no`): **FAILED** (`autoDeletedCount`, `mutationsPerformed`, `partyId` clustering, and `duplicateCheckHumanReviewCandidates` absent).
     - `Test 11` (live read-only 6D evaluator): confirmed `SQLSTATE 25006` read-only enforcement (`0` writes) and failed on missing V2 report fields.

2. **Step 2 — Surgical Hardening (`exit_code = 0`):**
   - Patched `src/lib/data-quality/remediation-metrics.ts` strictly within single-writer scope (`0` `process.env`, `0` `fetch`, `0` `::float8` casts, `0` SQL write statements).
   - Re-ran `pnpm exec vitest run tests/remediation/agent10-data-quality.test.ts tests/remediation/mandatory-16-scenarios.test.ts` -> **`27 / 27` PASS (`exit_code = 0`)**.

---

## 3. Redacted Live Read-Only 6-Dimension Summary (`mas_radar_dev`, `prod_db_writes = 0`)

Measured under `-c default_transaction_read_only=on` (verified with `DELETE ... WHERE false` -> `SQLSTATE 25006` and identical pre/post 15-metric digest):

| Dimension | Key Verified Invariants & Redacted Telemetry | Status |
|---|---|---|
| **1. Completeness (`BLANK != ZERO`)** | `payments` template grain (`19` total, `18` active outflow, `1` archived, `12` missing default amount) strictly separated from `payment_instances` grain (`536` total, `511` active outflow, `25` cancelled excluded, `330` missing amount; `2026-11` scope: `18` total, `17` active, `1` cancelled, `11` missing). `cash_accounts` grain: `6` active TRY accounts, `6 / 6` `opening_balance IS NULL` -> `sourceStatus = "PARTIAL_MISSING_OPENING"` (`0` coerced zeros). | **`PASS` (Transparently Surfaced)** |
| **2. Validity** | `1,601` `import_rows` (`1,021` mapped, `525` unmapped, `55` needs_review, `0` rejected/error); `62` `mapping_reviews` (`52` open + `1` rejected = `53` blocking, `2` accepted, `7` resolved); `0` invalid currencies, `0` invalid statuses across `payments`, `payment_instances`, `checks`. | **`PASS`** |
| **3. Uniqueness (`F-16`)** | `7` total checks (`6` active, `1` archived); `2` active duplicate candidate clusters (`[COUNTERPARTY_REDACTED_1]` `count = 3` on `2026-08-31`; `[COUNTERPARTY_REDACTED_2]` `count = 2` on `2026-07-31`; `4` pairs in `public.control_duplicate_checks`, `5` involved active check rows). `humanReviewRequiredCount = 2`, `autoMergedCount = 0`, `autoDeletedCount = 0`, `mutationsPerformed = 0`. | **`PASS` (Flagged for Human Review)** |
| **4. Consistency** | `30 / 30` months aligned between `monthSummary()` and status bucket sums (`mismatchedMonthCount = 0`, `unexplainedGapTry = 0` across all months); `rawInstanceCount = joinedInstanceCount = distinctInstanceIdCount = distinctTemplateMonthPairCount = 536` (`joinMultipliedRowCount = 0`, `hasZeroJoinMultiplication = true`). | **`PASS`** |
| **5. Timeliness (`F-15`)** | `1` valid workbook (`f7af8764-...`, `[WORKBOOK_REDACTED].xlsx`, `1,601` rows), `124` days old at reference `asOf` (`> 120d`, `staleThresholdDays = 45`) -> `isStale = true`, `freshnessStatus = "STALE"`, `viewParityVerified = true`. Empty/failed/all-rejected uploads cannot advance `latestValidImport`. | **`PASS` (Stale Alarm Held Open)** |
| **6. Source Traceability** | `19 / 19` templates directly workbook-traced, `536 / 536` instances template-inherited workbook-traced (`68` generated recurring, `468` workbook-sourced), `7 / 7` checks workbook-traced; demo/seed annotations inventoried read-only (`mutationsPerformed = 0`). | **`PASS`** |

---

## 4. Downstream Handoff Notes (`Agent 08`, `Agent 11`, `Agent 12`, `Agent 14`)

- **For `Agent 08` (CFO Reporting) & `Agent 11` (Independent QA `RG-09`):**
  - `evaluateValidImportFreshnessFromDb` and `evaluateTimelinessDimension` now return `freshnessStatus: "FRESH" | "STALE" | "NO_VALID_IMPORTS" | "SCHEMA_INCOMPATIBLE" | "UNKNOWN"` and `latestValidImport: ValidWorkbookImportSummary | null`, while keeping all existing `TimelinessDimensionMetrics` properties 100% backward-compatible with `scripts/qa/verify-rg-15-gates.ts`.
  - `evaluateRemediationDataQuality` now includes `completeness.cashAccountGrain` (`CashAccountCompletenessMetrics`), `uniqueness.duplicateCheckHumanReviewCandidates`, `uniqueness.humanReviewRequiredCount`, `uniqueness.autoDeletedCount === 0`, and `mutationsPerformed === 0`.
- **For `Agent 12` (GitHub CI):**
  - `tests/remediation/agent10-data-quality.test.ts` now executes `10` deterministic tests unconditionally in `static` CI jobs even when `DATABASE_URL` is unset, and adapts its `11th` read-only DB test cleanly to both disposable CI databases and `mas_radar_dev`.
