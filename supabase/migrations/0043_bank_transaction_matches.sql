-- Faz 20 — the suggested-match queue.
--
-- WHY THIS TABLE HAS NO STATUS ENUM. bank_transactions needed a real lifecycle and got one,
-- complete, in 0042. A candidate does not: it exists, and it has either been rejected or not.
-- Modelling that as `status in ('suggested','accepted','rejected')` would create a SECOND
-- state machine needing a second complete transition guard — and implementation.md §17 rule 3
-- exists precisely because this repo has already paid for a half-specified one. `rejected_at`
-- is a nullable timestamp: it has no transitions to constrain, and acceptance is recorded where
-- it belongs, on the transaction itself (0042's matched_entity_table/matched_entity_id).
--
-- Rejections are REMEMBERED rather than deleted, so a rejected candidate is not proposed again
-- on the next matcher run. Deleting it would make the matcher look broken and would erase the
-- operator's judgement.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.bank_transaction_match_candidates (
  id uuid primary key default gen_random_uuid(),
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,

  -- Polymorphic by design, matching how the rest of this schema already points at "one of the
  -- financial entities" (audit_logs.entity_table, action_items). Faz 20 matches against the
  -- three entities that EXIST today; invoices/collections arrive in Faz 22 and will extend this
  -- CHECK in their own migration, together with whatever they need.
  target_table text not null check (target_table in ('payment_instances', 'checks', 'loan_installments')),
  target_id uuid not null,

  -- 0..1, four decimals. Produced by the deterministic scorer in src/lib/bank/rules.ts — an
  -- explainable sum of named signals, never a learned weight.
  confidence numeric(5,4) not null check (confidence >= 0 and confidence <= 1),
  -- The named signals that produced `confidence`, e.g. ["amount_exact","date_within_3d"].
  -- Stored so a suggestion can always be justified to the person accepting it.
  reasons jsonb not null default '[]'::jsonb,

  rejected_at timestamptz,
  rejected_by uuid references public.users(id),
  rejected_reason text,
  constraint bank_tx_candidate_reject_consistency check (
    (rejected_at is not null) = (rejected_by is not null)
  ),

  created_at timestamptz not null default now()
);

-- One candidate row per (transaction, target). A re-run of the matcher updates the score
-- instead of stacking duplicates.
create unique index if not exists bank_tx_candidates_uq
  on public.bank_transaction_match_candidates (bank_transaction_id, target_table, target_id);
create index if not exists bank_tx_candidates_open_idx
  on public.bank_transaction_match_candidates (bank_transaction_id, confidence desc)
  where rejected_at is null;
-- Answers "is this payment already claimed by another statement line?" cheaply.
create index if not exists bank_tx_candidates_target_idx
  on public.bank_transaction_match_candidates (target_table, target_id) where rejected_at is null;

alter table public.bank_transaction_match_candidates enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='bank_transaction_match_candidates'
      and policyname='bank_transaction_match_candidates_authenticated_all'
  ) then
    create policy bank_transaction_match_candidates_authenticated_all
      on public.bank_transaction_match_candidates
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.bank_transaction_match_candidates to authenticated;

-- ── read models ────────────────────────────────────────────────────────────────────────────
-- Views, not stored aggregates — the same reasoning as 0039: a second copy of a derivable
-- number is a second thing that can go stale, and this schema has already been bitten by that.

-- The work queue: everything a person still has to decide, newest money first.
create or replace view public.bank_unmatched_queue as
  select
    t.id,
    t.bank_account_id,
    ca.name              as account_name,
    t.txn_date,
    t.description,
    t.counterparty_name_raw,
    t.amount,
    t.direction,
    t.category,
    t.category_rule,
    t.status,
    (select count(*) from public.bank_transaction_match_candidates c
      where c.bank_transaction_id = t.id and c.rejected_at is null)      as open_candidate_count,
    (select max(c.confidence) from public.bank_transaction_match_candidates c
      where c.bank_transaction_id = t.id and c.rejected_at is null)      as best_confidence
  from public.bank_transactions t
  join public.cash_accounts ca on ca.id = t.bank_account_id
  where t.status in ('unmatched', 'suggested');

-- Per-account reconciliation health. `abs()` on amount for turnover, signed sum for net.
create or replace view public.bank_reconciliation_summary as
  select
    ba.cash_account_id                                                    as bank_account_id,
    ca.name                                                               as account_name,
    ba.iban_normalized,
    count(t.id)                                                           as transaction_count,
    count(t.id) filter (where t.status = 'unmatched')                     as unmatched_count,
    count(t.id) filter (where t.status = 'suggested')                     as suggested_count,
    count(t.id) filter (where t.status = 'matched')                       as matched_count,
    count(t.id) filter (where t.status = 'reconciled')                    as reconciled_count,
    count(t.id) filter (where t.status = 'ignored')                       as ignored_count,
    coalesce(sum(t.amount) filter (where t.direction = 'inflow'), 0)      as inflow_total,
    coalesce(sum(t.amount) filter (where t.direction = 'outflow'), 0)     as outflow_total,
    coalesce(sum(t.amount), 0)                                            as net_total,
    min(t.txn_date)                                                       as first_txn_date,
    max(t.txn_date)                                                       as last_txn_date,
    ba.available_balance,
    ba.last_statement_date
  from public.bank_accounts ba
  join public.cash_accounts ca on ca.id = ba.cash_account_id
  left join public.bank_transactions t on t.bank_account_id = ba.cash_account_id
  group by ba.cash_account_id, ca.name, ba.iban_normalized, ba.available_balance, ba.last_statement_date;

-- Two different statement lines claiming the SAME financial record. The unique index in 0042
-- stops the same line being imported twice; nothing stops two genuinely distinct lines being
-- matched to one payment, which is the more interesting error — so it is reported, not blocked.
create or replace view public.bank_match_conflicts as
  select
    t.matched_entity_table,
    t.matched_entity_id,
    count(*)                        as claim_count,
    array_agg(t.id order by t.txn_date) as bank_transaction_ids,
    sum(t.amount)                   as claimed_total
  from public.bank_transactions t
  where t.matched_entity_id is not null
  group by t.matched_entity_table, t.matched_entity_id
  having count(*) > 1;

grant select on public.bank_unmatched_queue to authenticated;
grant select on public.bank_reconciliation_summary to authenticated;
grant select on public.bank_match_conflicts to authenticated;
