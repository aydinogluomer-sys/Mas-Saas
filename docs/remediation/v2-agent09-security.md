# MAS Nexus — V2 Production Hardening Handoff Report (`Agent 09` · Product Security, Authorization & Approvals Engineer)

- **Agent:** `Agent 09` (Product Security, Multi-Entity RLS, Maker-Checker & IBAN Negative Gates)
- **Branch:** `remediation/v2-hardening` (Parent `HEAD`: `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Assigned Scope:** `F-17` (`P1` — Historical Bypass Auditability & Maker-Checker / IBAN Negative Gates) and `RG-11` (`P1` — Authorization Safety, 5-Role RBAC & Multi-Legal-Entity `RESTRICTIVE` RLS Isolation)
- **Overall Agent Verdict:** **`PASS`** (`19 / 19` tests green across `agent09-security-isolation.test.ts` + `v2-rls-maker-checker.test.ts`, `124 / 124` existing security/approvals/controls regression tests green, `pnpm typecheck` exit `0`)
- **Safety & Privacy Invariants:** `prod_db_writes = 0` (`BEGIN READ ONLY` + `pg_stat_database` tuple-delta `0:0:0` verified before and after), disposable PostgreSQL DB `mas_radar_v2_agent09_sec_verify` provisioned and dropped cleanly (`remaining = 0`), `mas_radar_app` & all 5 tier roles verified `rolsuper = false` and `rolbypassrls = false`, `real_network_sends = 0`, `100%` redacted/synthetic identifiers (`F-01` & `.gitleaks.toml` compliant).

---

## 1. Mandatory V2 Structured Handoff Contract (`Agent 09 -> Agent 00`)

```json
{
  "schemaVersion": "mas-v2-agent-handoff-v1",
  "agentId": "Agent 09",
  "agent": "AGENT_09",
  "role": "Product Security, Authorization & Approvals Engineer",
  "branch": "remediation/v2-hardening",
  "audit_base_commit": "39c780f668011c52fd7e9ba2b7343009b88e1dde",
  "parentCommitSha": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "measuredAtISO": "2026-11-20T05:16:12.000Z",
  "task_ids": ["F-17", "RG-11"],
  "status": "PASS",
  "prod_db_writes": 0,
  "real_network_sends": 0,
  "disposable_db": {
    "name": "mas_radar_v2_agent09_sec_verify",
    "provisionedVia": [
      "scripts/db/pg-local-admin.ts",
      "scripts/db/local-bootstrap.sql",
      "scripts/db/migrate.ts"
    ],
    "sessionAdvisoryLock": "pg_advisory_lock(hashtext('mas_radar_v2_agent09_sec_verify')::bigint)",
    "droppedInFinally": true,
    "postDropDatabaseCount": 0
  },
  "exclusive_write_allowlist": [
    "src/lib/approvals/engine.ts",
    "src/lib/controls/rules.ts",
    "src/lib/db.ts",
    "tests/remediation/agent09-security-isolation.test.ts",
    "tests/security/v2-rls-maker-checker.test.ts",
    "docs/remediation/v2-agent09-security.md"
  ],
  "files_modified": [
    "src/lib/approvals/engine.ts",
    "src/lib/controls/rules.ts",
    "tests/remediation/agent09-security-isolation.test.ts"
  ],
  "files_created": [
    "tests/security/v2-rls-maker-checker.test.ts",
    "docs/remediation/v2-agent09-security.md"
  ],
  "files_verified_unchanged_in_allowlist": [
    "src/lib/db.ts"
  ],
  "files_modified_outside_allowlist": [],
  "findings": {
    "F-17": {
      "priority": "P1",
      "status": "PASS",
      "confidence": "D",
      "summary": "Historical pre-gate control_approval_bypass record (33ad79cf-..., 120,000.00 TRY) and its open control_alerts finding remain completely untouched and auditable (verified strictly via BEGIN READ ONLY with 0 tuple mutations). Forward-going >= 100,000 TRY outflow settlements are locked by dual-layer negative gates (markInstancePaid -> DomainError('FORBIDDEN') and PostgreSQL trigger enforce_outflow_settlement_approval_gate -> SQLSTATE 42501 on paid, partial, and spoofed approval_status). Self-approval (maker === checker) is unconditionally rejected when >= 2 active approvers exist, governance fallbacks now fail CLOSED on 42P01/42703/empty/zero-count, split maker-vs-requester self-approval on payment_runs.created_by is blocked, and unverified/invalid-MOD-97/mismatched-beneficiary IBAN writebacks are hard-blocked."
    }
  },
  "release_gate_signals": [
    {
      "id": "RG-11",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "pnpm exec vitest run tests/remediation/agent09-security-isolation.test.ts tests/security/v2-rls-maker-checker.test.ts -> 2/2 files, 19/19 tests PASS (0 skipped). Live disposable PG (mas_radar_v2_agent09_sec_verify) proved: (1) mas_radar_app + all 5 tier roles have rolsuper=false & rolbypassrls=false; (2) 0 cross-entity reads, 0 cross-entity updates/deletes, and 42501 cross-entity insert rejection across all 5 roles (viewer..admin) on payments, payment_instances, checks, invoices, and cash_accounts with positive controls; (3) viewer blocked from INSERT/UPDATE/DELETE; (4) >=100,000 TRY unapproved settlement blocked by DB trigger (42501) while maker != checker approved transition succeeds; (5) invalid MOD-97 & unverified/mismatched IBAN writebacks rejected."
    }
  ],
  "edge_cases_reproduced_and_fixed": [
    {
      "id": "EC-09-01",
      "symbol": "evaluateSelfApprovalEligibility & loadApprovalGovernanceSettings (src/lib/approvals/engine.ts)",
      "defectBeforeFix": "Catching 42P01/42703 on approval_governance_settings or reading an empty singleton row defaulted allowSingleOperatorSelfApproval to true (fail-open), and activeApproverCount === 0 passed activeApproverCount > 1.",
      "minimalFix": "Changed 42P01/42703 and missing-row fallbacks to allow_single_operator_self_approval = false (fail-closed) and required activeApproverCount === 1 alongside actorRole === 'admin' for the single-operator exception."
    },
    {
      "id": "EC-09-02",
      "symbol": "decideApproval (src/lib/approvals/engine.ts)",
      "defectBeforeFix": "When User A created a payment_runs draft (payment_runs.created_by = A) and Operator B submitted it for approval (approvals.requested_by = B), User A calling decideApproval bypassed a.requested_by === actorId and skipped maker-checker self-approval enforcement.",
      "minimalFix": "Inspected payment_runs.created_by inside decideApproval when subject_table === 'payment_runs' and decision === 'approved', enforcing evaluateSelfApprovalEligibility (DomainError('FORBIDDEN') when >= 2 approvers exist) whenever created_by === actorId."
    },
    {
      "id": "EC-09-03",
      "symbol": "applySubjectWriteback & applyApprovedOptimizationRecommendationsInTx (src/lib/approvals/engine.ts)",
      "defectBeforeFix": "Approving a payment_runs or ibans record promoted payment_run_items.iban_verified = true by joining pri.iban_id = ib.id without verifying ib.verified_at IS NOT NULL or normalized equality between pri.beneficiary_iban and ib.iban_normalized, allowing a mismatched/unverified beneficiary_iban to be marked verified.",
      "minimalFix": "Required ib.verified_at IS NOT NULL and exact normalized IBAN equality (normalizeIban(pri.beneficiary_iban) === normalizeIban(ib.iban_normalized) and SQL upper(regexp_replace(beneficiary_iban, '\\s', '', 'g')) = $2) before iban_verified = true can be written."
    },
    {
      "id": "EC-09-04",
      "symbol": "evaluateIbanControlStatus (src/lib/controls/rules.ts)",
      "defectBeforeFix": "controls/rules.ts lacked a pure deterministic gate function binding MOD-97/TR-format validity, independent verification timestamp, and maker != checker status to control-alert & verified-writeback eligibility.",
      "minimalFix": "Added pure zero-dependency evaluateIbanControlStatus() in src/lib/controls/rules.ts (preserving phase31:verify no-LLM/no-env/no-float8 invariants)."
    },
    {
      "id": "EC-09-05",
      "symbol": "agent09-security-isolation.test.ts & v2-rls-maker-checker.test.ts",
      "defectBeforeFix": "V1 agent09-security-isolation.test.ts executed rolled-back INSERT/UPDATE probes against mas_radar_dev (advancing tuple/WAL counters on prod/dev DB).",
      "minimalFix": "Restricted mas_radar_dev access in agent09-security-isolation.test.ts exclusively to BEGIN READ ONLY + tuple-counter verification (prod_db_writes = 0) and moved all live DDL/DML/RLS/trigger/IBAN proofs into advisory-locked disposable DB mas_radar_v2_agent09_sec_verify in tests/security/v2-rls-maker-checker.test.ts."
    }
  ],
  "verification": {
    "redBaselineCommand": "pnpm exec vitest run tests/security/v2-rls-maker-checker.test.ts",
    "redBaselineResult": "exit_code = 1 (reproduced EC-09-01 fail-open governance, EC-09-02 split-maker payment_runs self-approval, EC-09-03 mismatched/unverified beneficiary_iban writeback, and missing evaluateIbanControlStatus before patching)",
    "greenSecuritySuiteCommand": "pnpm exec vitest run tests/remediation/agent09-security-isolation.test.ts tests/security/v2-rls-maker-checker.test.ts",
    "greenSecuritySuiteResult": "exit_code = 0 (2/2 test files passed, 19/19 tests passed, 0 skipped, disposable DB dropped cleanly, mas_radar_dev tuple write delta = 0)",
    "regressionSuiteCommand": "pnpm exec vitest run src/lib/controls/rules.test.ts src/lib/approvals/rules.test.ts tests/unit/wave5a-cfo-unblockers.test.ts tests/security/write-gates.test.ts tests/security/local-passwordless-guard.test.ts",
    "regressionSuiteResult": "exit_code = 0 (5/5 test files passed, 124/124 tests passed)",
    "eslintCommand": "pnpm exec eslint src/lib/approvals/engine.ts src/lib/controls/rules.ts src/lib/db.ts tests/remediation/agent09-security-isolation.test.ts tests/security/v2-rls-maker-checker.test.ts",
    "eslintResult": "exit_code = 0 (0 errors, 0 warnings)",
    "typecheckCommand": "pnpm typecheck",
    "typecheckResult": "exit_code = 0 on Agent 09 completion (0 TypeScript errors across src/** and all Agent 09 files; subsequent concurrent run showed WIP edits only in peer Agent 10 tests/remediation/agent10-data-quality.test.ts)"
  },
  "open_blockers": [],
  "rollback_plan": "Restore src/lib/approvals/engine.ts, src/lib/controls/rules.ts, and tests/remediation/agent09-security-isolation.test.ts to 65f29251ad9a98b4a87d50b25a807c5f00da631a, and remove tests/security/v2-rls-maker-checker.test.ts and docs/remediation/v2-agent09-security.md. Note: src/lib/db.ts (POOL_CONFIG_VERSION = 3 deadlock fix) was verified intact and left untouched; zero database migrations or live mas_radar_dev records were mutated."
}
```

---

## 2. Verified Security Invariants & Red-to-Green Evidence

### 2.1 `src/lib/db.ts` Pool Deadlock Fix Preservation
- Inspected `src/lib/db.ts` and verified `const POOL_CONFIG_VERSION = 3;` plus pre-checkout `const resolvedCtx = await contextFor();` prior to `connectWithRetry(base)` in both `scopedQuery` and `scopedConnect`.
- Left `src/lib/db.ts` completely untouched and locked both invariants with a structural regression test in `tests/security/v2-rls-maker-checker.test.ts` (`Part A · Test 1`).

### 2.2 Maker-Checker (`>= 100,000 TRY` Outflow & Governance Fail-Closed Hardening)
- **Self-Approval Rejection (`>= 2` Active Approvers):** Verified across both pure mocks and live disposable PostgreSQL (`mas_radar_v2_agent09_sec_verify`) that whenever `>= 2` active approver-eligible users (`finance_approver`, `finance_manager`, `admin`) exist:
  1. `evaluateSelfApprovalEligibility()` and `decideApproval()` unconditionally throw `DomainError("FORBIDDEN", ...)` even if `approval_governance_settings.allow_single_operator_self_approval` were `true`.
  2. `decideApproval()` also checks `payment_runs.created_by` so a draft creator cannot approve their own payment run when submitted by a second operator (`EC-09-02`).
  3. `updateApprovalGovernanceSettings()` refuses to re-enable `allowSingleOperatorSelfApproval` (`DomainError("FORBIDDEN")`).
  4. PostgreSQL RLS on `public.approvals` (`approvals_decide` / `approvals_decide_admin_single_operator`) blocks direct SQL self-approval updates (`0` rows affected).
  5. Missing/corrupted `approval_governance_settings` (`42P01`/`42703`, empty table, or `0` approver count) now fails **CLOSED** (`allowSingleOperatorSelfApproval = false` / `DomainError("FORBIDDEN")`) instead of failing open (`EC-09-01`).
- **Dual-Layer High-Value Outflow Settlement Gate (`>= 100,000 TRY`):**
  - Application gate (`markInstancePaid`) rejects unapproved `>= 100,000 TRY` outflows with `DomainError("FORBIDDEN")` while allowing `< 100,000 TRY` (`99,999.99 TRY`) and approved `>= 100,000 TRY` settlements.
  - PostgreSQL `BEFORE UPDATE` trigger `enforce_outflow_settlement_approval_gate()` (`0123`) rejects direct SQL `status = 'paid'`, `status = 'partial'`, and spoofed `payment_instances.approval_status = 'approved'` (without a matching `public.approvals(status = 'approved')` row) with `SQLSTATE 42501` (`APPROVAL_REQUIRED`), while permitting settlement once an independent `checker !== maker` approves.
- **Historical Audit Preservation (`F-17`):**
  - Verified strictly via `BEGIN READ ONLY` on `mas_radar_dev` that pre-gate historical `payment_instances` record `33ad79cf-...` (`120,000.00 TRY`) remains openly visible in `public.control_approval_bypass` and open in `public.control_alerts` (`prod_db_writes = 0`, `pg_stat_database` tuple delta `0:0:0`).

### 2.3 BEC IBAN Shield, MOD-97 Checksum & Verified Writeback Gate
- Invalid ISO 13616 MOD-97-10 IBANs are rejected by `isValidIbanChecksum()`, rejected at template creation (`createPayment` -> `DomainError("VALIDATION")`), and blocked from approval writeback (`decideApproval` -> `DomainError("VALIDATION")`, keeping `verified_at = NULL`).
- Newly registered valid counterparty IBANs enter `public.ibans` with `verified_at = NULL` and `approval_status = 'pending_approval'`, emit `audit_logs` (`add_iban`), open an `iban_changed` `control_alerts` finding, and surface `requires_verification = true` in `public.control_iban_changes` until an independent `checker !== maker` approves.
- Hardened `applySubjectWriteback()` and `applyApprovedOptimizationRecommendationsInTx()` (`EC-09-03`) so `payment_run_items.iban_verified` is promoted to `true` **only** when `ibans.is_active = true`, `ibans.approval_status = 'approved'`, `ibans.verified_at IS NOT NULL`, and normalized `beneficiary_iban` matches `ibans.iban_normalized`.

### 2.4 Multi-Legal-Entity & 5-Role `RESTRICTIVE` PostgreSQL RLS Proof (`mas_radar_v2_agent09_sec_verify`)
- Provisioned disposable database `mas_radar_v2_agent09_sec_verify` via `scripts/db/pg-local-admin.ts` + `scripts/db/local-bootstrap.sql` + `scripts/db/migrate.ts` under a session advisory lock (`pg_advisory_lock`) and verified `dropDisposableLocalDb` cleanup in `finally` (`remaining = 0`).
- Verified `mas_radar_app` and all 5 tier roles (`mas_radar_viewer`, `mas_radar_finance_operator`, `mas_radar_finance_approver`, `mas_radar_finance_manager`, `mas_radar_admin`) have `rolsuper = false` and `rolbypassrls = false`, with `mas_radar_app` `rolinherit = false` (`set_option = true, inherit_option = false` on all 5 tiers).
- Seeded `Entity A` and `Entity B` (`public.legal_entities`) and scoped rows across `payments`, `payment_instances`, `checks`, `invoices`, and `cash_accounts`:
  - **Positive Control:** Under `app.current_legal_entity_id = Entity A`, all 5 roles (`viewer` through `admin`) read `1` row of `Entity A` in all 5 tables.
  - **Negative Isolation:** Under `app.current_legal_entity_id = Entity B`, all 5 roles (`viewer` through `admin`) read **`0`** rows of `Entity A`, update **`0`** rows of `Entity A`, delete **`0`** rows of `Entity A`, and fail cross-entity `INSERT` into `Entity A` with `SQLSTATE 42501` — while reading `1` row of `Entity B`.
  - **Viewer Read-Only:** Verified `mas_radar_viewer` fails `INSERT` (`42501`) and cannot `UPDATE` or `DELETE` (`0` rows / `42501`) across financial and approval tables.

### 2.5 TestSprite Verification Note (`AGENTS.md`)
- Checked `.testsprite/config.json` and `testsprite --version` (`0.3.0`). Per `AGENTS.md` (*"`--target-url` must be publicly reachable (no localhost / RFC1918) and must already have the change deployed"*), MAS Nexus is a local-only PostgreSQL 16 deployment with no public/cloud staging URL (`src/lib/db.ts:1-3`) and `real_network_sends = 0` is enforced during V2 hardening; therefore all verification was executed deterministically via Vitest + live disposable PostgreSQL 16.
