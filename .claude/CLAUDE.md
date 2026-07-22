# MAS Nakit Radar — Claude Project Instructions v2

You are building a private internal finance and operations dashboard for MAS.

This is not a public SaaS. Do not create multi-tenant features, pricing pages, subscription billing, trial flows, customer onboarding, marketing landing pages, marketplace logic, or public user acquisition logic.

The system is a single-company internal control panel.

## Updated product goal

Track and analyze:

1. recurring and one-off payments
2. due days and monthly payment calendar
3. monthly cash-flow forecasts
4. devir / gelir / gider / fark aylık / kasa
5. checks / çekler and maturity risk
6. loans, interest, installments, financing cost
7. production capacity and cost models
8. normal vs overtime/mesaili economics
9. data quality, missing values, and source traceability
10. daily/weekly/monthly operational summaries

## Source-of-truth rule

The database is the source of truth after reviewed import. AI is only a commentary layer.

Never allow AI to mark payments paid, delete records, change amounts, alter due dates, infer final truth from ambiguous rows, or mutate financial records without explicit user action.

## Financial safety rules

- Treat null amount as unknown, not zero.
- Treat zero as explicit zero.
- Negative values are context-dependent: in checks/cashflow they may be signed outflows, not always anomalies.
- Preserve every raw workbook sheet/cell/row before normalization.
- Every mapped entity must trace back to source workbook/sheet/row where possible.
- Flag missing amount, missing due date, continuity breaks, overdue items, high-risk days/months, and check/loan concentration.
- Every mutation must preserve created_at, updated_at, and audit trail.

## UX rules

- Dense, readable, serious finance dashboard.
- No playful SaaS marketing design.
- Mobile responsive enough for quick phone checks.
- Dashboard must expose today, tomorrow, next 7 days, current month, cash deficit, checks, loans, overdue, missing data, and risk days without deep navigation.

## Engineering rules

- TypeScript strict mode.
- Zod validation at boundaries.
- PostgreSQL constraints for financial invariants.
- Supabase migrations only; no manual production schema changes.
- RLS enabled.
- Tests for payment instance generation, due-date calculation, cash-flow continuity, reminder eligibility, check maturity grouping, loan finance-cost calculations, and risk flags.
- Use server actions/route handlers deliberately; do not leak service keys client-side.
- Store Telegram tokens and secret keys only in environment variables.

## Delivery flow

Before coding any phase:
1. Read implementation.md.
2. Read docs/database-schema.md.
3. Read docs/data-map.md.
4. Read docs/todo.md.
5. Identify the smallest safe vertical slice.
6. Implement.
7. Run checks.
8. Update docs.
9. Stop after the agreed phase.
