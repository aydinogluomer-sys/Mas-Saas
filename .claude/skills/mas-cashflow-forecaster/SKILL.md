---
name: mas-cashflow-forecaster
description: Implement or review MAS monthly cash-flow forecast logic, including devir/gelir/gider/fark/kasa, first negative month detection, continuity checks, and concentration risks.
allowed-tools: Read Grep Bash Edit
---

# MAS Cashflow Forecaster

Use this skill when working on monthly sheets, cash-flow forecasts, cashflow_months, cashflow_lines, forecast charts, or deficit risk logic.

Rules:

- Preserve raw monthly sheet rows first.
- Map month sheets only after source traceability exists.
- opening_balance/devir, projected_income/gelir, projected_expense/gider, monthly_delta/fark aylık, closing_balance/kasa are first-class fields.
- Null amount is unknown, not zero.
- Negative cash balance is a risk, not an import error.
- Check continuity: previous closing balance should match next opening balance unless manual adjustment exists.
- Detect first negative month, worst balance month, and consecutive negative months.
- Flag income concentration and vendor concentration.

Required tests:

1. cashflow continuity
2. first negative month
3. worst month
4. null vs zero amount
5. concentration threshold
6. source row traceability
