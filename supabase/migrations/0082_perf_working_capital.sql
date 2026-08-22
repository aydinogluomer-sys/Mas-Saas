-- Faz 33 — the measured optimisation.
--
-- ═══ WHAT WAS MEASURED, AND WHY THE MEASUREMENT CAME FIRST ═══
--
-- All 77 read models were run against a realistic volume (24.000 invoices, 60.000 bank
-- transactions, 12.500 payment instances, 6.000 checks — scripts/perf/volume.ts) and ranked by
-- MEDIAN of three runs. The ranking did not match the guess anyone would make by reading them:
--
--     5.995 ms      37 rows   working_capital_trend     <- 55% of all 77 views COMBINED
--       708 ms  60.000 rows   anomaly_unusual_record_hour
--       650 ms  60.000 rows   bank_unmatched_queue
--       477 ms       0 rows   invoice_duplicate_suspects
--       291 ms      11 rows   control_dashboard
--
-- The 60.000-row entries are dominated by transferring 60.000 rows; no page selects them
-- unfiltered. The outlier that is genuinely PATHOLOGICAL is working_capital_trend: 37 rows for
-- six seconds, and it is loaded by a real screen (costing/engine.ts -> profitability page).
--
-- EXPLAIN (ANALYZE, BUFFERS) named the cause exactly: four correlated subqueries, each re-scanning
-- invoices once PER MONTH — 234.882 shared buffer hits to produce 37 rows.
--
-- ═══ THE FIX, AND THE ONE THAT WAS REJECTED ON EVIDENCE ═══
--
-- Measured, not assumed. Three candidates were built and timed:
--
--   A  original view, no index                     5.429 ms   (baseline)
--   B  original view + covering index              1.711 ms
--   D  single-pass rewrite, no index               1.048 ms
--   C  single-pass rewrite + covering index          632 ms   <- shipped
--
-- A fourth candidate — a cumulative-sum rewrite with as-of lookups — was written, proved
-- output-identical, and MEASURED AT 3.225 ms: slower than what it replaced. It was discarded.
-- It would have shipped as an "optimisation" on the strength of looking clever.
--
-- ═══ WHY NO MATERIALIZED VIEW ═══
--
-- The plan offers materialized views for this. Deliberately not used, and the reason is the same
-- one Faz 19/22/23/26 kept reaching: a materialized view IS stored derived data. Its inputs here
-- are invoices, which change constantly — an allocation posted today changes receivables_open for
-- a month two years ago — so it would be stale between refreshes, and a working-capital trend that
-- silently disagrees with the invoices beneath it is precisely the second source of truth this
-- system spends every phase avoiding.
--
-- It was not needed. 8,6x came from a rewrite that changes no number and an index that changes no
-- number. A materialized view would have bought the remaining milliseconds by introducing
-- staleness, which is a bad trade at 632 ms.
--
-- ═══ THE REWRITE CHANGES NO NUMBER — PROVEN, NOT PROMISED ═══
--
-- DSO/DPO drive real decisions, so "it should be equivalent" is not good enough. The rewrite was
-- compared against the previous definition with a symmetric EXCEPT over the full result set on the
-- volume fixture: zero differing rows in either direction. phase33:verify re-runs that comparison
-- against a preserved copy of the OLD definition on every run, so a future edit that changes a
-- figure fails the gate instead of quietly changing a CFO's DSO.
--
-- The semantics preserved exactly, including the awkward one: the 365-day window is
-- `issue_date > (period_start - 365 days)`, which does NOT align to a month boundary. An earlier
-- draft bucketed by month and would have silently dropped invoices issued on one specific day per
-- year.

-- ── the covering index ──────────────────────────────────────────────────────────────────
--
-- Turns the per-month aggregate scans into INDEX-ONLY scans: the previous plan re-read 16.539 heap
-- blocks per subplan per month. INCLUDE carries the two money columns so the heap is not touched
-- at all.
create index if not exists invoices_direction_status_issue_cover
  on public.invoices (direction, status, issue_date)
  include (gross_amount, allocated_amount);

-- ── the rewrite: one pass instead of four-per-month ─────────────────────────────────────
--
-- Same output, same column names, same order. The months CTE is unchanged. What changes is that
-- the four figures are now conditional aggregates over ONE join, so invoices is scanned once per
-- query rather than once per month per figure.
create or replace view public.working_capital_trend as
  with months as (
    select distinct date_trunc('month', issue_date)::date as period_start
    from public.invoices
    where issue_date is not null and status <> 'cancelled'
  ),
  agg as (
    select
      m.period_start,
      -- Open receivables/payables as at month end. `status in ('open','partial')` already
      -- excludes cancelled, exactly as the previous definition relied on.
      coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0))
        filter (where v.direction = 'sales' and v.status in ('open', 'partial')), 0)
        as receivables_open,
      coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0))
        filter (where v.direction = 'purchase' and v.status in ('open', 'partial')), 0)
        as payables_open,
      -- Trailing-365-day turnover. The lower bound is a DATE comparison, not a month bucket.
      coalesce(sum(v.gross_amount)
        filter (where v.direction = 'sales' and v.status <> 'cancelled'
                  and v.issue_date > (m.period_start - interval '365 days')), 0)
        as sales_365,
      coalesce(sum(v.gross_amount)
        filter (where v.direction = 'purchase' and v.status <> 'cancelled'
                  and v.issue_date > (m.period_start - interval '365 days')), 0)
        as purchases_365
    from months m
    -- LEFT JOIN, not INNER: a month whose invoices are all cancelled must still appear with
    -- zeroes rather than vanishing from the trend.
    left join public.invoices v
      on v.issue_date is not null
     and v.issue_date <= (m.period_start + interval '1 month' - interval '1 day')
    group by m.period_start
  )
  select
    period_start,
    receivables_open,
    payables_open,
    case when sales_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0), 1) end as dso_days,
    case when purchases_365 = 0 then null
         else round(payables_open / (purchases_365 / 365.0), 1) end as dpo_days,
    -- Still always NULL, still for the same reason: this system has no inventory data (Faz 30).
    null::numeric                                                   as dio_days,
    case when sales_365 = 0 or purchases_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0)
                  - payables_open / (purchases_365 / 365.0), 1) end as cash_cycle_excluding_inventory
  from agg
  order by period_start;

grant select on public.working_capital_trend to mas_radar_viewer,
  mas_radar_finance_operator, mas_radar_finance_approver,
  mas_radar_finance_manager, mas_radar_admin;

-- ── the OLD definition, preserved verbatim as an equivalence oracle ─────────────────────
--
-- This is not a second source of truth: nothing reads it, no page loads it, and it is not granted
-- to any tier. It exists so phase33:verify can assert — on every run, against whatever data is in
-- the fixture — that the fast view and the definition it replaced return byte-identical rows.
--
-- A gate that only compared them ONCE, on the day of the rewrite, would not notice the next edit.
create or replace view public.working_capital_trend_reference as
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
