-- Faz 22 — receivables / payables / current account, as READ MODELS.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE OPEN DESIGN DECISION, SETTLED: RECEIVABLES AND PAYABLES ARE VIEWS, NOT TABLES.
--
-- implementation.md left this open ("bağımsız bir yaşam döngüsü gerekirse gerçek tabloya terfi
-- ettirilir"). The test applied was simple: does a receivable have a single attribute today
-- that its invoice does not already carry?
--
--   party, amount, currency, issue/due date  → on the invoice
--   how much is still owed                   → gross − allocated (0048)
--   ageing bucket                            → derived from due_date
--   settled / written off / voided           → invoices.status (paid / closed / cancelled)
--
-- Nothing is left over. A receivables TABLE today would duplicate every one of those columns
-- and immediately become a second source of truth for amounts that live on the invoice — the
-- exact staleness this schema has already been bitten by (pre-0034 the loans paid_count KPI
-- read 0 for every loan since Phase 5, and docs/database-schema.md records why 0039/0043/0047
-- are all views for the same reason).
--
-- The things that WOULD justify a table are real but are not in this phase: promise-to-pay
-- dates (implementation.md §1c lists it as its own future entity), dunning/collection status,
-- and per-receivable assignment. When those arrive they bring attributes of their own and a
-- lifecycle of their own, and THAT is the moment to promote — with its own migration and its
-- own complete transition guard. Promoting now would mean inventing a lifecycle before there
-- is anything to put in it, which is the mistake §17 rule 3 exists to prevent.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- All arithmetic stays in numeric; the application decodes through src/lib/money.ts.

-- ── 1) the two names the plan asks for, over one table ─────────────────────────────────────
--
-- 0048 keeps a single `invoice_allocations` table so the ceiling invariant has exactly one
-- enforcement point. These facades preserve the plan's vocabulary: a collection settles a
-- SALES invoice (money in), a payment settles a PURCHASE invoice (money out).
create or replace view public.collection_allocations as
  select a.*, i.party_id, i.invoice_no, i.currency
  from public.invoice_allocations a
  join public.invoices i on i.id = a.invoice_id
  where i.direction = 'sales';

create or replace view public.payment_allocations as
  select a.*, i.party_id, i.invoice_no, i.currency
  from public.invoice_allocations a
  join public.invoices i on i.id = a.invoice_id
  where i.direction = 'purchase';

-- ── 2) open items with Faz 22's collection-urgency ageing ──────────────────────────────────
--
-- NOTE THE DIFFERENT BUCKETS. 0047's invoice_open_items uses 1-30/31-60/61-90/90+, which is
-- the conventional AR REPORTING ageing. implementation.md asks Faz 22 for 1-7/8-30/31-60/60+,
-- which is a COLLECTION-URGENCY ageing: it splits the first month, because whether a customer
-- is three days or three weeks late changes what you do today, and it stops caring past 60
-- because by then the action is the same. Both are correct for their purpose and both are kept;
-- src/lib/receivables/rules.ts implements this one and phase22:verify compares the two
-- implementations against the same rows so they cannot drift.
create or replace view public.receivables_open as
  select
    i.id                                        as invoice_id,
    i.party_id,
    pa.name                                     as party_name,
    i.invoice_no,
    i.issue_date,
    i.due_date,
    i.currency,
    i.gross_amount,
    i.allocated_amount,
    (i.gross_amount - i.allocated_amount)       as open_amount,
    i.status,
    case when i.due_date is null then null else (current_date - i.due_date) end as days_overdue,
    case
      when i.due_date is null then 'tarihsiz'
      when i.due_date >= current_date then 'vadesi gelmemiş'
      when current_date - i.due_date <= 7 then '1-7 gün'
      when current_date - i.due_date <= 30 then '8-30 gün'
      when current_date - i.due_date <= 60 then '31-60 gün'
      else '60+ gün'
    end                                         as ageing_bucket
  from public.invoices i
  join public.parties pa on pa.id = i.party_id
  where i.direction = 'sales'
    and i.status in ('open', 'partial')
    and i.gross_amount > i.allocated_amount;

create or replace view public.payables_open as
  select
    i.id                                        as invoice_id,
    i.party_id,
    pa.name                                     as party_name,
    i.invoice_no,
    i.issue_date,
    i.due_date,
    i.currency,
    i.gross_amount,
    i.allocated_amount,
    (i.gross_amount - i.allocated_amount)       as open_amount,
    i.status,
    case when i.due_date is null then null else (current_date - i.due_date) end as days_overdue,
    case
      when i.due_date is null then 'tarihsiz'
      when i.due_date >= current_date then 'vadesi gelmemiş'
      when current_date - i.due_date <= 7 then '1-7 gün'
      when current_date - i.due_date <= 30 then '8-30 gün'
      when current_date - i.due_date <= 60 then '31-60 gün'
      else '60+ gün'
    end                                         as ageing_bucket
  from public.invoices i
  join public.parties pa on pa.id = i.party_id
  where i.direction = 'purchase'
    and i.status in ('open', 'partial')
    and i.gross_amount > i.allocated_amount;

-- ── 3) money received/paid that is not yet assigned to any invoice ─────────────────────────
--
-- This is where over-receipt becomes visible after 0048 capped allocations at the invoice
-- total. A bank transaction of 130 against a 120 invoice allocates 120 and leaves 10 sitting
-- here, which is the honest representation: the money exists, it just does not belong to that
-- invoice.
create or replace view public.settlement_unallocated as
  select
    'bank_transactions'::text                       as source_table,
    t.id                                            as source_id,
    t.txn_date                                      as source_date,
    t.description,
    abs(t.amount)                                   as source_amount,
    coalesce(a.allocated, 0)                        as allocated_amount,
    (abs(t.amount) - coalesce(a.allocated, 0))      as unallocated_amount,
    t.direction
  from public.bank_transactions t
  left join (
    select source_id, sum(allocated_amount) as allocated
    from public.invoice_allocations
    where source_table = 'bank_transactions' and reversed_at is null
    group by source_id
  ) a on a.source_id = t.id
  where t.status in ('matched', 'reconciled')
    and abs(t.amount) > coalesce(a.allocated, 0);

-- ── 4) current account card — the counterparty's whole position ────────────────────────────
--
-- Read model over Faz 19-21, no new source data (implementation.md is explicit about this).
-- Sales and purchase are kept apart rather than netted: offsetting a receivable against a
-- payable is a legal act between two parties, not an arithmetic one, and netting them here
-- would quietly assert an agreement that may not exist.
create or replace view public.current_account_summary as
  select
    pa.id                                                                  as party_id,
    pa.name                                                                as party_name,
    pa.party_type,
    coalesce(sum(i.gross_amount) filter (where i.direction='sales'    and i.status in ('open','partial')), 0)
      - coalesce(sum(i.allocated_amount) filter (where i.direction='sales'    and i.status in ('open','partial')), 0)
                                                                           as receivable_open,
    coalesce(sum(i.gross_amount) filter (where i.direction='purchase' and i.status in ('open','partial')), 0)
      - coalesce(sum(i.allocated_amount) filter (where i.direction='purchase' and i.status in ('open','partial')), 0)
                                                                           as payable_open,
    count(i.id) filter (where i.direction='sales'    and i.status in ('open','partial'))  as receivable_count,
    count(i.id) filter (where i.direction='purchase' and i.status in ('open','partial'))  as payable_count,
    count(i.id) filter (where i.status in ('open','partial') and i.due_date < current_date) as overdue_count,
    min(i.due_date) filter (where i.status in ('open','partial'))          as earliest_due_date,
    coalesce(sum(i.gross_amount) filter (where i.direction='sales'), 0)    as sales_total_all_time,
    coalesce(sum(i.gross_amount) filter (where i.direction='purchase'), 0) as purchase_total_all_time,
    max(i.issue_date)                                                      as last_invoice_date
  from public.parties pa
  left join public.invoices i on i.party_id = pa.id and i.status <> 'cancelled'
  group by pa.id, pa.name, pa.party_type;

-- ── 5) the ledger behind the card: every movement, one row each ────────────────────────────
create or replace view public.current_account_ledger as
  select
    i.party_id,
    i.issue_date                                    as movement_date,
    case when i.direction = 'sales' then 'fatura (satış)' else 'fatura (alış)' end as movement_type,
    i.invoice_no                                    as reference,
    i.direction,
    i.gross_amount                                  as debit_amount,
    0::numeric(14,2)                                as credit_amount,
    i.id                                            as invoice_id,
    null::uuid                                      as allocation_id
  from public.invoices i
  where i.status <> 'cancelled'

  union all

  select
    i.party_id,
    a.allocated_on,
    case when i.direction = 'sales' then 'tahsilat' else 'ödeme' end,
    coalesce(a.source_table, 'manual'),
    i.direction,
    0::numeric(14,2),
    a.allocated_amount,
    i.id,
    a.id
  from public.invoice_allocations a
  join public.invoices i on i.id = a.invoice_id
  where a.reversed_at is null;

-- ── 6) DSO / DPO components ────────────────────────────────────────────────────────────────
--
-- The COMPONENTS, not the ratio. A view cannot take a period parameter, and hard-coding one
-- would bury the assumption that matters most in a metric everyone quotes and few define the
-- same way. src/lib/receivables/rules.ts computes the ratio from these numbers with the formula
-- written down and unit-tested; anything reading it can choose its own window.
--
--   DSO = (open receivables / credit sales in period) × period days
--   DPO = (open payables    / credit purchases in period) × period days
create or replace view public.dso_dpo_components as
  select
    (select coalesce(sum(gross_amount - allocated_amount), 0)
       from public.invoices
      where direction='sales' and status in ('open','partial'))                     as receivables_open,
    (select coalesce(sum(gross_amount - allocated_amount), 0)
       from public.invoices
      where direction='purchase' and status in ('open','partial'))                  as payables_open,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='sales' and status <> 'cancelled'
        and issue_date >= current_date - 365)                                       as sales_365,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='purchase' and status <> 'cancelled'
        and issue_date >= current_date - 365)                                       as purchases_365,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='sales' and status <> 'cancelled'
        and issue_date >= current_date - 90)                                        as sales_90,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='purchase' and status <> 'cancelled'
        and issue_date >= current_date - 90)                                        as purchases_90;

-- ── 7) realised settlement speed, per counterparty ─────────────────────────────────────────
--
-- The average days between issuing an invoice and allocating money to it. Unlike DSO this is
-- an OBSERVED figure rather than a ratio estimate, and it only counts invoices that actually
-- got settled — an unpaid invoice has no settlement duration, and treating it as zero (or as
-- today-minus-issue) would flatter or damn a counterparty for something that has not happened.
create or replace view public.counterparty_settlement_speed as
  select
    i.party_id,
    i.direction,
    count(distinct i.id)                                                   as settled_invoice_count,
    round(avg(a.allocated_on - i.issue_date)::numeric, 1)                  as avg_days_to_settle,
    min(a.allocated_on - i.issue_date)                                     as fastest_days,
    max(a.allocated_on - i.issue_date)                                     as slowest_days
  from public.invoices i
  join public.invoice_allocations a on a.invoice_id = i.id and a.reversed_at is null
  where i.status <> 'cancelled'
  group by i.party_id, i.direction;

grant select on public.collection_allocations to authenticated;
grant select on public.payment_allocations to authenticated;
grant select on public.receivables_open to authenticated;
grant select on public.payables_open to authenticated;
grant select on public.settlement_unallocated to authenticated;
grant select on public.current_account_summary to authenticated;
grant select on public.current_account_ledger to authenticated;
grant select on public.dso_dpo_components to authenticated;
grant select on public.counterparty_settlement_speed to authenticated;
