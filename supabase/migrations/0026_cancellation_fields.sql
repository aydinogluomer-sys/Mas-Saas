-- Cancellation metadata for the three tables whose status enum has a 'cancelled' value
-- (payment_instances 0003:52, checks 0005:19, loan_installments 0005:81). payments/loans are
-- excluded — neither enum has 'cancelled' (payments: active/paused/archived; loans: active/
-- closed/planned/unknown), verified against 0003/0005.
-- Bidirectional consistency + non-blank reason, added NOT VALID (deterministic, idempotent —
-- matches Slice 2's 0023 pattern). Pre-flight (2026-07-18, real mas_radar_dev) found exactly
-- one existing payment_instances row with status='cancelled' and null metadata (id
-- 77815c3d-6762-4382-b49e-65905c07d8df) — VALIDATE is intentionally NOT run in this migration;
-- that row is grandfathered by NOT VALID but any future UPDATE to it (even unrelated columns)
-- will be re-checked and rejected until a later repair slice backfills its metadata.

alter table public.payment_instances add column if not exists cancelled_at timestamptz;
alter table public.payment_instances add column if not exists cancel_reason text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_instances_cancel_consistency') then
    alter table public.payment_instances
      add constraint payment_instances_cancel_consistency check (
        (status = 'cancelled') = (cancelled_at is not null)
        and (cancelled_at is not null) = (cancel_reason is not null)
        and (cancel_reason is null or btrim(cancel_reason) <> '')
      ) not valid;
  end if;
end $$;

alter table public.checks add column if not exists cancelled_at timestamptz;
alter table public.checks add column if not exists cancel_reason text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'checks_cancel_consistency') then
    alter table public.checks
      add constraint checks_cancel_consistency check (
        (status = 'cancelled') = (cancelled_at is not null)
        and (cancelled_at is not null) = (cancel_reason is not null)
        and (cancel_reason is null or btrim(cancel_reason) <> '')
      ) not valid;
  end if;
end $$;

alter table public.loan_installments add column if not exists cancelled_at timestamptz;
alter table public.loan_installments add column if not exists cancel_reason text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_installments_cancel_consistency') then
    alter table public.loan_installments
      add constraint loan_installments_cancel_consistency check (
        (status = 'cancelled') = (cancelled_at is not null)
        and (cancelled_at is not null) = (cancel_reason is not null)
        and (cancel_reason is null or btrim(cancel_reason) <> '')
      ) not valid;
  end if;
end $$;
