-- Monthly cash-flow model (implementation.md §11, verbatim + month check + indexes)

create table public.cashflow_months (
  id uuid primary key default gen_random_uuid(),
  month_start date not null unique,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),

  opening_balance numeric(14,2), -- devir
  projected_income numeric(14,2), -- gelir
  projected_expense numeric(14,2), -- gider
  monthly_delta numeric(14,2), -- fark aylık
  closing_balance numeric(14,2), -- kasa
  confidence text not null default 'source_imported' check (confidence in ('source_imported','calculated','reviewed','estimated')),

  status text not null default 'draft' check (status in ('draft','review_needed','reviewed','locked')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cashflow_month_normalized check (
    month_start = date_trunc('month', month_start)::date
  )
);
create trigger cashflow_months_updated_at before update on public.cashflow_months
  for each row execute function public.set_updated_at();

create table public.cashflow_lines (
  id uuid primary key default gen_random_uuid(),
  cashflow_month_id uuid not null references public.cashflow_months(id) on delete cascade,
  source_row_id uuid references public.import_rows(id),

  line_type text not null check (line_type in (
    'customer_income','vendor_payment','bank_balance','credit_card','loan_payment','check_payment',
    'operational_cost','tax','transfer','adjustment','unknown'
  )),
  direction text not null default 'unknown' check (direction in ('inflow','outflow','balance','transfer','unknown')),
  party_id uuid references public.parties(id),
  account_id uuid references public.cash_accounts(id),
  label text not null,
  amount numeric(14,2),
  amount_status text not null default 'known' check (amount_status in ('known','missing','estimated','variable')),
  date_value date,
  notes text,
  created_at timestamptz not null default now()
);
create index cashflow_lines_month_idx on public.cashflow_lines(cashflow_month_id);
create index cashflow_lines_party_idx on public.cashflow_lines(party_id);

create table public.cashflow_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null default current_date,
  horizon_months int not null,
  total_projected_income numeric(14,2),
  total_projected_expense numeric(14,2),
  final_projected_balance numeric(14,2),
  first_negative_month date,
  worst_month date,
  worst_balance numeric(14,2),
  created_at timestamptz not null default now()
);
