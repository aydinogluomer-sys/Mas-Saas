---
name: mas-payment-risk-engine
description: Implement or review MAS payment rules, due-date generation, missing-data flags, critical thresholds, cluster detection, and overdue logic.
allowed-tools: Read Grep Bash Edit
---

# MAS Payment Risk Engine

Implement risk logic as deterministic code and/or SQL. AI must not be the risk source of truth.

Rules to enforce:

- Null amount is unknown, not zero.
- Estimated amount is counted but marked estimated.
- Negative amount is suspicious.
- Large payment threshold defaults to 50,000 TRY.
- Critical payment threshold defaults to 100,000 TRY.
- Same-day cluster defaults to 3+ payments.
- Overdue = due date passed and status unpaid/partial.
- Monthly generation must be idempotent.
- due_day 29/30/31 maps to last day of short months.

Required tests:

- null amount excluded from sums but counted
- negative amount flagged
- large/critical thresholds
- same-day cluster
- overdue status
- February edge cases
- duplicate generation prevention
