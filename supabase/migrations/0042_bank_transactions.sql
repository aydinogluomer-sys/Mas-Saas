-- Faz 20 — imported bank statement lines.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE STATUS ALLOW-LIST. Read this before touching `status`.
--
-- Migration 0027 shipped three status-transition guards whose allow-lists did not cover the
-- values their own CHECK constraints accepted. `checks` and `loan_installments` each got a
-- one-entry list (`planned → cancelled`) while their CHECK had accepted 'cleared'/'bounced'
-- and 'paid'/'late' since 0005. The result was not a warning or a slow query: in the real
-- database 7/7 checks and 48/48 loan installments were FROZEN in 'planned', the loans KPI
-- reported 0 paid for every loan from Phase 5 onward, and markInstancePartial could not record
-- a partial payment on any instance at all. It took until 0033 and 0034 — eight migrations —
-- to notice and repair. docs/database-schema.md tells the whole story.
--
-- So, for this table, in THIS migration, both halves are written together and every value the
-- CHECK admits is reachable:
--
--   CHECK admits:  unmatched · suggested · matched · reconciled · ignored
--
--   unmatched  → suggested    the matcher proposed one or more candidates
--   unmatched  → matched      operator matched it directly, without a suggestion
--   unmatched  → ignored      operator: this needs no match (bank fee, own transfer)
--   suggested  → matched      operator accepted a suggestion
--   suggested  → unmatched    operator REJECTED the suggestion  ← the rejection path
--   suggested  → ignored      operator dismissed it instead of matching
--   matched    → reconciled   period closed against this line
--   matched    → unmatched    operator undid a wrong match
--   matched    → ignored      the "match" was actually a fee; correct it in one step
--   reconciled → matched      reopen a closed reconciliation to correct it
--   ignored    → unmatched    operator undid an ignore
--
--   REACHABILITY (the property 0027 broke): unmatched is the insert default; suggested from
--   unmatched; matched from unmatched/suggested/reconciled; reconciled from matched; ignored
--   from unmatched/suggested/matched. All five are reachable, none is a dead letter.
--
--   Deliberately NOT allowed, and each for a reason rather than by omission:
--     unmatched  → reconciled   nothing was ever matched to reconcile
--     suggested  → reconciled   a suggestion is not an acceptance
--     reconciled → unmatched    reopen to 'matched' first, so the reopen is its own audited act
--     reconciled → ignored      same: reopen first
--     ignored    → suggested/matched/reconciled   un-ignore first, so the queue state is honest
--
--   Same-status updates are a no-op for EVERY value and never reach the allow-list, matching
--   0027's construction exactly (that part of 0027 was right).
--
-- scripts/phase20-verify.ts proves this by ENUMERATION, not by reading: it attempts all 25
-- (old, new) pairs against a real row and compares the observed accept/reject set against the
-- table above. A future edit that adds a status to the CHECK without adding its transitions
-- fails that gate.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references public.bank_accounts(cash_account_id) on delete restrict,

  -- ── source lineage: the Faz 2 staging pattern, reused rather than reinvented ─────────────
  -- Same three columns checks/loans/production_parts already carry, so a bank transaction can
  -- be traced back to the exact imported row and, through it, to the original cells.
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  -- ── what the bank said ──────────────────────────────────────────────────────────────────
  txn_date date not null,
  value_date date,
  description text not null default '' ,
  counterparty_name_raw text,
  counterparty_iban_raw text,
  reference_no text,
  channel text,

  -- Signed: negative is money leaving the account. Mirrors checks.signed_amount semantics
  -- (docs/calculation-rules.md) instead of inventing a second convention. NOT NULL because a
  -- statement line without an amount is not a statement line — unlike a planned payment, where
  -- a missing amount is a legitimate "unknown" the schema must carry.
  amount numeric(14,2) not null,
  direction text not null generated always as (case when amount < 0 then 'outflow' else 'inflow' end) stored,
  balance_after numeric(14,2),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),

  -- ── deterministic classification (see src/lib/bank/rules.ts) ────────────────────────────
  -- The rule that fired is stored beside its verdict so a category is always explainable.
  -- No model, no scores, no training data: a named rule or nothing.
  category text not null default 'unknown',
  category_rule text,

  -- ── reconciliation state ────────────────────────────────────────────────────────────────
  status text not null default 'unmatched'
    check (status in ('unmatched', 'suggested', 'matched', 'reconciled', 'ignored')),
  matched_entity_table text
    check (matched_entity_table is null or matched_entity_table in ('payment_instances', 'checks', 'loan_installments')),
  matched_entity_id uuid,
  match_confidence numeric(5,4) check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)),
  matched_at timestamptz,
  reconciled_at timestamptz,
  ignored_reason text,

  -- A matched/reconciled line must name what it matched; an unmatched/suggested/ignored one
  -- must not pretend to. Bidirectional, same construction as 0023's archive consistency.
  constraint bank_transactions_match_consistency check (
    (status in ('matched', 'reconciled')) = (matched_entity_table is not null)
    and (matched_entity_table is not null) = (matched_entity_id is not null)
  ),
  -- An ignore must say why. A silent "not my problem" is how a real payment goes missing.
  constraint bank_transactions_ignore_reason check (
    status <> 'ignored' or (ignored_reason is not null and btrim(ignored_reason) <> '')
  ),

  -- ── duplicate detection ─────────────────────────────────────────────────────────────────
  -- Re-importing an overlapping statement window is the normal case, not an error: operators
  -- download "last 30 days" repeatedly. The hash is computed by the importer over the fields
  -- the bank actually guarantees, so a re-import collapses onto the same row instead of
  -- doubling the account's turnover.
  dedupe_hash text not null,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bank_transactions_dedupe_uq
  on public.bank_transactions (bank_account_id, dedupe_hash);
create index if not exists bank_transactions_account_date_idx
  on public.bank_transactions (bank_account_id, txn_date desc);
create index if not exists bank_transactions_status_idx
  on public.bank_transactions (status) where status in ('unmatched', 'suggested');
create index if not exists bank_transactions_matched_idx
  on public.bank_transactions (matched_entity_table, matched_entity_id)
  where matched_entity_id is not null;
create index if not exists bank_transactions_source_row_idx
  on public.bank_transactions (source_row_id) where source_row_id is not null;

drop trigger if exists bank_transactions_updated_at on public.bank_transactions;
create trigger bank_transactions_updated_at before update on public.bank_transactions
  for each row execute function public.set_updated_at();

-- ── the guard, in the SAME migration as the column it guards ───────────────────────────────
create or replace function public.bank_transactions_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('unmatched',  'suggested'),
    ('unmatched',  'matched'),
    ('unmatched',  'ignored'),
    ('suggested',  'matched'),
    ('suggested',  'unmatched'),
    ('suggested',  'ignored'),
    ('matched',    'reconciled'),
    ('matched',    'unmatched'),
    ('matched',    'ignored'),
    ('reconciled', 'matched'),
    ('ignored',    'unmatched')
  ) then
    raise exception 'bank_transactions.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

drop trigger if exists bank_transactions_status_transition_guard on public.bank_transactions;
create trigger bank_transactions_status_transition_guard before update on public.bank_transactions
  for each row execute function public.bank_transactions_status_transition_guard();

alter table public.bank_transactions enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='bank_transactions'
      and policyname='bank_transactions_authenticated_all'
  ) then
    create policy bank_transactions_authenticated_all on public.bank_transactions
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.bank_transactions to authenticated;
