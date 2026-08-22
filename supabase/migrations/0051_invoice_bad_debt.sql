-- Faz 23 — bad-debt marking: a MANUAL, AUDITED flag and nothing else.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS NOT.
--
-- There is no rule anywhere in this phase that sets these columns. No trigger, no scheduled
-- job, no "if 90 days overdue then flag it" heuristic. CLAUDE.md's source-of-truth rule is
-- explicit — AI never marks payments paid, deletes records, or infers final truth from
-- ambiguous rows — and writing off a receivable is exactly the kind of judgement that rule
-- exists to keep in human hands. The scoring in 0052 will happily tell an operator that an
-- invoice looks uncollectable; it cannot act on that opinion.
--
-- The columns are written by exactly one code path: `markBadDebt()` in
-- src/lib/collections/engine.ts, which requires a typed reason and records through the
-- canonical audit(). phase23:verify asserts that nothing else in src/ writes them.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY A FLAG AND NOT A STATUS. `invoices.status` already has 'closed' for a written-off invoice
-- and 'cancelled' for a voided one. Bad debt is neither: it is an ASSESSMENT laid over an
-- invoice that is still open and may still be collected — firms recover flagged debt regularly,
-- and forcing the invoice out of 'open' to record the opinion would make that recovery look
-- like a resurrection. So it is a nullable timestamp with no transitions to constrain, the same
-- shape as 0048's reversed_at and 0037's is_active, and implementation.md §17 rule 3 stays N/A
-- because nothing here has a lifecycle.
--
-- These columns are deliberately NOT in 0044's content-immutability list: an issued invoice's
-- commercial content is frozen, but an assessment about collectability is not part of that
-- content and must remain writable for the life of the document.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

alter table public.invoices add column if not exists bad_debt_at timestamptz;
alter table public.invoices add column if not exists bad_debt_reason text;
alter table public.invoices add column if not exists bad_debt_by uuid references public.users(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_bad_debt_consistency') then
    alter table public.invoices
      add constraint invoices_bad_debt_consistency check (
        -- All three travel together, and the reason may not be blank. A write-off with no
        -- stated reason and no named author is an accusation with no signature on it.
        (bad_debt_at is not null) = (bad_debt_reason is not null)
        and (bad_debt_at is not null) = (bad_debt_by is not null)
        and (bad_debt_reason is null or btrim(bad_debt_reason) <> '')
      );
  end if;
end $$;

create index if not exists invoices_bad_debt_idx
  on public.invoices (bad_debt_at) where bad_debt_at is not null;

-- A cancelled invoice cannot be bad debt: there is no debt. Enforced rather than left to the
-- application, because the two flags coming from different code paths is exactly how a
-- contradiction gets written.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_bad_debt_not_cancelled') then
    alter table public.invoices
      add constraint invoices_bad_debt_not_cancelled check (
        bad_debt_at is null or status <> 'cancelled'
      );
  end if;
end $$;
