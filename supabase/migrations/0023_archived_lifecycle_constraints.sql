-- Archive lifecycle consistency, added NOT VALID (deterministic across every environment).
-- Pre-flight (2026-07-18, real mas_radar_dev) found zero violations on any of the 6 tables,
-- so VALIDATE could run safely today — but VALIDATE is intentionally left to a later,
-- explicitly-approved data-repair/validation slice, never bundled into the same migration
-- that adds the constraint (P0-B house rule).
-- Each ADD CONSTRAINT is wrapped in an existence check (matches 0020's idempotent style) —
-- plain ALTER TABLE ADD CONSTRAINT is not itself idempotent and must be safe to re-run
-- against a DB that already has it, per LEDGER_EMPTY_RECOVERY.

-- payments: status='archived' is fully equivalent to archived_at/archive_reason/archived_by_label
-- all being set (this table is the only one of the six whose status enum has an 'archived' value).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_archive_consistency') then
    alter table public.payments
      add constraint payments_archive_consistency check (
        (status = 'archived') = (archived_at is not null)
        and (archived_at is not null) = (archive_reason is not null)
        and (archived_at is not null) = (archived_by_label is not null)
      ) not valid;
  end if;
end $$;

-- checks/loans/scenario_runs/external_assumptions/action_items: none of these status (or,
-- for scenario_runs, non-existent status) columns have an 'archived' value, so archived_at is
-- an independent marker here — only the metadata triplet needs to agree with itself.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'checks_archive_triplet_consistency') then
    alter table public.checks
      add constraint checks_archive_triplet_consistency check (
        (archived_at is not null) = (archive_reason is not null)
        and (archived_at is not null) = (archived_by_label is not null)
      ) not valid;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loans_archive_triplet_consistency') then
    alter table public.loans
      add constraint loans_archive_triplet_consistency check (
        (archived_at is not null) = (archive_reason is not null)
        and (archived_at is not null) = (archived_by_label is not null)
      ) not valid;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'scenario_runs_archive_triplet_consistency') then
    alter table public.scenario_runs
      add constraint scenario_runs_archive_triplet_consistency check (
        (archived_at is not null) = (archive_reason is not null)
        and (archived_at is not null) = (archived_by_label is not null)
      ) not valid;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'external_assumptions_archive_triplet_consistency') then
    alter table public.external_assumptions
      add constraint external_assumptions_archive_triplet_consistency check (
        (archived_at is not null) = (archive_reason is not null)
        and (archived_at is not null) = (archived_by_label is not null)
      ) not valid;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'action_items_archive_triplet_consistency') then
    alter table public.action_items
      add constraint action_items_archive_triplet_consistency check (
        (archived_at is not null) = (archive_reason is not null)
        and (archived_at is not null) = (archived_by_label is not null)
      ) not valid;
  end if;
end $$;
