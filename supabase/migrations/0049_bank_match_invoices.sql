-- Faz 22 — let a bank transaction match an invoice.
--
-- Faz 20 shipped bank_transactions.matched_entity_table with a CHECK admitting exactly the
-- three entities that existed then: payment_instances, checks, loan_installments. 0043's note
-- said so explicitly — "invoices/collections arrive in Faz 22 and will extend this CHECK in
-- their own migration, together with whatever they need". This is that migration.
--
-- Two CHECKs on bank_transactions mention matched_entity_table:
--
--   bank_transactions_matched_entity_table_check   the value list  <- widened here
--   bank_transactions_match_consistency            the null/not-null pairing, UNCHANGED
--
-- Only the first is touched, and it is named explicitly rather than found by text search. That
-- is the Faz 20 lesson applied to DDL as well as to gates: `like '%matched_entity_table%'`
-- matches both, and a migration that dropped "the one it found" could silently remove the
-- consistency rule instead.
--
-- WIDENING, NOT NARROWING. Every existing row already satisfies the new constraint by
-- construction (the old members are still members), so there is nothing to validate later and
-- no grandfathered violation. The "add NOT VALID, VALIDATE in a separate slice" rule
-- (0023/0026 → 0029/0030) applies to constraints that could REJECT existing data; it does not
-- apply here. Same reasoning as 0041's detected_type widening.
--
-- Idempotent, per LEDGER_EMPTY_RECOVERY.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.bank_transactions'::regclass
      and conname = 'bank_transactions_matched_entity_table_check'
  ) then
    alter table public.bank_transactions
      drop constraint bank_transactions_matched_entity_table_check;
  end if;

  alter table public.bank_transactions
    add constraint bank_transactions_matched_entity_table_check
    check (
      matched_entity_table is null
      or matched_entity_table in ('payment_instances', 'checks', 'loan_installments', 'invoices')
    );
end $$;

-- The candidate queue's target list moves in step. Faz 20 deliberately scoped it to the same
-- three entities; leaving it behind would mean the matcher could never PROPOSE an invoice it is
-- now allowed to be matched to — precisely the 0027 shape of failure, where one half of a pair
-- was widened and the other was not.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.bank_transaction_match_candidates'::regclass
      and conname = 'bank_transaction_match_candidates_target_table_check'
  ) then
    alter table public.bank_transaction_match_candidates
      drop constraint bank_transaction_match_candidates_target_table_check;
  end if;

  alter table public.bank_transaction_match_candidates
    add constraint bank_transaction_match_candidates_target_table_check
    check (target_table in ('payment_instances', 'checks', 'loan_installments', 'invoices'));
end $$;
