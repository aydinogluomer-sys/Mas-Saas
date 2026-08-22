-- Faz 28 — budget and forecast read models. VIEWS; deterministic SQL, no stored variance.
--
-- NOTHING HERE CALLS A MODEL. Every number is arithmetic over recorded rows. The AI layer's
-- existing boundary (deterministic answer first, LLM only as commentary — src/lib/ai/engine.ts)
-- is untouched by this phase, and phase28:verify asserts that the budget/forecast modules do not
-- import it at all.

-- ── 1) actuals, from ONE source per axis ───────────────────────────────────────────────
--
-- THE DOUBLE-COUNTING TRAP, avoided explicitly: the same money appears as an invoice AND as the
-- payment that settles it. Summing both would report roughly twice the actual spend, and the
-- number would still look plausible. Actuals here come from INVOICES only — the obligation as it
-- was recorded — and the payment side is deliberately not joined in.
--
-- Only the dimensions that actually exist on a transaction are produced: invoices carry
-- cost_center_id and project_id. There is no department link anywhere in this schema, so
-- department actuals are absent rather than estimated.
create or replace view public.budget_actuals_monthly as
  select
    date_trunc('month', v.issue_date)::date              as period_start,
    case when v.direction = 'sales' then 'income' else 'expense' end as direction,
    v.cost_center_id,
    v.project_id,
    v.currency,
    sum(v.gross_amount)                                   as actual_amount,
    count(*)                                              as document_count
  from public.invoices v
  where v.status <> 'cancelled'
    and v.issue_date is not null
    and v.gross_amount is not null
  group by 1, 2, v.cost_center_id, v.project_id, v.currency;

-- ── 2) budget versus actual, with variance ─────────────────────────────────────────────
--
-- Only APPROVED lines are measured. Draft lines are working notes and superseded lines are
-- history; reporting variance against either would let a number move because someone was still
-- editing, which is the whole reason the version lifecycle exists.
create or replace view public.budget_vs_actual as
  select
    b.id                                    as budget_id,
    b.name                                  as budget_name,
    b.fiscal_year,
    l.id                                    as budget_line_id,
    l.period_start,
    l.direction,
    l.cost_center_id,
    cc.name                                 as cost_center_name,
    l.department_id,
    d.name                                  as department_name,
    l.project_id,
    p.name                                  as project_name,
    l.category_id,
    l.currency,
    l.amount                                as budget_amount,
    a.actual_amount,
    -- NULL, not zero, when the period has no matching actual row. Zero would assert "nothing was
    -- spent", which is a claim; a missing row means we have not recorded anything for that cell.
    case when a.actual_amount is null then null
         else a.actual_amount - l.amount end as variance_amount,
    case when a.actual_amount is null or l.amount = 0 then null
         else round((a.actual_amount - l.amount) / l.amount, 4) end as variance_ratio,
    -- Direction-aware verdict. Overspending an expense budget and overshooting an income budget
    -- are opposite outcomes, and a single unsigned "variance" would colour one of them wrongly.
    case
      when a.actual_amount is null then 'not_measured'
      when l.direction = 'expense' and a.actual_amount > l.amount then 'over_budget'
      when l.direction = 'expense' then 'within_budget'
      when a.actual_amount < l.amount then 'under_target'
      else 'on_or_above_target'
    end                                     as variance_verdict,
    -- Recorded so a screen can explain a NULL actual instead of showing a blank cell.
    (l.department_id is not null)           as department_scoped
  from public.budget_lines l
  join public.budgets b on b.id = l.budget_id
  left join public.cost_centers cc on cc.id = l.cost_center_id
  left join public.departments d on d.id = l.department_id
  left join public.projects p on p.id = l.project_id
  left join public.budget_actuals_monthly a
    on a.period_start = l.period_start
   and a.direction = l.direction
   and a.currency = l.currency
   and a.cost_center_id is not distinct from l.cost_center_id
   and a.project_id is not distinct from l.project_id
  where l.version_status = 'approved';

-- ── 3) variance summary per budget ─────────────────────────────────────────────────────
create or replace view public.budget_variance_summary as
  select
    v.budget_id,
    v.budget_name,
    v.fiscal_year,
    v.direction,
    v.currency,
    count(*)                                                    as line_count,
    sum(v.budget_amount)                                        as budget_total,
    sum(v.actual_amount)                                        as actual_total,
    sum(v.variance_amount)                                      as variance_total,
    count(*) filter (where v.variance_verdict = 'over_budget')  as over_budget_lines,
    -- Surfaced, never hidden: a summary resting on unmeasured lines must say how many.
    count(*) filter (where v.variance_verdict = 'not_measured') as not_measured_lines,
    count(*) filter (where v.department_scoped and v.actual_amount is null)
                                                                as department_lines_unmeasurable
  from public.budget_vs_actual v
  group by v.budget_id, v.budget_name, v.fiscal_year, v.direction, v.currency;

-- ── 4) the named 13-week cash forecast horizon ─────────────────────────────────────────
--
-- Weeks are generated rather than assumed to exist as rows, so the horizon is always exactly 13
-- buckets even where a week has no forecast line. A missing week silently disappearing from a
-- cash forecast is how a gap becomes invisible.
create or replace view public.cash_forecast_13w as
  with anchors as (
    select f.id as forecast_id, f.name, f.anchor_date, f.currency
    from public.forecasts f
    where f.is_active and f.horizon_kind = 'weekly_13'
  ),
  weeks as (
    select a.forecast_id, a.name, a.currency, a.anchor_date,
           gs.week_no,
           (a.anchor_date + ((gs.week_no - 1) * 7))::date as week_start,
           (a.anchor_date + (gs.week_no * 7) - 1)::date   as week_end
    from anchors a
    cross join generate_series(1, 13) as gs(week_no)
  )
  select
    w.forecast_id,
    w.name                                     as forecast_name,
    w.week_no,
    w.week_start,
    w.week_end,
    w.currency,
    coalesce(sum(l.amount) filter (where l.direction = 'inflow'), 0)   as inflow,
    coalesce(sum(l.amount) filter (where l.direction = 'outflow'), 0)  as outflow,
    coalesce(sum(case when l.direction = 'inflow' then l.amount else -l.amount end), 0) as net_flow,
    -- Contracted-only view of the same week: the conservative number, kept separate so a screen
    -- can show what survives if every estimate is wrong.
    coalesce(sum(case when l.direction = 'inflow' then l.amount else -l.amount end)
             filter (where l.source_kind = 'contracted'), 0)           as net_flow_contracted,
    count(l.id)                                                        as line_count,
    count(l.id) filter (where l.source_kind = 'estimated')             as estimated_line_count,
    -- Weighted by confidence where it is scored; unscored lines contribute their face value
    -- rather than vanishing, because dropping them would understate the week.
    coalesce(sum(case when l.direction = 'inflow' then l.amount else -l.amount end
                 * coalesce(l.confidence, 1)), 0)                      as net_flow_confidence_weighted
  from weeks w
  left join public.forecast_lines l
    on l.forecast_id = w.forecast_id
   and l.version_status = 'approved'
   and l.period_start >= w.week_start
   and l.period_start <= w.week_end
  group by w.forecast_id, w.name, w.week_no, w.week_start, w.week_end, w.currency;

-- ── 5) forecast accuracy KPIs ──────────────────────────────────────────────────────────
--
-- Deterministic, and counted only over lines that have actually been measured. An unmeasured line
-- is excluded rather than scored as perfect — including it would make a forecast look more
-- accurate the less of it had been checked, which is exactly backwards.
create or replace view public.forecast_accuracy as
  select
    f.id                                          as forecast_id,
    f.name                                        as forecast_name,
    f.horizon_kind,
    f.anchor_date,
    l.source_kind,
    count(*)                                      as measured_line_count,
    sum(l.amount)                                 as forecast_total,
    sum(l.actual_amount)                          as actual_total,
    sum(l.actual_amount - l.amount)               as bias_total,
    sum(abs(l.actual_amount - l.amount))          as absolute_error_total,
    -- Mean absolute percentage error, skipping zero-forecast lines: dividing by a zero forecast
    -- is undefined, and treating it as 100% error would let one such line dominate the KPI.
    case
      when count(*) filter (where l.amount <> 0) = 0 then null
      else round(
        avg(abs(l.actual_amount - l.amount) / abs(l.amount))
          filter (where l.amount <> 0), 4)
    end                                           as mape,
    count(*) filter (where l.amount = 0)          as zero_forecast_lines
  from public.forecast_lines l
  join public.forecasts f on f.id = l.forecast_id
  where l.actual_amount is not null
    and l.version_status in ('approved', 'superseded')
  group by f.id, f.name, f.horizon_kind, f.anchor_date, l.source_kind;

-- ── 6) coverage: how much of a forecast has been measured at all ───────────────────────
create or replace view public.forecast_coverage as
  select
    f.id                                                    as forecast_id,
    f.name                                                  as forecast_name,
    count(l.id)                                             as line_count,
    count(l.id) filter (where l.actual_amount is not null)  as measured_count,
    count(l.id) filter (where l.version_status = 'approved') as approved_count,
    count(l.id) filter (where l.version_status = 'draft')    as draft_count,
    case when count(l.id) = 0 then null
         else round(count(l.id) filter (where l.actual_amount is not null)::numeric
                    / count(l.id), 4) end                   as measured_ratio,
    -- The confidence mix, so a reader can see whether a comfortable forecast rests on contracts
    -- or on estimates.
    count(l.id) filter (where l.source_kind = 'contracted')  as contracted_count,
    count(l.id) filter (where l.source_kind = 'estimated')   as estimated_count
  from public.forecasts f
  left join public.forecast_lines l on l.forecast_id = f.id
  group by f.id, f.name;

grant select on public.budget_actuals_monthly to authenticated;
grant select on public.budget_vs_actual to authenticated;
grant select on public.budget_variance_summary to authenticated;
grant select on public.cash_forecast_13w to authenticated;
grant select on public.forecast_accuracy to authenticated;
grant select on public.forecast_coverage to authenticated;
