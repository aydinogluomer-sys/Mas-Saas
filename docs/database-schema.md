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

## Financing radar (Phase 5 — active)

- checks — `+counterparty_label` (0009): ham KİME/KİMDEN korunur, parti FK null olsa da isim kaybolmaz. `source_row_id` partial-unique (0008, idempotency). signed→direction + `amount=|signed_amount|` (DB check).
- check_events — mapping'de 'created' olayı yazılır.
- loans — `source_sheet_id` partial-unique (0008). total_payment/total_finance_cost/installment_amount kaynaktan birebir (mutabakat sapmasında bile kaynak kazanır).
- loan_installments — vadeler kaynakta satır-tarihi olmadığından `first_payment_date`'ten TÜRETİLİR (aynı gün + kısa-ay kırpma); `unique(loan_id, installment_no)` idempotent.

## Operations analytics (Phase 7 — active, migration 0010)

- machine_assets — 4 aday seed (Awea/Arion/Sister/Doosan); name unique.
- production_parts — kapasite parçaları; `source_row_id` partial-unique (idempotency); kaynak-satır izli.
- capacity_models — kapasite modeli + Phase-7 kolonları (freze/torna TL/dk, rate_year, is_stale_rate, theoretical_monthly/total_revenue, effective_monthly_minutes); `source_sheet_id` partial-unique.
- cost_models — normal/mesaili; break_even_tl_per_min (=aylık maliyet÷etkin dk, kaynak G6 birebir), effective_monthly_minutes; `source_sheet_id` partial-unique.
- part_profitability_runs — `unique(part_id, cost_model_id)`; süre-eksik→confidence needs_review + maliyet NULL.
- machine_roi_snapshots — `confidence` **default needs_review** (tablo sekmesi kişisel/şirket karışık; insan onayı olmadan güvenilmez); `unique(machine_asset_id, snapshot_year)`.

**Analitik-only:** bu tablolara yazım payments/instances/cashflow/checks/loans/reminders/reports'u DEĞİŞTİRMEZ (phase7-verify before==after). Stale-rate (2023) ve missing-operation-time bayraklıdır, sessizce düzeltilmez.

## Scenario engine (Phase 8 — active, migration 0011)

- scenarios — senaryo tanımı (name, scenario_type, baseline_label/month_count).
- scenario_runs — bir çalıştırma + özet metrikler (final baz/senaryo/Δ, ilk negatif baz/senaryo, en kötü ay/bakiye, maks nakit açığı, toparlanma ayı, güven, açık `assumptions jsonb`).
- scenario_run_lines — ay-bazlı baz vs senaryo (income/expense/closing + Δ); `unique(run_id, month_start)`.
- scenario_assumptions — **açık beyan** edilen varsayım satırları (key/value/unit/description).
- scenario_comparisons — metrik-bazlı baz/senaryo/Δ; `unique(run_id, metric)`.

**Salt-okunur:** senaryo motoru baseline'ı (cashflow_months) ve tüm mali/üretim tablolarını OKUR, yalnız scenario_* + audit_logs'a yazar (phase8-verify baseline row-hash + fingerprint before==after). Silme yalnız scenario_* cascade.

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
- **reminders**(target_kind: payment_instance|check|loan_installment, offset_days 7/3/1/0/−1, channel, min_amount, unique(target_kind,offset_days,channel)) — **Phase 6B aktif** (payment_instance kuralları).
- **reminder_deliveries** — **Phase 6B aktif**: scheduleReminders 'pending' yazar (unique(reminder_id, entity_table, entity_id, scheduled_for) → duplicate önleme DB'de), dispatchPending her denemeyi satıra loglar (sent+sent_at | failed+error). Telegram token server-only env; gönderim mali kaydı değiştirmez.
- **reports**(report_type: daily|weekly|monthly|strategic|data_quality, period, body_md, meta) — **Phase 6A aktif**: daily/weekly/monthly snapshot'ları yazılır; `meta.commentary_prompt` = AI yorum prompt string'i (model çağrılmaz). Rapor üretimi mali tablolara **hiçbir yazma yapmaz** (before==after fingerprint, phase6-verify).

Schema hardening beyond spec snippets: `payment_instances` idempotency partial-unique (payment_id, instance_month); `instance_month`/`month_start` first-of-month check'leri; `checks.amount = |signed_amount|` tutarlılığı; `loan_installments` paid⇒paid_at; updated_at trigger'ları; sorgu indexleri. Faz 5 eki (0008/0009): `checks.source_row_id` + `loans.source_sheet_id` partial-unique (mapping idempotency, DB-seviyesinde kanıtlı); `checks.counterparty_label`. Dashboard view'ları ihtiyaç duyan dikey dilimle birlikte (slicer kuralı).

RLS modeli: tüm public tablolarında enabled + `to authenticated using(true) with check(true)` (tek-operatör modu, CLAUDE.md).
