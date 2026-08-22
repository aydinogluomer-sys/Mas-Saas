-- Faz 27 — what secures the debt, and what the lender requires in return.
--
-- Both tables hang off EITHER a loan or a facility, and the link is two nullable FKs with a CHECK
-- that exactly one is set — not a polymorphic (table, id) pair. Approvals used polymorphism in
-- 0053 because its subjects were seven unrelated tables and no FK could span them. Here there are
-- exactly two targets and both are real tables, so real foreign keys are available, and a real FK
-- is worth more than the symmetry: it stops a covenant pointing at a loan that no longer exists.

create table if not exists public.collateral_records (
  id uuid primary key default gen_random_uuid(),

  loan_id uuid references public.loans(id),
  facility_id uuid references public.credit_facilities(id),

  collateral_type text not null
    check (collateral_type in (
      'mortgage', 'pledge', 'vehicle_pledge', 'personal_guarantee', 'corporate_guarantee',
      'check', 'promissory_note', 'cash_blockage', 'other'
    )),

  description text,
  -- NULL means UNVALUED, not worthless (CLAUDE.md). An unvalued mortgage is a real security whose
  -- figure nobody has produced yet, and recording it as 0,00 would understate coverage in every
  -- view that sums this column.
  value_amount numeric(14,2) check (value_amount is null or value_amount >= 0),
  currency text not null default 'TRY',
  valuation_date date,
  -- Who values it matters: a bank's own appraisal and an owner's estimate are not the same claim.
  valuation_source text
    check (valuation_source is null or valuation_source in ('bank', 'independent', 'internal', 'unknown')),

  owner_party_id uuid references public.parties(id),
  released_at timestamptz,
  release_reason text,

  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Exactly one subject. Neither, or both, is a record nobody can act on.
  constraint collateral_records_one_subject check (
    (loan_id is not null)::int + (facility_id is not null)::int = 1
  ),
  -- Release fields travel together, in both directions (the 0026 pattern).
  constraint collateral_records_release_consistency check (
    (released_at is not null) = (release_reason is not null)
  )
);

comment on column public.collateral_records.value_amount is
  'NULL = not valued yet, NOT worthless. Zero is an explicit "no value".';

drop trigger if exists collateral_records_updated_at on public.collateral_records;
create trigger collateral_records_updated_at before update on public.collateral_records
  for each row execute function public.set_updated_at();

create index if not exists collateral_records_loan_idx on public.collateral_records (loan_id)
  where loan_id is not null;
create index if not exists collateral_records_facility_idx on public.collateral_records (facility_id)
  where facility_id is not null;

-- ── covenants ──────────────────────────────────────────────────────────────────────────
--
-- A covenant record is the CLAUSE, not the measurement. That separation is why the lifecycle
-- below has only three states: a clause is in force, waived by the lender, or gone. Whether we
-- are currently complying is a TEST RESULT, and test results are data columns
-- (last_test_date / last_test_result), not lifecycle states — otherwise a routine monthly test
-- failing and passing again would drag the clause through a status machine it does not own.
create table if not exists public.covenant_records (
  id uuid primary key default gen_random_uuid(),

  loan_id uuid references public.loans(id),
  facility_id uuid references public.credit_facilities(id),

  covenant_type text not null
    check (covenant_type in (
      'current_ratio', 'debt_to_equity', 'ebitda_multiple', 'min_equity',
      'max_debt', 'dscr', 'other'
    )),
  description text not null,

  -- The clause as an inequality: <metric> <operator> <threshold>.
  comparison text not null check (comparison in ('gte', 'lte', 'gt', 'lt')),
  threshold_value numeric(18,6) not null,

  test_frequency text not null default 'quarterly'
    check (test_frequency in ('monthly', 'quarterly', 'semiannual', 'annual', 'on_demand')),

  status text not null default 'active'
    check (status in ('active', 'waived', 'closed')),

  -- Measurement, deliberately NOT lifecycle.
  last_test_date date,
  last_test_value numeric(18,6),
  last_test_result text
    check (last_test_result is null or last_test_result in ('compliant', 'breached', 'not_tested')),

  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint covenant_records_one_subject check (
    (loan_id is not null)::int + (facility_id is not null)::int = 1
  ),
  -- A recorded test must say when, what and with what verdict — a date with no value, or a
  -- verdict with no date, is a half-written measurement nobody can audit.
  constraint covenant_records_test_consistency check (
    (last_test_date is not null) = (last_test_result is not null)
  )
);

-- ── covenant status guard, same migration as the CHECK ─────────────────────────────────
--   active -> waived   the lender formally waived the clause
--   active -> closed   the clause no longer applies (debt repaid, contract amended)
--   waived -> active   THE WAIVER EXPIRED. Waivers are usually granted for a period, and without
--                      this the clause could never come back into force — it would look
--                      permanently waived, which is exactly the covenant a treasury forgets.
--   waived -> closed   waived and then retired
-- `closed` is terminal: a retired clause coming back is a new clause with a new contract.
create or replace function public.covenant_records_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('active', 'waived'),
    ('active', 'closed'),
    ('waived', 'active'),
    ('waived', 'closed')
  ) then
    raise exception 'Geçersiz kovenant durum geçişi: % → % (kovenant %)', old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists covenant_records_transition_guard on public.covenant_records;
create trigger covenant_records_transition_guard
  before update of status on public.covenant_records
  for each row execute function public.covenant_records_guard_transition();

drop trigger if exists covenant_records_updated_at on public.covenant_records;
create trigger covenant_records_updated_at before update on public.covenant_records
  for each row execute function public.set_updated_at();

create index if not exists covenant_records_status_idx
  on public.covenant_records (status, last_test_result);

-- ── RLS: Faz 24B `operational` class for both ─────────────────────────────────────────
alter table public.collateral_records enable row level security;
alter table public.covenant_records enable row level security;

drop policy if exists collateral_records_select_all_tiers on public.collateral_records;
create policy collateral_records_select_all_tiers on public.collateral_records
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists collateral_records_insert_enter on public.collateral_records;
create policy collateral_records_insert_enter on public.collateral_records
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists collateral_records_update_enter on public.collateral_records;
create policy collateral_records_update_enter on public.collateral_records
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists collateral_records_delete_manage on public.collateral_records;
create policy collateral_records_delete_manage on public.collateral_records
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

drop policy if exists covenant_records_select_all_tiers on public.covenant_records;
create policy covenant_records_select_all_tiers on public.covenant_records
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists covenant_records_insert_enter on public.covenant_records;
create policy covenant_records_insert_enter on public.covenant_records
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists covenant_records_update_enter on public.covenant_records;
create policy covenant_records_update_enter on public.covenant_records
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists covenant_records_delete_manage on public.covenant_records;
create policy covenant_records_delete_manage on public.covenant_records
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);
