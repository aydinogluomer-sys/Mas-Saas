-- paid_at/paid_amount are permitted (not required) for 'paid' and 'partial'; every other
-- status must carry neither. Complements the existing paid_requires_paid_at (0003) forward
-- direction without touching it. Added NOT VALID; pre-flight (2026-07-18, real mas_radar_dev)
-- found zero violations, VALIDATE deferred to a later repair/validation slice regardless.
-- Wrapped in existence checks (matches 0020's idempotent style), per LEDGER_EMPTY_RECOVERY.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_instances_paid_fields_scoped') then
    alter table public.payment_instances
      add constraint payment_instances_paid_fields_scoped check (
        status in ('paid', 'partial') or (paid_at is null and paid_amount is null)
      ) not valid;
  end if;
end $$;

-- loan_installments has no paid_amount column (verified against 0005) — paid_at only.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_installments_paid_fields_scoped') then
    alter table public.loan_installments
      add constraint loan_installments_paid_fields_scoped check (
        status in ('paid', 'partial') or paid_at is null
      ) not valid;
  end if;
end $$;
