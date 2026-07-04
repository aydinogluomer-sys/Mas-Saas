# MAS Nakit Radar — Database Schema v2 Summary

See `implementation.md` for complete SQL snippets.

## Raw source

- source_workbooks
- source_sheets
- source_cells
- import_rows
- mapping_reviews

## Shared references

- parties
- categories
- cash_accounts
- settings
- audit_logs

## Payment radar

- payments
- payment_instances
- reminders
- reminder_deliveries
- reports

## Cash-flow radar

- cashflow_months
- cashflow_lines
- cashflow_snapshots

## Financing radar

- checks
- check_events
- loans
- loan_installments

## Operations analytics

- machine_assets
- production_parts
- capacity_models
- cost_models
- part_profitability_runs
- machine_roi_snapshots

## Core invariants

- Null amount is unknown, not zero.
- Negative signed amount is contextual.
- Paid status requires paid_at.
- Every mapped record should preserve source workbook/sheet/row where possible.
- Monthly cash-flow continuity must be validated.
- AI is commentary only.
