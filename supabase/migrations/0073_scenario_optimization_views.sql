-- Faz 29 — multi-variable scenario comparison and optimisation read models. VIEWS only.
--
-- Nothing here writes. The Faz 8/13 invariant (baseline read, scenario overlay read-only) holds
-- trivially for a view, and that is deliberate: the comparison surface this phase adds cannot
-- become a back door into the baseline.

-- ── 1) multi-run scenario comparison ───────────────────────────────────────────────────
--
-- The existing `scenario_comparisons` table is PER RUN: (run_id, metric, baseline_value,
-- scenario_value, delta) — it answers "how did this one run differ from baseline". Comparing
-- several runs against each other is a different question, and it is answered here as a view
-- rather than by adding a table, because every number it needs already exists.
--
-- Runs are compared against THE SAME baseline value per metric. Two runs whose baselines differ
-- are not comparable, and rather than silently averaging them the view exposes the baseline it
-- used so a mismatch is visible.
create or replace view public.scenario_comparison_matrix as
  select
    s.id                                as scenario_id,
    s.name                              as scenario_name,
    s.scenario_type,
    r.id                                as run_id,
    r.run_at,
    r.confidence,
    c.metric,
    c.baseline_value,
    c.scenario_value,
    c.delta,
    -- Relative movement, so metrics of different magnitudes can be ranked side by side. NULL
    -- against a zero baseline rather than an infinite ratio.
    case when c.baseline_value is null or c.baseline_value = 0 then null
         else round(c.delta / abs(c.baseline_value), 4) end as delta_ratio,
    -- Rank within a metric, best first. `delta` is signed and its desirable direction depends on
    -- the metric, so this ranks by magnitude and leaves interpretation to the caller rather than
    -- pretending one direction is universally better.
    rank() over (partition by c.metric order by abs(c.delta) desc nulls last) as magnitude_rank
  from public.scenario_comparisons c
  join public.scenario_runs r on r.id = c.run_id
  join public.scenarios s on s.id = r.scenario_id
  where r.archived_at is null;

-- ── 2) optimisation run summary, with its approval state ───────────────────────────────
--
-- The approval state is JOINED FROM `approvals`, never duplicated onto optimization_runs. That is
-- the whole point of connecting to Faz 24A's entity: there is exactly one place that knows
-- whether something is approved.
create or replace view public.optimization_run_summary as
  select
    o.id                                            as run_id,
    o.name,
    o.objective,
    o.anchor_date,
    o.horizon_days,
    o.currency,
    o.scenario_run_id,
    o.result_digest,
    o.created_at,
    count(rec.id)                                   as recommendation_count,
    coalesce(sum(rec.expected_effect), 0)           as total_expected_effect,
    count(rec.id) filter (where rec.action_kind in ('defer_payment', 'advance_payment'))
                                                    as timing_actions,
    count(rec.id) filter (where rec.action_kind in ('draw_facility', 'repay_facility'))
                                                    as financing_actions,
    -- Latest approval round for this run, or NULL when none has been requested.
    a.status                                        as approval_status,
    a.round_no                                      as approval_round,
    a.decided_at                                    as approval_decided_at
  from public.optimization_runs o
  left join public.optimization_recommendations rec on rec.run_id = o.id
  left join lateral (
    select ap.status, ap.round_no, ap.decided_at
    from public.approvals ap
    where ap.subject_table = 'optimization_runs' and ap.subject_id = o.id
    order by ap.round_no desc
    limit 1
  ) a on true
  group by o.id, o.name, o.objective, o.anchor_date, o.horizon_days, o.currency,
           o.scenario_run_id, o.result_digest, o.created_at,
           a.status, a.round_no, a.decided_at;

-- ── 3) recommendations with their named rationale ──────────────────────────────────────
create or replace view public.optimization_recommendation_detail as
  select
    rec.id                              as recommendation_id,
    rec.run_id,
    o.name                              as run_name,
    o.objective,
    rec.rank,
    rec.action_kind,
    rec.subject_table,
    rec.subject_id,
    rec.subject_label,
    rec.current_date_value,
    rec.proposed_date,
    -- How far the suggestion moves the date. Signed: positive is later.
    case when rec.proposed_date is null or rec.current_date_value is null then null
         else (rec.proposed_date - rec.current_date_value) end as shift_days,
    rec.amount,
    rec.currency,
    rec.expected_effect,
    rec.rationale_codes,
    rec.rationale_note,
    rec.confidence
  from public.optimization_recommendations rec
  join public.optimization_runs o on o.id = rec.run_id;

grant select on public.scenario_comparison_matrix to authenticated;
grant select on public.optimization_run_summary to authenticated;
grant select on public.optimization_recommendation_detail to authenticated;
