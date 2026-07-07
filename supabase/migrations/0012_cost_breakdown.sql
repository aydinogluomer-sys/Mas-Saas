-- Phase 9A: surface the cost sheets' detail that the MVP only summed.
-- cost_breakdown_lines = the ~17-line fixed-cost ledger + general/personnel blocks that
-- roll up to cost_models.total_fixed_cost. akon_* = the customer's current TL/dk price,
-- so the UI can show margin (price − break-even). ANALYTICS ONLY; source-traceable.

alter table public.cost_models
  add column akon_freze_tl_per_min numeric(14,4),
  add column akon_torna_tl_per_min numeric(14,4);

create table public.cost_breakdown_lines (
  id uuid primary key default gen_random_uuid(),
  cost_model_id uuid not null references public.cost_models(id) on delete cascade,
  block text not null,             -- 'fixed' | 'general' | 'personnel' | 'standard' ...
  label text not null,
  amount numeric(14,2),            -- null stays null (unknown ≠ 0)
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),
  created_at timestamptz not null default now(),
  unique(cost_model_id, block, label)
);
create index cost_breakdown_lines_model_idx on public.cost_breakdown_lines(cost_model_id);

-- RLS + policy (0007 ran before this table existed; single-operator model)
alter table public.cost_breakdown_lines enable row level security;
create policy cost_breakdown_lines_authenticated_all on public.cost_breakdown_lines
  for all to authenticated using (true) with check (true);
