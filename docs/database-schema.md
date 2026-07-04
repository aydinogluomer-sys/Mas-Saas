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

## Phase 1 additions (designed here, verified locally)

- **settings**(key pk, value jsonb, description, updated_at) — eşikler + timezone.
- **audit_logs**(actor→auth.users, action, entity_table, entity_id, before_data, after_data) — her mutasyon izlenebilir.
- **reminders**(target_kind: payment_instance|check|loan_installment, offset_days 7/3/1/0/−1, channel, min_amount, unique(target_kind,offset_days,channel)).
- **reminder_deliveries** — duplicate önleme anahtarı unique(reminder_id, entity_table, entity_id, scheduled_for).
- **reports**(report_type: daily|weekly|monthly|strategic|data_quality, period, body_md, meta).

Schema hardening beyond spec snippets: `payment_instances` idempotency partial-unique (payment_id, instance_month); `instance_month`/`month_start` first-of-month check'leri; `checks.amount = |signed_amount|` tutarlılığı; `loan_installments` paid⇒paid_at; updated_at trigger'ları; sorgu indexleri. Dashboard view'ları Faz 3/4'te (slicer kuralı: ihtiyaç duyan dikey dilimle birlikte).

RLS modeli: tüm public tablolarında enabled + `to authenticated using(true) with check(true)` (tek-operatör modu, CLAUDE.md).
