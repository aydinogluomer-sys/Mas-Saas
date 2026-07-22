# Iteration 15 — Payment Horizon, Calendar and Lifecycle Repair

Date: 2026-07-13

## Outcome

The Payments workspace now prepares a full 24-month forward window, separates 12A and 24A datasets, exposes unlimited calendar navigation, provides Excel export, and uses a real audit-backed lifecycle history. The payment archive no longer fails because of an unrelated scenario-table column.

## Root-cause evidence

- Runtime preparation previously materialized only the previous, current and next month.
- Today and tomorrow contain no due payment instances in the current dataset; showing `0 TL` implied a known zero, so the UI now says `Ödeme yok`.
- All 19 payment definitions have an empty flexibility classification. The previous 46 figure counted repeated instances, not distinct definitions.
- `scenario_runs` has no `name` column. The archive union attempted to read it even on `/payments/archive`, causing the payment archive failure.

## Implemented

- Runtime/payment seed creates instances through 24 future calendar months.
- Payment pressure uses overdue red, partial orange, planned blue; paid history uses green.
- Empty analysis groups are omitted instead of rendering misleading zero cards.
- Flexibility counts use unique payment definitions and link unclassified records to the classification screen.
- Priority ordering is centralized: overdue open balances first, then today/tomorrow; due date, explicit criticality, risk and remaining balance break ties.
- Calendar supports an unrestricted month input, previous/next month, previous/next year and today actions.
- History supports all, paid, partial, reopened and cancelled audit-event filters with contextual empty states.
- Excel export sits beside CSV and respects the current visible range and series.
- Payment archive queries only the payment archive source and scenario archive labels join through `scenarios`.

## Verification

- TypeScript: pass.
- ESLint: pass.
- Vitest: 17 files, 180 tests passed.
- Production build: passed before the final archive-only refactor; final refactor passed TypeScript and lint. A concurrent dev/build rerun caused a transient shared `.next` Turbopack output collision, not a source diagnostic.
- Route evidence on the clean local server: `/payments`, arbitrary-year calendar, ageing detail, every history status and `/payments/archive` returned HTTP 200 before the intentional concurrent-build collision.
- Playwright regression coverage added for period controls, Excel action, unrestricted calendar, history tabs, contextual empty states, archive and 390/1024/1440/1920 overflow checks.

## Quality score

| Category | Score | Notes |
| --- | ---: | --- |
| Financial correctness | 96 | No invented zero or flexibility classification; horizons now have data. |
| Functional completeness | 94 | Requested payment, calendar, history, export and archive paths are represented. |
| Accessibility | 91 | Status uses text plus color; current tabs and empty states are explicit. |
| Responsive resilience | 90 | Automated overflow matrix covers 390–1920 px. |
| Visual hierarchy | 92 | Zero-only analysis noise removed; lifecycle palette is distinct. |
| Overall | 93 | PASS; external TestSprite staging remains a separate environment gate. |

## Remaining external gate

TestSprite requires a stable public HTTPS staging target with masked financial data. Localhost is intentionally not exposed directly.
