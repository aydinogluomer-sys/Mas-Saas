---
name: mas-loan-check-analyst
description: Implement or review loan, interest, installment, check/çek maturity, signed amount, and bank exposure logic for MAS Nakit Radar.
allowed-tools: Read Grep Bash Edit
---

# MAS Loan and Check Analyst

Use this skill when working on `faiz hesaplama`, `ÇEKLER`, loans, loan_installments, checks, check_events, debt-service analytics, or maturity calendars.

Rules:

- Do not treat all negative values as anomalies. In checks, negative signed amounts may represent outgoing obligations.
- Store signed_amount and normalized amount/direction separately.
- Track maturity_date, payee/kime, payer/kimden, bank, serial number, status, and source row.
- Loan records must track principal, term, first payment date, rates, BSMV, KKDF, installment, total repayment, and finance cost.
- Loan installments should be generated idempotently.
- Check/loan risk must overlap with payment and cash-flow risk.

Required tests:

1. signed check amount direction
2. maturity grouping by week/month
3. duplicate-looking check review
4. loan total repayment
5. finance cost calculation
6. installment generation idempotency
