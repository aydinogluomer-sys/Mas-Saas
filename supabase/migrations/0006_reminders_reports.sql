-- Reminders + reports (Phase-1 designed tables; rules per mas-reminder-engine skill,
-- duplicate prevention per docs/risk-register.md: unique delivery key)

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  target_kind text not null check (target_kind in ('payment_instance','check','loan_installment')),
  offset_days int not null, -- 7,3,1,0 before due; -1 = overdue check
  channel text not null default 'telegram' check (channel in ('telegram','email')),
  min_amount numeric(14,2), -- optional threshold filter
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(target_kind, offset_days, channel)
);

create table public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  entity_table text not null,
  entity_id uuid not null,
  scheduled_for date not null,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  sent_at timestamptz,
  error text,
  payload jsonb,
  created_at timestamptz not null default now(),
  unique(reminder_id, entity_table, entity_id, scheduled_for)
);
create index reminder_deliveries_sched_idx on public.reminder_deliveries(scheduled_for, status);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('daily','weekly','monthly','strategic','data_quality')),
  period_start date not null,
  period_end date not null,
  body_md text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
