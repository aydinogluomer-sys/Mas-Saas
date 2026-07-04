-- Checks + loans (implementation.md §12-13, verbatim + signed-amount consistency + indexes)

create table public.checks (
  id uuid primary key default gen_random_uuid(),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  maturity_date date not null,
  serial_no text,
  payee_party_id uuid references public.parties(id), -- kime
  payer_party_id uuid references public.parties(id), -- kimden
  bank_party_id uuid references public.parties(id),
  account_id uuid references public.cash_accounts(id),

  amount numeric(14,2),
  signed_amount numeric(14,2),
  direction text not null default 'outflow' check (direction in ('inflow','outflow','unknown')),
  status text not null default 'planned' check (status in ('planned','cleared','bounced','cancelled','unknown')),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- calculation-rules.md: amount = |signed_amount| when both present
  constraint check_amount_sign_consistency check (
    amount is null or signed_amount is null or amount = abs(signed_amount)
  )
);
create index checks_maturity_idx on public.checks(maturity_date);
create trigger checks_updated_at before update on public.checks
  for each row execute function public.set_updated_at();

create table public.check_events (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.checks(id) on delete cascade,
  event_type text not null check (event_type in ('created','reminded','cleared','bounced','cancelled','note')),
  event_at timestamptz not null default now(),
  event_note text,
  created_by uuid references auth.users(id)
);

create table public.loans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  lender_party_id uuid references public.parties(id),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),

  principal numeric(14,2) not null,
  term_months int,
  installment_count int,
  first_payment_date date,
  simple_interest_rate numeric(8,4),
  applied_interest_rate numeric(8,4),
  monthly_cost_rate numeric(8,4),
  annual_cost_rate numeric(8,4),
  bsmv_rate numeric(8,4),
  kkdf_rate numeric(8,4),
  installment_amount numeric(14,2),
  total_payment numeric(14,2),
  total_finance_cost numeric(14,2),

  status text not null default 'active' check (status in ('active','closed','planned','unknown')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger loans_updated_at before update on public.loans
  for each row execute function public.set_updated_at();

create table public.loan_installments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  installment_no int,
  due_date date not null,
  amount numeric(14,2) not null,
  principal_component numeric(14,2),
  interest_component numeric(14,2),
  tax_component numeric(14,2),
  status text not null default 'planned' check (status in ('planned','unpaid','partial','paid','late','cancelled')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique(loan_id, installment_no),
  constraint installment_paid_requires_paid_at check (
    status <> 'paid' or paid_at is not null
  )
);
create index loan_installments_due_idx on public.loan_installments(due_date);
