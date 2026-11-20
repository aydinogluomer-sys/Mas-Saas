# V2 Agent 11 Handoff — Independent QA, E2E Seed Guard & Release Gate Verification (`F-05`, `F-13`, `RG-01..RG-15`)

## 1. Mandatory V2 JSON Handoff Contract

```json
{
  "schema": "mas-v2-agent-handoff-v1",
  "agent": "AGENT_11",
  "parent_commit": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "branch": "remediation/v2-hardening",
  "task_ids": ["F-05", "F-13"],
  "write_allowlist": [
    "tests/visual/global-setup.ts",
    "tests/visual/v2-global-setup-guard.test.ts",
    "tests/interaction/harness.ts",
    "scripts/qa/verify-rg-15-gates.ts",
    "docs/remediation/qa-release-gates.md",
    "docs/remediation/v2-agent11-qa.md"
  ],
  "baseline": {
    "reproducer": "1) CI run 44442747378 failed in global-setup.ts:211 with SQLSTATE 42501 ('permission denied for table users') under mas_radar_app, while 65f2925 global-setup.ts:58-59 & harness.ts:74-75 silently fabricated 'postgres:postgres' when seed/migration env was absent and did not verify seed/app DB-name + cluster equality. 2) Running 'pnpm exec tsx scripts/qa/verify-rg-15-gates.ts' without --env-file=.env.local exited 1 at module load ('DATABASE_URL zorunlu').",
    "exit_code": 1,
    "log_ref": "GitHub Actions run 44442747378 + Phase 0 task-10290"
  },
  "root_cause": {
    "file_line": "tests/visual/global-setup.ts:42-61, tests/interaction/harness.ts:53-77, scripts/qa/verify-rg-15-gates.ts:39-40",
    "trigger": "Missing explicit owner-seed vs low-privilege runtime URL separation/validation in E2E harnesses, and eager top-level @/app/health/route import triggering @/lib/env validation before readEnvLocal() in verify-rg-15-gates.ts.",
    "confidence": "DIRECT"
  },
  "changes": [
    "tests/visual/global-setup.ts: Implemented fail-closed resolveOwnerSeedUrl() + SQL verifyOwnerSeedPoolIdentity() enforcing disposable DB names on both URLs, exact DB-name equality, host:port cluster equality (with localhost <-> 127.0.0.1 equivalence), rejection of low-privilege roles (mas_radar_app/tier roles), and removal of implicit postgres:postgres fallback.",
    "tests/interaction/harness.ts: Unified verifierUrl() to delegate directly to resolveOwnerSeedUrl().",
    "tests/visual/v2-global-setup-guard.test.ts: Added 7 positive/negative unit tests covering all F-05 URL and SQL pre-seed identity invariants without leaking secrets in error strings.",
    "scripts/qa/verify-rg-15-gates.ts: Hydrated DATABASE_URL from readEnvLocal() prior to dynamic imports of runtime modules, redacted live-row labels in gate output, and added all 5 V2 negative/chaos suites into RG-12.",
    "docs/remediation/qa-release-gates.md: Updated to V2 (125/0125, 3,142 Vitest tests, 14/15 PASS + RG-03 BLOCKED, redacted, explicit local-vs-CI distinction)."
  ],
  "tests": [
    {
      "command": "pnpm lint",
      "exit_code": 0,
      "evidence": "0 errors, 0 warnings across entire repository"
    },
    {
      "command": "pnpm typecheck",
      "exit_code": 0,
      "evidence": "tsc --noEmit exited 0 across entire repository"
    },
    {
      "command": "pnpm boundary:verify",
      "exit_code": 0,
      "evidence": "8/8 boundary checks PASS"
    },
    {
      "command": "pnpm exec vitest run tests/visual/v2-global-setup-guard.test.ts",
      "exit_code": 0,
      "evidence": "7/7 F-05 owner-seed guard tests PASS"
    },
    {
      "command": "pnpm test",
      "exit_code": 0,
      "evidence": "174 passed test files, 0 failed (3,142 passed tests, 0 failed)"
    },
    {
      "command": "pnpm exec tsx scripts/ci/verify-secret-exposure.ts",
      "exit_code": 0,
      "evidence": "1,663 tracked files scanned, 0 leaks (8/8 positive controls detected, 5/5 allowlists clean)"
    },
    {
      "command": "pnpm exec tsx scripts/qa/verify-rg-15-gates.ts",
      "exit_code": 2,
      "evidence": "PASS: 14 | BLOCKED: 1 (RG-03 physical off-device target absent) | FAIL: 0 | NOT VERIFIED: 0 · liveDbZeroMutation=true"
    }
  ],
  "prod_db_writes": 0,
  "real_network_sends": 0,
  "regressions": [],
  "open_blockers": [
    "RG-03 / F-11: Physical external backup target (USB/NAS) is unmounted on host (honestly reported as BLOCKED, exit 2).",
    "G-01 / F-04: Full 8/8 GitHub Actions workflow execution (including Playwright e2e-authz, legacy-semantic-smoke, and interaction-gate on provisioned disposable DBs) must complete green on the pushed V2 commit SHA."
  ],
  "status": "PASS",
  "handoff_dependencies": ["AGENT_00", "AGENT_12"],
  "rollback_plan": "git checkout 65f29251ad9a98b4a87d50b25a807c5f00da631a -- tests/visual/global-setup.ts tests/interaction/harness.ts scripts/qa/verify-rg-15-gates.ts docs/remediation/qa-release-gates.md && rm -f tests/visual/v2-global-setup-guard.test.ts docs/remediation/v2-agent11-qa.md"
}
```

## 2. Separation of Duties Attestation
- Zero production files under `src/**` or `supabase/**` were edited by `Agent 11`.
- `tests/remediation/mandatory-16-scenarios.test.ts` remains byte-identical to Phase B (`SHA-256 = 819369DD92B56329EB4796B5FF6626832C52137A3CF91DF8F926E70F0D444569`).
- `F-13` synthetic multi-domain seed (`scripts/seed-demo.ts` seeding `payments`, 24 months of `payment_instances`, `cashflow_months`, `checks`, `loans`, `loan_installments`, and `cost_allocation_rules`) and 5-role Playwright suites (`e2e-authz`, `legacy-semantic-smoke`, `interaction-gate`) are wired in `.github/workflows/ci.yml` with explicit `MAS_E2E_DATABASE_URL` (`mas_radar_app`) + `MAS_E2E_SEED_DATABASE_URL` (`postgres` disposable owner) for clean-room execution on GitHub Actions.
