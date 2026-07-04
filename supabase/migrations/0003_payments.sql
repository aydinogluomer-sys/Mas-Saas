-- Payment radar model (implementation.md §10 + idempotency unique + month-normalization check)

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category_id uuid references public.categories(id),
  provider_party_id uuid references public.parties(id),
  owner_party_id uuid references public.parties(id),
  cash_account_id uuid references public.cash_accounts(id),

  recurrence_type text not null default 'monthly' check (recurrence_type in ('one_off','monthly','weekly','yearly','irregular')),
  due_day int check (due_day between 1 and 31),
  due_date date,

  default_amount numeric(14,2),
  currency text not null default 'TRY',
  amount_confidence text not null default 'known' check (amount_confidence in ('known','unknown','estimated','variable')),

  direction text not null default 'outflow' check (direction in ('inflow','outflow','transfer','unknown')),
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  status text not null default 'active' check (status in ('active','paused','archived')),

  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),
  source_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_due_rule check (
    (recurrence_type = 'monthly' and due_day is not null)
    or (recurrence_type <> 'monthly')
  )
);
create trigger payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

create table public.payment_instances (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.payments(id) on delete set null,
  instance_month date not null,
  due_date date not null,
  due_day int generated always as (extract(day from due_date)::int) stored,

  amount numeric(14,2),
  currency text not null default 'TRY',
  amount_status text not null default 'known' check (amount_status in ('known','missing','estimated','variable')),
  direction text not null default 'outflow' check (direction in ('inflow','outflow','transfer','unknown')),

  status text not null default 'unpaid' check (status in ('planned','unpaid','partial','paid','late','cancelled','unknown')),
  paid_amount numeric(14,2),
  paid_at timestamptz,
  paid_from_account_id uuid references public.cash_accounts(id),

  risk_level text not null default 'none' check (risk_level in ('none','low','medium','high','critical')),
  risk_reasons text[] not null default '{}',

  note text,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint paid_requires_paid_at check (
    status <> 'paid' or paid_at is not null
  ),
  constraint instance_month_normalized check (
    instance_month = date_trunc('month', instance_month)::date
  )
);
-- Idempotent monthly generation (risk-register + mas-payment-risk-engine skill):
create unique index payment_instances_idempotency
  on public.payment_instances(payment_id, instance_month)
  where payment_id is not null;
create index payment_instances_due_idx on public.payment_instances(due_date);
create index payment_instances_status_idx on public.payment_instances(status);
create trigger payment_instances_updated_at before update on public.payment_instances
  for each row execute function public.set_updated_at();
