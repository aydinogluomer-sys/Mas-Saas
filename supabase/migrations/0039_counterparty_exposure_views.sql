-- Faz 19 — counterparty exposure / risk, as VIEWS.
--
-- WHY A VIEW AND NOT A STORED COLUMN. A materialised score on parties would be a second source
-- of truth for a number that is already fully derivable from checks, loans and payments — and
-- a second source of truth is exactly what goes stale silently. This schema already carries the
-- scar: docs/database-schema.md records `financing/engine.ts`'s paid_count KPI returning 0 for
-- every loan since Phase 5 because the underlying rows could never reach the state it counted.
-- A view cannot drift from its inputs; it is recomputed at read time or it is not read at all.
--
-- Ordinary views, not MATERIALIZED. This is a single-operator internal panel over a few
-- thousand rows (7 checks, 1 loan, 19 payments in the real database today); the cost of
-- recomputation is nothing, and a matview would reintroduce the staleness problem plus a
-- refresh schedule nobody would remember to run.
--
-- All arithmetic stays in `numeric`. Faz 17 removed 136 `::float8` casts from the application
-- for measured precision reasons; introducing float here would put the loss back at the source.
-- The application decodes these columns through src/lib/money.ts like every other money value.

-- ── 1) unified exposure items ─────────────────────────────────────────────────────────────
--
-- One row per (counterparty, financial item). Kept as its own view so the aggregate below is
-- readable and so the item-level detail is queryable for a drill-down without re-deriving the
-- attribution rules.
--
-- Attribution rule for checks: the counterparty is the payee or the payer, NOT the bank.
-- bank_party_id models "which bank is this drawn on", a different relationship that would
-- wildly overstate a bank's exposure if folded in here. This mirrors how the importer already
-- derives counterparty_label (`c.payee ?? c.payer`, src/lib/financing/engine.ts).
create or replace view public.counterparty_exposure_items as
  -- open checks (not yet settled or cancelled)
  select
    coalesce(c.payee_party_id, c.payer_party_id) as party_id,
    'check'::text                                as source,
    c.id                                         as source_id,
    c.direction                                  as direction,
    c.amount                                     as amount,
    c.maturity_date                              as due_date,
    c.status                                     as status
  from public.checks c
  where c.archived_at is null
    and c.status in ('planned', 'unknown')
    and coalesce(c.payee_party_id, c.payer_party_id) is not null

  union all

  -- open loan installments, attributed to the lender
  select
    l.lender_party_id,
    'loan_installment',
    li.id,
    'outflow',
    li.amount,
    li.due_date,
    li.status
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  where l.archived_at is null
    and li.status in ('planned', 'unpaid', 'partial', 'late')
    and l.lender_party_id is not null

  union all

  -- open payment instances, attributed to the provider (who we owe)
  select
    p.provider_party_id,
    'payment_instance',
    i.id,
    coalesce(i.direction, 'outflow'),
    i.amount,
    i.due_date,
    i.status
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  where p.archived_at is null
    and i.status in ('unpaid', 'partial', 'planned', 'late')
    and p.provider_party_id is not null;

-- ── 2) per-counterparty aggregate ─────────────────────────────────────────────────────────
--
-- Unknown amounts are COUNTED, never summed as zero (CLAUDE.md: null amount is unknown, not
-- zero). A counterparty with three unpriced checks must not read as zero exposure, so
-- `unknown_amount_count` sits beside every total and the application is expected to disclose it.
create or replace view public.counterparty_exposure as
with items as (
  select * from public.counterparty_exposure_items
),
agg as (
  select
    i.party_id,
    count(*)                                                                    as item_count,
    count(*) filter (where i.amount is null)                                    as unknown_amount_count,
    coalesce(sum(i.amount) filter (where i.direction = 'outflow'), 0)           as outflow_amount,
    coalesce(sum(i.amount) filter (where i.direction = 'inflow'), 0)            as inflow_amount,
    coalesce(sum(i.amount) filter (where i.source = 'check'), 0)                as check_amount,
    count(*) filter (where i.source = 'check')                                  as check_count,
    coalesce(sum(i.amount) filter (where i.source = 'loan_installment'), 0)     as loan_amount,
    count(*) filter (where i.source = 'loan_installment')                       as loan_installment_count,
    coalesce(sum(i.amount) filter (where i.source = 'payment_instance'), 0)     as payment_amount,
    count(*) filter (where i.source = 'payment_instance')                       as payment_count,
    min(i.due_date) filter (where i.amount is not null)                         as earliest_due_date,
    -- Exposure is the money we may have to pay out; inflows are tracked but not netted off,
    -- because a receivable from a counterparty does not reduce what we owe them unless a
    -- netting agreement exists, and none is modelled here.
    coalesce(sum(i.amount) filter (where i.direction = 'outflow'), 0)           as total_exposure
  from items i
  group by i.party_id
)
select
  pa.id                        as party_id,
  pa.name                      as party_name,
  pa.party_type,
  pa.is_active,
  coalesce(a.item_count, 0)            as item_count,
  coalesce(a.unknown_amount_count, 0)  as unknown_amount_count,
  coalesce(a.outflow_amount, 0)        as outflow_amount,
  coalesce(a.inflow_amount, 0)         as inflow_amount,
  coalesce(a.check_amount, 0)          as check_amount,
  coalesce(a.check_count, 0)           as check_count,
  coalesce(a.loan_amount, 0)           as loan_amount,
  coalesce(a.loan_installment_count, 0) as loan_installment_count,
  coalesce(a.payment_amount, 0)        as payment_amount,
  coalesce(a.payment_count, 0)         as payment_count,
  a.earliest_due_date,
  coalesce(a.total_exposure, 0)        as total_exposure,
  -- Share of all counterparty exposure. NULL rather than 0 when there is nothing to divide by:
  -- "no known total" and "0% concentration" are different statements, the same distinction
  -- src/lib/money.ts's ratioOrNull draws on the application side.
  case
    when sum(coalesce(a.total_exposure, 0)) over () > 0
      then round(coalesce(a.total_exposure, 0) / sum(coalesce(a.total_exposure, 0)) over (), 6)
  end                                  as exposure_ratio,
  cp.credit_limit,
  cp.credit_limit_currency,
  -- Utilisation only means something against a real limit. A limit of 0 is a genuine value
  -- ("cash only") but dividing by it is not, so it yields null like an absent limit.
  case
    when cp.credit_limit is not null and cp.credit_limit > 0
      then round(coalesce(a.total_exposure, 0) / cp.credit_limit, 6)
  end                                  as credit_limit_utilization,
  case
    when cp.credit_limit is not null and coalesce(a.total_exposure, 0) > cp.credit_limit
      then true else false
  end                                  as over_credit_limit,
  (select count(*) from public.ibans ib where ib.party_id = pa.id and ib.is_active) as active_iban_count
from public.parties pa
left join agg a on a.party_id = pa.id
left join public.counterparty_profiles cp on cp.party_id = pa.id;

-- ── 3) unresolved counterparties — the data-quality surface ───────────────────────────────
--
-- THIS VIEW IS THE ALTERNATIVE TO A BACKFILL, AND THAT IS THE POINT.
--
-- The house rule (src/lib/financing/engine.ts's partyIdByName: "Never creates parties
-- silently") means an import that cannot resolve a name keeps the raw text and leaves the FK
-- null. Faz 19 does NOT backfill those rows: matching a free-text label to a counterparty is a
-- judgement, and CLAUDE.md reserves judgement for a reviewed, explicit human action. What this
-- phase adds instead is visibility — the unresolved rows are now listable, so an operator can
-- resolve them deliberately through the create/link action rather than a migration doing it
-- silently at 3am.
--
-- Measured against the real database before writing this (read-only): all 7 checks already
-- resolve to a party and 0 carry an unresolved label, while the single loan has a null
-- lender_party_id. So the backfill this phase declines to perform would today have touched
-- nothing in `checks` anyway — and could not have touched `loans` at all, because loans has
-- NO counterparty_label column (verified by introspection; only `checks` has one). The loan's
-- lender is recoverable only from `loans.name`, which is the loan's own name, not a
-- counterparty field. Guessing a party from it is exactly the inference this rule forbids.
create or replace view public.counterparty_unresolved as
  select
    'check'::text                as source,
    c.id                         as source_id,
    c.counterparty_label         as raw_label,
    c.maturity_date              as due_date,
    c.amount                     as amount,
    c.status                     as status,
    c.source_workbook_id,
    c.source_sheet_id
  from public.checks c
  where c.archived_at is null
    and c.payee_party_id is null
    and c.payer_party_id is null
    and c.counterparty_label is not null

  union all

  -- loans has no counterparty_label column; `name` is the loan's own name and is exposed here
  -- only as a HINT for a human, never as something to match on automatically.
  select
    'loan',
    l.id,
    l.name,
    l.first_payment_date,
    l.principal,
    l.status,
    l.source_workbook_id,
    l.source_sheet_id
  from public.loans l
  where l.archived_at is null
    and l.lender_party_id is null;

-- ── 4) the same IBAN under two different counterparties ───────────────────────────────────
--
-- 0037 scopes IBAN uniqueness to the party on purpose (one firm can exist twice in `parties`
-- under two party_types and legitimately hold one account). That leaves a real signal
-- unreported, so it is reported here rather than enforced there: two DIFFERENT counterparties
-- sharing a bank account is either the same firm entered twice, or something that deserves a
-- look before money moves.
create or replace view public.iban_shared_across_parties as
  select
    ib.iban_normalized,
    count(distinct ib.party_id) as party_count,
    array_agg(distinct pa.name order by pa.name) as party_names
  from public.ibans ib
  join public.parties pa on pa.id = ib.party_id
  where ib.is_active
  group by ib.iban_normalized
  having count(distinct ib.party_id) > 1;

grant select on public.counterparty_exposure_items to authenticated;
grant select on public.counterparty_exposure to authenticated;
grant select on public.counterparty_unresolved to authenticated;
grant select on public.iban_shared_across_parties to authenticated;
