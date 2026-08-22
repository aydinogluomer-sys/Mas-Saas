-- Faz 19 — organizational dimensions, DELIBERATELY MINIMAL.
--
-- Scope is set by implementation.md §3 open question #9, answered there as "minimal reference
-- data, respecting CLAUDE.md's 'do not rewrite the accounting package' boundary". So these are
-- code/name lookup tables and nothing more: no allocation logic, no order lifecycle, no line
-- items, no amounts. The columns that would carry those things are absent rather than present
-- and unused, because an empty column invites a second, contradictory source of truth.
--
-- WHAT IS NOT HERE, AND WHY IT MATTERS: no `status` enum on any of these five tables. An
-- `orders` table with a status column would immediately fall under implementation.md §17
-- rule 3 (a complete status-transition guard, in this same migration, covering every value the
-- CHECK allows). That rule was written because 0027 shipped incomplete allow-lists and left
-- 7/7 checks and 48/48 loan installments frozen in 'planned' for eight migrations, with the
-- loans KPI silently reporting 0 paid the whole time. Rather than half-design a lifecycle now
-- and guard it badly, this phase ships no lifecycle at all. `is_active` is a boolean; it has
-- no transitions to constrain. When order lifecycle is genuinely needed, it arrives with its
-- guard in the same migration.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

-- Shared shape: a stable human code, a display name, an activation flag, free-text notes.
-- `code` is the natural key operators actually use on paper; `id` stays a uuid so future FKs
-- do not depend on someone never renaming a code.

create table if not exists public.cost_centers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  -- Self-reference for an org tree. RESTRICT, not CASCADE: deleting a parent department must
  -- not silently delete its children.
  parent_department_id uuid references public.departments(id) on delete restrict,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  -- Optional counterparty link (the customer a project is run for). NO ACTION mirrors every
  -- other FK into parties: a party that is referenced cannot be deleted out from under it.
  party_id uuid references public.parties(id),
  cost_center_id uuid references public.cost_centers(id),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  unit text check (unit is null or btrim(unit) <> ''),
  -- production_parts already models the machining side (part codes, torna/freze minutes) and
  -- is NOT superseded by this table: that one is process-oriented, this one is commercial
  -- reference data. Kept unlinked for now rather than guessing at a mapping the source
  -- workbooks do not currently express.
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  -- Whose order. Optional, because a reference row may be entered before the counterparty is
  -- resolved — and resolving it must stay an explicit act (see 0039's note on the
  -- never-silently-create-parties rule).
  party_id uuid references public.parties(id),
  project_id uuid references public.projects(id),
  order_date date,
  -- No status, no amount, no lines. See the header.
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_party_idx on public.projects (party_id) where party_id is not null;
create index if not exists orders_party_idx on public.orders (party_id) where party_id is not null;
create index if not exists orders_project_idx on public.orders (project_id) where project_id is not null;
create index if not exists departments_parent_idx on public.departments (parent_department_id) where parent_department_id is not null;

-- updated_at triggers + RLS, one loop instead of five copy-pasted blocks. The policy name
-- follows 0007's `<table>_authenticated_all` convention so the existing RLS audit query in
-- scripts/db/assertions.sql keeps recognising them.
do $$
declare t text;
begin
  foreach t in array array['cost_centers', 'departments', 'projects', 'products', 'orders'] loop
    execute format('drop trigger if exists %I_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t, t);
    execute format('alter table public.%I enable row level security', t);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = t || '_authenticated_all'
    ) then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        t || '_authenticated_all', t);
    end if;
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
