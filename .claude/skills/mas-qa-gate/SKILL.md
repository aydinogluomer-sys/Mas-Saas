---
name: mas-qa-gate
description: Run the MAS Nakit Radar quality gate before commits or phase completion. Use to verify tests, lint, type safety, financial invariants, and scope boundaries.
allowed-tools: Read Grep Bash Edit
---

# MAS QA Gate

Before declaring any phase done:

1. Run typecheck.
2. Run lint.
3. Run unit tests.
4. Run integration tests if configured.
5. Verify no public SaaS artifacts were added:
   - pricing page
   - subscription logic
   - Stripe/iyzico billing
   - multi-tenant org tables unless explicitly approved
   - public landing page
6. Verify financial invariants:
   - null amount is not zero
   - paid requires paid_at
   - reminders avoid duplicates
   - monthly generation idempotent
   - overdue visible
   - missing data visible
7. Update docs/todo.md and docs/risk-register.md if needed.

If any check fails, fix before commit.
