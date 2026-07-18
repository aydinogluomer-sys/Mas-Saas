-- Once a record carries any archive signal, it is frozen except for one narrow, explicit
-- exception: filling in previously-missing archive metadata ("legacy metadata completion").
-- No unarchive path exists here — reopening a record is out of scope and must never happen
-- silently via a partial UPDATE. updated_at is exempt (owned by set_updated_at()).
-- Idempotent throughout (create or replace + drop trigger if exists), per LEDGER_EMPTY_RECOVERY.

-- payments: the lock condition also covers status='archived' on its own, so a legacy row
-- that has status='archived' but null metadata (none exist today, but the guard must not
-- assume that) is locked immediately, not only once archived_at is populated.
create or replace function public.payments_archived_immutability_guard() returns trigger
language plpgsql as $$
declare
  locked boolean;
  was_incomplete boolean;
  is_completion boolean;
begin
  locked := old.status = 'archived'
    or old.archived_at is not null
    or old.archive_reason is not null
    or old.archived_by_label is not null;

  if not locked then
    return new;
  end if;

  -- Once all three metadata fields are already filled, no UPDATE is ever permitted again,
  -- not even a value-preserving no-op — "completion" only exists while something is missing.
  was_incomplete := old.archived_at is null or old.archive_reason is null or old.archived_by_label is null;

  is_completion :=
    was_incomplete
    and new.status is not distinct from old.status
    and (old.archived_at is null or new.archived_at is not distinct from old.archived_at)
    and (old.archive_reason is null or new.archive_reason is not distinct from old.archive_reason)
    and (old.archived_by_label is null or new.archived_by_label is not distinct from old.archived_by_label)
    and (to_jsonb(new) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at'])
      = (to_jsonb(old) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at']);

  if is_completion then
    return new;
  end if;

  raise exception 'payments.% is archived and immutable (only filling missing archive metadata is permitted)', old.id;
end $$;

drop trigger if exists payments_archived_immutability on public.payments;
create trigger payments_archived_immutability before update on public.payments
  for each row execute function public.payments_archived_immutability_guard();

-- checks/loans: no 'archived' status value exists on either enum (verified against 0005),
-- so the lock is purely metadata-driven here — no status comparison.
create or replace function public.archive_metadata_immutability_guard() returns trigger
language plpgsql as $$
declare
  locked boolean;
  was_incomplete boolean;
  is_completion boolean;
begin
  locked := old.archived_at is not null
    or old.archive_reason is not null
    or old.archived_by_label is not null;

  if not locked then
    return new;
  end if;

  was_incomplete := old.archived_at is null or old.archive_reason is null or old.archived_by_label is null;

  is_completion :=
    was_incomplete
    and (old.archived_at is null or new.archived_at is not distinct from old.archived_at)
    and (old.archive_reason is null or new.archive_reason is not distinct from old.archive_reason)
    and (old.archived_by_label is null or new.archived_by_label is not distinct from old.archived_by_label)
    and (to_jsonb(new) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at'])
      = (to_jsonb(old) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at']);

  if is_completion then
    return new;
  end if;

  raise exception '%.% has archive metadata and is immutable (only filling missing archive metadata is permitted)', TG_TABLE_NAME, old.id;
end $$;

drop trigger if exists checks_archive_metadata_immutability on public.checks;
create trigger checks_archive_metadata_immutability before update on public.checks
  for each row execute function public.archive_metadata_immutability_guard();

drop trigger if exists loans_archive_metadata_immutability on public.loans;
create trigger loans_archive_metadata_immutability before update on public.loans
  for each row execute function public.archive_metadata_immutability_guard();
