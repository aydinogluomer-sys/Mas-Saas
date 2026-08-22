-- Faz 30 — profitability and working-capital read models. VIEWS only; no new source data.
--
-- ═══ THE PROFITABILITY PATTERN IS TEMPLATED, NOT REINVENTED ═══
--
-- src/lib/production/rules.ts:partProfitability already established how this codebase computes a
-- margin, and these views follow it exactly:
--   margin      = revenue − cost, and NULL when EITHER side is unknown (never 0)
--   margin_rate = margin / revenue, and NULL when revenue is 0 or unknown (never 0, never ∞)
--   a `confidence` flag says when an input was missing, rather than a plausible number hiding it
-- Copying that shape matters more than the SQL: a margin that reads 0 because the cost was
-- unknown is indistinguishable from a genuine break-even, and this codebase already decided that
-- unknown must stay unknown.
--
-- ═══ ONE SOURCE PER AXIS — NO DOUBLE COUNTING ═══
--
-- Revenue and cost both come from INVOICES only. The same money also exists as payments and bank
-- transactions, and summing an invoice alongside the payment that settles it would roughly double
-- the figure while still looking plausible. Faz 28 recorded this trap for budget actuals; the same
-- rule applies here and for the same reason.

-- ── 1) invoice facts, dimensioned ──────────────────────────────────────────────────────
create or replace view public.costing_invoice_facts as
  select
    v.id                                   as invoice_id,
    v.party_id,
    v.direction,
    date_trunc('month', v.issue_date)::date as period_start,
    v.currency,
    v.cost_center_id,
    v.project_id,
    v.gross_amount,
    v.status
  from public.invoices v
  where v.status <> 'cancelled'
    and v.issue_date is not null
    and v.gross_amount is not null;

-- ── 2) profitability by cost centre ────────────────────────────────────────────────────
--
-- Every profitability view below repeats the same NULL discipline. `revenue` and `cost` are
-- summed with `filter`, which yields NULL (not 0) when no row of that direction exists — which is
-- exactly the distinction the pattern requires.
create or replace view public.profitability_by_cost_center as
  select
    cc.id                                   as cost_center_id,
    cc.code                                 as cost_center_code,
    cc.name                                 as cost_center_name,
    f.currency,
    sum(f.gross_amount) filter (where f.direction = 'sales')    as revenue,
    sum(f.gross_amount) filter (where f.direction = 'purchase') as direct_cost,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales') is null
        or sum(f.gross_amount) filter (where f.direction = 'purchase') is null then null
      else sum(f.gross_amount) filter (where f.direction = 'sales')
         - sum(f.gross_amount) filter (where f.direction = 'purchase')
    end                                     as margin,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales') is null
        or sum(f.gross_amount) filter (where f.direction = 'sales') = 0
        or sum(f.gross_amount) filter (where f.direction = 'purchase') is null then null
      else round((sum(f.gross_amount) filter (where f.direction = 'sales')
                - sum(f.gross_amount) filter (where f.direction = 'purchase'))
                / sum(f.gross_amount) filter (where f.direction = 'sales'), 4)
    end                                     as margin_rate,
    count(*) filter (where f.direction = 'sales')    as sales_invoice_count,
    count(*) filter (where f.direction = 'purchase') as purchase_invoice_count,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales') is null
        or sum(f.gross_amount) filter (where f.direction = 'purchase') is null
      then 'needs_review' else 'estimated'
    end                                     as confidence
  from public.cost_centers cc
  left join public.costing_invoice_facts f on f.cost_center_id = cc.id
  group by cc.id, cc.code, cc.name, f.currency;

-- ── 3) profitability by project ────────────────────────────────────────────────────────
create or replace view public.profitability_by_project as
  select
    p.id                                    as project_id,
    p.code                                  as project_code,
    p.name                                  as project_name,
    p.cost_center_id,
    f.currency,
    sum(f.gross_amount) filter (where f.direction = 'sales')    as revenue,
    sum(f.gross_amount) filter (where f.direction = 'purchase') as direct_cost,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales') is null
        or sum(f.gross_amount) filter (where f.direction = 'purchase') is null then null
      else sum(f.gross_amount) filter (where f.direction = 'sales')
         - sum(f.gross_amount) filter (where f.direction = 'purchase')
    end                                     as margin,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales') is null
        or sum(f.gross_amount) filter (where f.direction = 'sales') = 0
        or sum(f.gross_amount) filter (where f.direction = 'purchase') is null then null
      else round((sum(f.gross_amount) filter (where f.direction = 'sales')
                - sum(f.gross_amount) filter (where f.direction = 'purchase'))
                / sum(f.gross_amount) filter (where f.direction = 'sales'), 4)
    end                                     as margin_rate,
    count(*)                                as invoice_count
  from public.projects p
  left join public.costing_invoice_facts f on f.project_id = p.id
  group by p.id, p.code, p.name, p.cost_center_id, f.currency;

-- ── 4) profitability by counterparty (customer AND supplier) ───────────────────────────
--
-- One view, split by direction rather than two near-identical views: the same party is often
-- both, and reporting them separately would make a net relationship impossible to see.
create or replace view public.profitability_by_party as
  select
    pa.id                                   as party_id,
    pa.name                                 as party_name,
    pa.party_type,
    f.currency,
    sum(f.gross_amount) filter (where f.direction = 'sales')    as revenue_from_party,
    sum(f.gross_amount) filter (where f.direction = 'purchase') as cost_to_party,
    -- Net trading position with this counterparty. NULL when either side is unrecorded.
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales') is null
        or sum(f.gross_amount) filter (where f.direction = 'purchase') is null then null
      else sum(f.gross_amount) filter (where f.direction = 'sales')
         - sum(f.gross_amount) filter (where f.direction = 'purchase')
    end                                     as net_contribution,
    count(*) filter (where f.direction = 'sales')    as sales_invoice_count,
    count(*) filter (where f.direction = 'purchase') as purchase_invoice_count,
    -- What the party actually IS in the data, rather than what its type column claims.
    case
      when count(*) filter (where f.direction = 'sales') > 0
       and count(*) filter (where f.direction = 'purchase') > 0 then 'both'
      when count(*) filter (where f.direction = 'sales') > 0 then 'customer'
      when count(*) filter (where f.direction = 'purchase') > 0 then 'supplier'
      else 'no_activity'
    end                                     as observed_role
  from public.parties pa
  left join public.costing_invoice_facts f on f.party_id = pa.id
  group by pa.id, pa.name, pa.party_type, f.currency;

-- ── 5) profitability by department — the honest gap ────────────────────────────────────
--
-- MEASURED, NOT ASSUMED: no transaction table in this schema carries a department_id. Faz 28
-- recorded the same finding for budget actuals, and the same answer applies — the view lists
-- every department with NULL figures and a reason, rather than inventing an allocation that no
-- row in this database supports. Fabricating one would answer "which department earned this"
-- with a number nobody could defend.
create or replace view public.profitability_by_department as
  select
    d.id                    as department_id,
    d.code                  as department_code,
    d.name                  as department_name,
    d.parent_department_id,
    null::numeric           as revenue,
    null::numeric           as direct_cost,
    null::numeric           as margin,
    null::numeric           as margin_rate,
    'no_transaction_link'::text as unmeasurable_reason,
    -- Named so a screen can say WHY the row is empty instead of rendering blanks.
    'Hiçbir işlem tablosunda department_id yok; tahsis kuralı icat edilmedi'::text as note
  from public.departments d;

-- ── 6) machine profitability, from the existing ROI snapshots ─────────────────────────
--
-- Built on machine_roi_snapshots, which already carries revenue/cost per machine and its own
-- `confidence` column — the profitability precedent this phase was told to template from rather
-- than reinvent. An earlier draft joined machine_minute_allocations instead; introspection showed
-- that table is keyed by (capacity_model, operation_type) and has no machine at all — it measures
-- CAPACITY UTILISATION, a different axis, and using it here would have attributed shop-wide
-- minutes to individual machines.
create or replace view public.profitability_by_machine as
  select
    m.id                                    as machine_id,
    m.name                                  as machine_name,
    m.machine_type,
    m.purchase_cost,
    r.snapshot_year,
    r.revenue,
    r.cost,
    -- Same NULL discipline as every other margin here: unknown stays unknown.
    case when r.revenue is null or r.cost is null then null
         else r.revenue - r.cost end        as margin,
    case when r.revenue is null or r.revenue = 0 or r.cost is null then null
         else round((r.revenue - r.cost) / r.revenue, 4) end as margin_rate,
    r.net_after_tax,
    -- ROI against the purchase price, when both are known. NULL on a zero or missing cost rather
    -- than an infinite return.
    case when r.net_after_tax is null or m.purchase_cost is null or m.purchase_cost = 0 then null
         else round(r.net_after_tax / m.purchase_cost, 4) end as roi_rate,
    coalesce(r.confidence, 'no_snapshot')   as confidence
  from public.machine_assets m
  left join public.machine_roi_snapshots r on r.machine_asset_id = m.id;

-- ── 7) company rollup ──────────────────────────────────────────────────────────────────
create or replace view public.profitability_company as
  select
    f.currency,
    f.period_start,
    sum(f.gross_amount) filter (where f.direction = 'sales')    as revenue,
    sum(f.gross_amount) filter (where f.direction = 'purchase') as direct_cost,
    case
      when sum(f.gross_amount) filter (where f.direction = 'sales') is null
        or sum(f.gross_amount) filter (where f.direction = 'purchase') is null then null
      else sum(f.gross_amount) filter (where f.direction = 'sales')
         - sum(f.gross_amount) filter (where f.direction = 'purchase')
    end                                     as margin,
    count(*)                                as invoice_count,
    count(*) filter (where f.cost_center_id is null) as undimensioned_invoice_count
  from public.costing_invoice_facts f
  group by f.currency, f.period_start;

-- ── 8) working capital: DSO / DPO / DIO / CCC ──────────────────────────────────────────
--
-- Faz 22 deliberately shipped dso_dpo_components WITHOUT the ratio, leaving the division to a
-- later phase. This is that phase, and the division is done here — over 365 days, with the
-- guards that make the answer honest:
--
--   * a zero or NULL denominator yields NULL, not 0 and not infinity;
--   * DIO IS NULL, ALWAYS, and that is a measured fact rather than an oversight. This schema has
--     no inventory: no stock table, no on-hand column, nothing that records goods held. Treating
--     it as 0 would shorten the cash-conversion cycle by exactly the days this business holds
--     material, making the number look BETTER than reality — the most dangerous direction for a
--     working-capital metric to be wrong in.
--   * CCC therefore stays NULL too, because DSO + DIO − DPO cannot be computed from two of three
--     terms. `cash_cycle_excluding_inventory` is offered separately and NAMED for what it
--     excludes, so the useful part is available without anything pretending to be CCC.
create or replace view public.working_capital_metrics as
  with c as (select * from public.dso_dpo_components)
  select
    c.receivables_open,
    c.payables_open,
    c.sales_365,
    c.purchases_365,
    -- Days Sales Outstanding: open receivables ÷ average daily sales.
    case when c.sales_365 is null or c.sales_365 = 0 then null
         else round(c.receivables_open / (c.sales_365 / 365.0), 1) end as dso_days,
    -- Days Payables Outstanding.
    case when c.purchases_365 is null or c.purchases_365 = 0 then null
         else round(c.payables_open / (c.purchases_365 / 365.0), 1) end as dpo_days,
    -- Always NULL — see the header. Kept as a column so consumers have a stable shape and the
    -- absence is explicit rather than a missing field.
    null::numeric                                                       as dio_days,
    'no_inventory_data'::text                                           as dio_unmeasurable_reason,
    null::numeric                                                       as cash_conversion_cycle_days,
    'dio_unknown'::text                                                 as ccc_unmeasurable_reason,
    -- The part that CAN be computed, labelled for exactly what it leaves out.
    case
      when c.sales_365 is null or c.sales_365 = 0
        or c.purchases_365 is null or c.purchases_365 = 0 then null
      else round(c.receivables_open / (c.sales_365 / 365.0)
               - c.payables_open / (c.purchases_365 / 365.0), 1)
    end                                                                 as cash_cycle_excluding_inventory
  from c;

-- ── 9) working capital trend, month by month ───────────────────────────────────────────
--
-- Trailing 365-day denominators per month, so a month's DSO is comparable with the next one's.
-- Built from invoices directly rather than from the point-in-time components view, because that
-- view answers "today" and a trend needs each month's own position.
create or replace view public.working_capital_trend as
  with months as (
    select distinct date_trunc('month', issue_date)::date as period_start
    from public.invoices
    where issue_date is not null and status <> 'cancelled'
  ),
  per_month as (
    select
      m.period_start,
      (select coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0)), 0)
       from public.invoices v
       where v.direction = 'sales' and v.status in ('open', 'partial')
         and v.issue_date <= (m.period_start + interval '1 month' - interval '1 day')) as receivables_open,
      (select coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0)), 0)
       from public.invoices v
       where v.direction = 'purchase' and v.status in ('open', 'partial')
         and v.issue_date <= (m.period_start + interval '1 month' - interval '1 day')) as payables_open,
      (select coalesce(sum(v.gross_amount), 0)
       from public.invoices v
       where v.direction = 'sales' and v.status <> 'cancelled'
         and v.issue_date > (m.period_start - interval '365 days')
         and v.issue_date <= (m.period_start + interval '1 month' - interval '1 day')) as sales_365,
      (select coalesce(sum(v.gross_amount), 0)
       from public.invoices v
       where v.direction = 'purchase' and v.status <> 'cancelled'
         and v.issue_date > (m.period_start - interval '365 days')
         and v.issue_date <= (m.period_start + interval '1 month' - interval '1 day')) as purchases_365
    from months m
  )
  select
    period_start,
    receivables_open,
    payables_open,
    case when sales_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0), 1) end as dso_days,
    case when purchases_365 = 0 then null
         else round(payables_open / (purchases_365 / 365.0), 1) end as dpo_days,
    null::numeric                                                   as dio_days,
    case when sales_365 = 0 or purchases_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0)
                  - payables_open / (purchases_365 / 365.0), 1) end as cash_cycle_excluding_inventory
  from per_month
  order by period_start;

grant select on public.costing_invoice_facts to authenticated;
grant select on public.profitability_by_cost_center to authenticated;
grant select on public.profitability_by_project to authenticated;
grant select on public.profitability_by_party to authenticated;
grant select on public.profitability_by_department to authenticated;
grant select on public.profitability_by_machine to authenticated;
grant select on public.profitability_company to authenticated;
grant select on public.working_capital_metrics to authenticated;
grant select on public.working_capital_trend to authenticated;
