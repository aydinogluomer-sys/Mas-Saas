-- Faz 23 — collection risk and cash-aware payment scheduling, as READ MODELS.
--
-- Views over Faz 19-22, no new source data. Everything here is derivable from invoices,
-- allocations, payments and the cash projection that already exist; a stored risk score would
-- be a second source of truth that goes stale the moment an allocation lands (the reason
-- 0039/0043/0047/0050 are all views).
--
-- DETERMINISTIC SIGNALS ONLY. These views expose FACTS — days overdue, what this counterparty
-- has actually done before, how much is open, whether a human flagged the debt. They compute no
-- probability and no score. The scoring lives in src/lib/collections/rules.ts as a table of
-- named rules with fixed weights, so every verdict can be traced to the rule that produced it
-- and corrected by editing that rule. implementation.md asks for "deterministik sezgi (ML
-- değil)"; a model would be unable to answer "why" to a finance operator, which is the only
-- question that matters when someone is deciding whether to chase a customer.

-- ── 1) per-receivable collection signals ───────────────────────────────────────────────────
--
-- One row per open receivable, carrying the raw inputs the scorer needs. The counterparty's
-- history is joined from Faz 22's realised settlement speed — an OBSERVED figure, not an
-- estimate, and null when this counterparty has never settled anything (which the scorer must
-- treat as "unknown", never as "fast").
create or replace view public.receivable_collection_signals as
  select
    i.id                                            as invoice_id,
    i.party_id,
    pa.name                                         as party_name,
    i.invoice_no,
    i.issue_date,
    i.due_date,
    i.gross_amount,
    i.allocated_amount,
    (i.gross_amount - i.allocated_amount)           as open_amount,
    i.status,
    (i.bad_debt_at is not null)                     as bad_debt_flagged,
    i.bad_debt_reason,
    case when i.due_date is null then null else (current_date - i.due_date) end as days_overdue,
    -- What this counterparty has actually done, over every settled sales invoice.
    spd.avg_days_to_settle                          as party_avg_days_to_settle,
    spd.settled_invoice_count                       as party_settled_count,
    -- How much of this counterparty's own history was late. A ratio of observed facts, not a
    -- prediction: null when there is no history to divide.
    hist.late_ratio                                 as party_late_ratio,
    hist.invoice_count                              as party_invoice_count,
    -- Partial settlement is itself a signal: a counterparty who has paid something is behaving
    -- differently from one who has paid nothing at all.
    (i.allocated_amount > 0)                        as partially_settled
  from public.invoices i
  join public.parties pa on pa.id = i.party_id
  left join public.counterparty_settlement_speed spd
    on spd.party_id = i.party_id and spd.direction = 'sales'
  left join (
    select
      h.party_id,
      count(*)                                                              as invoice_count,
      round(
        count(*) filter (where h.settled_late)::numeric
        / nullif(count(*), 0), 4)                                           as late_ratio
    from (
      select
        inv.party_id,
        inv.id,
        -- "Late" means the last money arrived after the due date. Invoices with no due date are
        -- excluded rather than counted as on-time: an undated invoice cannot be late, and
        -- counting it as punctual would flatter the counterparty.
        (max(a.allocated_on) > inv.due_date) as settled_late
      from public.invoices inv
      join public.invoice_allocations a on a.invoice_id = inv.id and a.reversed_at is null
      where inv.direction = 'sales' and inv.status <> 'cancelled' and inv.due_date is not null
      group by inv.party_id, inv.id, inv.due_date
    ) h
    group by h.party_id
  ) hist on hist.party_id = i.party_id
  where i.direction = 'sales'
    and i.status in ('open', 'partial')
    and i.gross_amount > i.allocated_amount;

-- ── 2) cash-aware payment prioritisation ───────────────────────────────────────────────────
--
-- FEEDS THE EXISTING PAYMENTS MODULE, does not replace it. The ordering inputs are the columns
-- payments already carries — `flexibility_class` (critical/flexible/optional) and `priority`
-- (low/normal/high/critical) — rather than a new taxonomy invented here. implementation.md is
-- explicit that this must feed the existing module; a parallel priority scheme would mean two
-- answers to "what do we pay first".
--
-- The view produces an ORDER, not a decision. It does not know the cash balance — that comes
-- from the projection at read time, and the cutoff is applied in TypeScript where it can be
-- explained line by line. A view that silently decided which supplier goes unpaid would be
-- making a business call in SQL.
create or replace view public.payment_priority_queue as
  select
    src.kind,
    src.entity_id,
    src.due_date,
    src.label,
    src.amount,
    src.party_name,
    src.flexibility_class,
    src.priority,
    (src.due_date < current_date)                       as overdue,
    greatest(current_date - src.due_date, 0)            as days_overdue,
    -- Deterministic sort key, smaller = pay sooner. Written out rather than hidden in an
    -- ORDER BY so the ranking is visible to anyone reading a row.
    (
      case src.flexibility_class
        when 'critical' then 0 when 'flexible' then 100 when 'optional' then 200 else 150 end
      + case src.priority
        when 'critical' then 0 when 'high' then 10 when 'normal' then 20 when 'low' then 30 else 20 end
      + least(greatest((src.due_date - current_date), -30), 60)
    )                                                   as priority_rank
  from (
    -- Payment instances: the recurring/one-off obligations the radar already tracks.
    select
      'payment_instance'::text                          as kind,
      i.id                                              as entity_id,
      i.due_date,
      coalesce(p.name, '(silinmiş kalem)')              as label,
      i.amount,
      coalesce(pr.name, '')                             as party_name,
      coalesce(p.flexibility_class, 'flexible')         as flexibility_class,
      coalesce(p.priority, 'normal')                    as priority
    from public.payment_instances i
    left join public.payments p on p.id = i.payment_id
    left join public.parties pr on pr.id = p.provider_party_id
    where i.status in ('unpaid', 'partial', 'planned', 'late')

    union all

    -- Purchase invoices still open, from Faz 21/22.
    select
      'invoice', inv.id, coalesce(inv.due_date, inv.issue_date),
      inv.invoice_no, (inv.gross_amount - inv.allocated_amount), pa.name,
      'flexible', 'normal'
    from public.invoices inv
    join public.parties pa on pa.id = inv.party_id
    where inv.direction = 'purchase' and inv.status in ('open', 'partial')
      and inv.gross_amount > inv.allocated_amount

    union all

    -- Loan instalments: contractually the least flexible thing on the list.
    select
      'loan_installment', li.id, li.due_date, l.name, li.amount, '',
      'critical', 'critical'
    from public.loan_installments li
    join public.loans l on l.id = li.loan_id
    where li.status in ('planned', 'unpaid', 'partial', 'late') and l.archived_at is null

    union all

    -- Outgoing checks: a bounced cheque is a different order of problem from a late supplier.
    select
      'check', c.id, c.maturity_date,
      coalesce(c.counterparty_label, 'çek'), c.amount, coalesce(pe.name, ''),
      'critical', 'critical'
    from public.checks c
    left join public.parties pe on pe.id = c.payee_party_id
    where c.status in ('planned', 'unknown') and c.archived_at is null
      and c.direction = 'outflow'
  ) src
  where src.due_date is not null;

-- ── 3) payment calendar, extended ──────────────────────────────────────────────────────────
--
-- Day-level totals across every obligation kind, so the existing calendar can show what a day
-- actually costs rather than only what its payment instances cost. Unknown amounts are COUNTED,
-- never summed as zero — a day with four unpriced obligations is not a cheap day.
create or replace view public.payment_calendar_extended as
  select
    q.due_date,
    count(*)                                                as item_count,
    count(*) filter (where q.amount is null)                as unknown_amount_count,
    coalesce(sum(q.amount), 0)                              as known_total,
    coalesce(sum(q.amount) filter (where q.flexibility_class = 'critical'), 0) as critical_total,
    count(*) filter (where q.kind = 'payment_instance')     as payment_instance_count,
    count(*) filter (where q.kind = 'invoice')              as invoice_count,
    count(*) filter (where q.kind = 'loan_installment')     as loan_installment_count,
    count(*) filter (where q.kind = 'check')                as check_count,
    bool_or(q.overdue)                                      as has_overdue
  from public.payment_priority_queue q
  group by q.due_date;

-- ── 4) counterparty collection scorecard ───────────────────────────────────────────────────
--
-- Observed behaviour per counterparty, for the collections worklist. Every column is a count or
-- an average of things that happened; nothing here is a forecast.
create or replace view public.counterparty_collection_profile as
  select
    pa.id                                                   as party_id,
    pa.name                                                 as party_name,
    count(distinct s.invoice_id)                            as open_receivable_count,
    coalesce(sum(s.open_amount), 0)                         as open_receivable_amount,
    count(distinct s.invoice_id) filter (where s.days_overdue > 0)   as overdue_count,
    coalesce(sum(s.open_amount) filter (where s.days_overdue > 0), 0) as overdue_amount,
    count(distinct s.invoice_id) filter (where s.bad_debt_flagged)   as bad_debt_count,
    coalesce(sum(s.open_amount) filter (where s.bad_debt_flagged), 0) as bad_debt_amount,
    max(s.days_overdue)                                     as worst_days_overdue,
    max(s.party_avg_days_to_settle)                         as avg_days_to_settle,
    max(s.party_late_ratio)                                 as late_ratio
  from public.parties pa
  join public.receivable_collection_signals s on s.party_id = pa.id
  group by pa.id, pa.name;

grant select on public.receivable_collection_signals to authenticated;
grant select on public.payment_priority_queue to authenticated;
grant select on public.payment_calendar_extended to authenticated;
grant select on public.counterparty_collection_profile to authenticated;
