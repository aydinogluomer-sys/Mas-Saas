-- Phase 8: read-only scenario engine (implementation.md §20 Phase 8).
-- Scenarios are planning overlays. Baseline (cashflow_months etc.) is NEVER mutated;
-- scenario output lives only in these tables. Every run stores its explicit assumptions
-- and references the baseline it was computed from. Not accounting truth.

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  scenario_type text not null check (scenario_type in (
    'revenue_up_down_percent','expense_up_down_percent','customer_delay_days',
    'debt_service_overlay','capacity_utilization_change','efficiency_change',
    'combined_custom_scenario'
  )),
  baseline_label text,          -- disclosed baseline provenance (e.g. "TEMİZ 35 ay 2026-05..2029-03")
  baseline_month_count int,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.scenario_runs (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references public.scenarios(id) on delete cascade,
  run_at timestamptz not null default now(),
  assumptions jsonb not null,   -- explicit, never hidden
  baseline_final_cash numeric(14,2),
  scenario_final_cash numeric(14,2),
  final_delta numeric(14,2),
  baseline_first_negative date,
  scenario_first_negative date,
  worst_month date,
  worst_balance numeric(14,2),
  max_cash_gap numeric(14,2),   -- deepest shortfall magnitude (>=0)
  recovery_month date,
  month_count int,
  null_month_count int,         -- months with unknown income/expense (disclosed)
  confidence text not null default 'medium' check (confidence in ('high','medium','low')),
  notes text,
  created_at timestamptz not null default now()
);
create index scenario_runs_scenario_idx on public.scenario_runs(scenario_id);

create table public.scenario_run_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scenario_runs(id) on delete cascade,
  month_start date not null,
  baseline_income numeric(14,2),
  scenario_income numeric(14,2),
  baseline_expense numeric(14,2),
  scenario_expense numeric(14,2),
  baseline_closing numeric(14,2),
  scenario_closing numeric(14,2),
  delta numeric(14,2),
  created_at timestamptz not null default now(),
  unique(run_id, month_start)
);

create table public.scenario_assumptions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scenario_runs(id) on delete cascade,
  key text not null,
  value_numeric numeric(14,4),
  unit text,
  description text
);

create table public.scenario_comparisons (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scenario_runs(id) on delete cascade,
  metric text not null,
  baseline_value numeric(14,2),
  scenario_value numeric(14,2),
  delta numeric(14,2),
  unique(run_id, metric)
);

-- RLS + policy on the new tables (0007 ran before these existed; single-operator model)
do $$
declare t text;
begin
  for t in select unnest(array[
    'scenarios','scenario_runs','scenario_run_lines','scenario_assumptions','scenario_comparisons'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t);
  end loop;
end $$;
