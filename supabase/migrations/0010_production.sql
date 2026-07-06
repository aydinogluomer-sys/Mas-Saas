-- Phase 7: production capacity & cost analytics (implementation.md §14 DDL, verbatim
-- + documented Phase-7 hardening). ANALYTICS ONLY — never feeds accounting truth.
-- Capacity rates carry their source year + stale flag; ROI defaults to needs_review.

create table public.machine_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  machine_type text check (machine_type in ('torna','freze','other','unknown')),
  purchase_cost numeric(14,2),
  notes text,
  created_at timestamptz not null default now()
);

create table public.production_parts (
  id uuid primary key default gen_random_uuid(),
  part_code text,
  part_name text not null,
  quantity int,
  torna_minutes numeric(14,4),
  freze_minutes numeric(14,4),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),
  created_at timestamptz not null default now()
);
-- idempotent mapping: at most one part per source row
create unique index production_parts_source_row_uq
  on public.production_parts(source_row_id) where source_row_id is not null;

create table public.capacity_models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scenario_type text not null check (scenario_type in ('normal','overtime','custom')),
  monthly_hours numeric(10,2),
  monthly_minutes numeric(14,2),
  work_days_per_month numeric(10,2),
  efficiency_rate numeric(8,4),
  staff_count numeric(10,2),
  apprentice_count numeric(10,2),
  -- Phase-7 additions: kapasite rate anchors + theoretical revenue + stale flag
  machine_count numeric(10,2),
  effective_monthly_minutes numeric(14,2),
  freze_rate_tl_per_min numeric(14,4),
  torna_rate_tl_per_min numeric(14,4),
  rate_year int,
  is_stale_rate boolean not null default false,
  theoretical_monthly_revenue numeric(14,2),
  theoretical_total_revenue numeric(14,2),
  notes text,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  created_at timestamptz not null default now()
);
create unique index capacity_models_source_sheet_uq
  on public.capacity_models(source_sheet_id) where source_sheet_id is not null;

create table public.cost_models (
  id uuid primary key default gen_random_uuid(),
  capacity_model_id uuid references public.capacity_models(id),
  model_name text not null,
  model_month date,
  scenario_type text check (scenario_type in ('normal','overtime','custom')),
  food_daily_cost numeric(14,2),
  transport_staff_daily_cost numeric(14,2),
  transport_apprentice_daily_cost numeric(14,2),
  health_insurance_cost numeric(14,2),
  machine_insurance_cost numeric(14,2),
  total_fixed_cost numeric(14,2),
  monthly_allocated_cost numeric(14,2),
  break_even_torna_tl_per_min numeric(14,4),
  break_even_freze_tl_per_min numeric(14,4),
  -- Phase-7 additions: single source break-even + reconciliation trace
  break_even_tl_per_min numeric(14,4),
  effective_monthly_minutes numeric(14,2),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  created_at timestamptz not null default now()
);
create unique index cost_models_source_sheet_uq
  on public.cost_models(source_sheet_id) where source_sheet_id is not null;

create table public.part_profitability_runs (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.production_parts(id) on delete cascade,
  cost_model_id uuid not null references public.cost_models(id) on delete cascade,
  estimated_torna_cost numeric(14,2),
  estimated_freze_cost numeric(14,2),
  estimated_total_cost numeric(14,2),
  estimated_revenue numeric(14,2),
  estimated_margin numeric(14,2),
  margin_rate numeric(8,4),
  confidence text not null default 'estimated' check (confidence in ('estimated','needs_review','reviewed')),
  missing_operation_time boolean not null default false,
  created_at timestamptz not null default now(),
  unique(part_id, cost_model_id)
);

create table public.machine_roi_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  machine_asset_id uuid references public.machine_assets(id),
  snapshot_year int,
  revenue numeric(14,2),
  cost numeric(14,2),
  remaining numeric(14,2),
  tax numeric(14,2),
  net_after_tax numeric(14,2),
  confidence text not null default 'needs_review' check (confidence in ('needs_review','reviewed','calculated')),
  notes text,
  created_at timestamptz not null default now(),
  unique(machine_asset_id, snapshot_year)
);

-- RLS + policy on the new tables (0007 ran before these existed; single-operator model)
do $$
declare t text;
begin
  for t in select unnest(array[
    'machine_assets','production_parts','capacity_models','cost_models',
    'part_profitability_runs','machine_roi_snapshots'])
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t);
  end loop;
end $$;

-- Seed machine assets (implementation.md §14 candidates); ROI stays needs_review.
insert into public.machine_assets (name, machine_type) values
  ('Awea','freze'),('Arion','torna'),('Sister','torna'),('Doosan','torna');
