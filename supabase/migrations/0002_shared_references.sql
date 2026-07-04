-- Shared references + settings + audit (implementation.md §9; settings/audit designed in Phase 1, documented in docs/database-schema.md)

create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  party_type text not null default 'unknown' check (party_type in (
    'company','person','bank','provider','customer','vendor','internal_owner','unknown'
  )),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(normalized_name, party_type)
);
create trigger parties_updated_at before update on public.parties
  for each row execute function public.set_updated_at();

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  domain text not null default 'payment' check (domain in ('payment','cashflow','check','loan','cost','capacity','tax','other')),
  sort_order int not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  provider_party_id uuid references public.parties(id),
  account_type text not null default 'unknown' check (account_type in ('cash','bank_account','credit_card','loan','check_account','other','unknown')),
  currency text not null default 'TRY',
  opening_balance numeric(14,2),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor uuid references auth.users(id),
  action text not null,
  entity_table text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs(entity_table, entity_id);
