-- Phase 5 hardening: DB-level idempotency for financing mapping (mirrors the
-- payment_instances partial-unique proof from Phase 3).
-- checks: at most one ledger row per source import row (manual checks keep null source).
-- loans: one loan per source sheet — current reality: 'faiz hesaplama' holds a single
-- loan; relax deliberately (documented migration) if a multi-loan sheet ever appears.

create unique index checks_source_row_uq
  on public.checks(source_row_id) where source_row_id is not null;

create unique index loans_source_sheet_uq
  on public.loans(source_sheet_id) where source_sheet_id is not null;
