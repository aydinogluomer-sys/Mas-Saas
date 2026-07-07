-- Phase 14B: external assumptions / outside-view inputs.
-- These rows are planning context only. They never mutate source-of-truth finance
-- tables; scenario/report/AI layers may read approved rows with source/date.

create table public.external_assumptions (
  id uuid primary key default gen_random_uuid(),
  assumption_type text not null check (assumption_type in (
    'interest_rate','fx_rate','inflation_rate','personnel_cost','energy_cost','loan_rate','other'
  )),
  label text not null,
  period_start date,
  period_end date,
  value_numeric numeric(18,6) not null,
  unit text not null,
  currency text not null default 'TRY',
  source_kind text not null default 'manual' check (source_kind in ('manual','imported','internet')),
  source_name text not null,
  source_url text,
  source_date date not null,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end is null or period_start is null or period_end >= period_start),
  check (source_kind <> 'internet' or review_status <> 'approved' or reviewed_at is not null)
);

create trigger external_assumptions_updated_at before update on public.external_assumptions
  for each row execute function public.set_updated_at();

create index external_assumptions_type_idx on public.external_assumptions(assumption_type, review_status, source_date desc);
create index external_assumptions_review_idx on public.external_assumptions(review_status, source_kind, created_at desc);

alter table public.external_assumptions enable row level security;
create policy external_assumptions_authenticated_all on public.external_assumptions
  for all to authenticated using (true) with check (true);
