-- Phase 9D: machine-minute utilization + finance-cost allocation snapshots.
-- ANALYTICS ONLY. These tables do not change loans, cashflow, payments, checks, or
-- accounting truth; they explain how capacity minutes and financing cost pressure
-- would distribute across production resources.

create table public.machine_minute_allocations (
  id uuid primary key default gen_random_uuid(),
  capacity_model_id uuid not null references public.capacity_models(id) on delete cascade,
  operation_type text not null check (operation_type in ('torna','freze','total')),
  machine_count numeric(10,2),
  demand_minutes numeric(14,2),
  available_minutes numeric(14,2),
  utilization_rate numeric(12,6),
  idle_minutes numeric(14,2),
  over_capacity_minutes numeric(14,2),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  notes text,
  created_at timestamptz not null default now(),
  unique(capacity_model_id, operation_type)
);
create index machine_minute_allocations_capacity_idx
  on public.machine_minute_allocations(capacity_model_id);

create table public.finance_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  capacity_model_id uuid references public.capacity_models(id) on delete cascade,
  operation_type text not null check (operation_type in ('torna','freze','total')),
  allocation_basis text not null default 'demand_minutes'
    check (allocation_basis in ('demand_minutes','machine_count','manual')),
  machine_count numeric(10,2),
  demand_minutes numeric(14,2),
  allocation_ratio numeric(12,6),
  total_finance_cost numeric(14,2),
  allocated_finance_cost numeric(14,2),
  finance_cost_per_minute numeric(14,6),
  finance_cost_per_machine numeric(14,2),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  notes text,
  created_at timestamptz not null default now(),
  unique(loan_id, capacity_model_id, operation_type, allocation_basis)
);
create index finance_cost_allocations_loan_idx
  on public.finance_cost_allocations(loan_id);
create index finance_cost_allocations_capacity_idx
  on public.finance_cost_allocations(capacity_model_id);

alter table public.machine_minute_allocations enable row level security;
create policy machine_minute_allocations_authenticated_all on public.machine_minute_allocations
  for all to authenticated using (true) with check (true);

alter table public.finance_cost_allocations enable row level security;
create policy finance_cost_allocations_authenticated_all on public.finance_cost_allocations
  for all to authenticated using (true) with check (true);
