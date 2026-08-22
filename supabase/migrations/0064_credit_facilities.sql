-- Faz 27 — credit facilities: permission to borrow, which is not the same thing as a loan.
--
-- WHY THIS IS NOT A COLUMN ON public.loans
--
-- Measured before designing. `loans` is a FIXED-SCHEDULE instrument: it has principal,
-- term_months, installment_count, first_payment_date and a single installment_amount, and 0005
-- materialises the whole amortisation into loan_installments the moment it is created. Every one
-- of those columns assumes the money has already been received and the repayment dates are known.
--
-- A facility assumes none of that. It is a LIMIT — a bank's standing permission to draw — and its
-- defining states are "how much may we take" and "how much have we taken". A facility can sit at
-- zero utilisation for a year and still be the most important number on a treasury screen,
-- because it is the liquidity that exists without being borrowed yet. Modelling it as a loan
-- would force a fake principal and a fake instalment schedule for money nobody has drawn.
--
-- The two do meet: drawing on a revolving facility often CREATES a loan with its own schedule.
-- That relationship is a nullable FK from the drawdown, not a merged table.
--
-- WHAT IS DELIBERATELY NOT STORED: `drawn`, `available`. Both are sums over the drawdown rows and
-- both are exposed as VIEW columns in 0067. A stored utilisation figure is a second source of
-- truth that goes stale on the next drawdown and looks perfectly plausible while wrong — the same
-- reasoning Faz 19/22/23/26 recorded for their read models.

create table if not exists public.credit_facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  lender_party_id uuid references public.parties(id),

  -- The kinds a Turkish corporate treasury actually holds. `guarantee_letter` (teminat mektubu)
  -- and `letter_of_credit` are non-cash: they consume limit without ever producing cash, which is
  -- exactly why they must be tracked against the same ceiling.
  facility_type text not null default 'revolving'
    check (facility_type in (
      'revolving', 'overdraft', 'spot', 'guarantee_letter', 'letter_of_credit', 'other'
    )),

  -- The ceiling. NOT NULL: a facility without a limit is not a facility, it is a conversation.
  limit_amount numeric(14,2) not null check (limit_amount >= 0),
  currency text not null default 'TRY',

  -- Rates are stored at the Faz 17 rate scale (10 dp), never as float.
  interest_rate numeric(9,6),
  commission_rate numeric(9,6),

  start_date date,
  expiry_date date,
  review_date date,

  status text not null default 'active'
    check (status in ('active', 'suspended', 'expired', 'closed')),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An expiry before the start is a data-entry error, not an exotic facility.
  constraint credit_facilities_date_order check (
    start_date is null or expiry_date is null or expiry_date >= start_date
  )
);

comment on table public.credit_facilities is
  'Faz 27: a standing borrowing limit. Distinct from public.loans, which is a fixed-schedule '
  'instrument with a materialised amortisation. Utilisation is never stored — see 0067.';

-- ── status transition guard, in the SAME migration as the CHECK (0027's lesson) ────────
--
-- The eight permitted moves, and the reasoning for the ones that are easy to get wrong:
--
--   active    -> suspended   the bank froze it (covenant breach, review)
--   active    -> expired     the term ran out
--   active    -> closed      cancelled by either side
--   suspended -> active      the freeze was lifted
--   suspended -> expired     A SUSPENDED FACILITY STILL AGES. Leaving this out would strand every
--                            frozen facility as 'suspended' forever once its term passed.
--   suspended -> closed      never un-frozen, then cancelled
--   expired   -> active      RENEWAL. Banks renew annual limits routinely; without this the only
--                            way to record a renewal is a new row, which would silently detach
--                            the facility from its own drawdown history.
--   expired   -> closed      allowed to lapse for good
--
-- `closed` is terminal, and `expired -> suspended` is refused: freezing something that has already
-- lapsed is not a state anyone can act on.
create or replace function public.credit_facilities_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('active',    'suspended'),
    ('active',    'expired'),
    ('active',    'closed'),
    ('suspended', 'active'),
    ('suspended', 'expired'),
    ('suspended', 'closed'),
    ('expired',   'active'),
    ('expired',   'closed')
  ) then
    raise exception 'Geçersiz kredi limiti durum geçişi: % → % (limit %)', old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists credit_facilities_transition_guard on public.credit_facilities;
create trigger credit_facilities_transition_guard
  before update of status on public.credit_facilities
  for each row execute function public.credit_facilities_guard_transition();

drop trigger if exists credit_facilities_updated_at on public.credit_facilities;
create trigger credit_facilities_updated_at before update on public.credit_facilities
  for each row execute function public.set_updated_at();

create index if not exists credit_facilities_status_idx
  on public.credit_facilities (status, expiry_date);
create index if not exists credit_facilities_lender_idx
  on public.credit_facilities (lender_party_id);

-- ── drawdowns and repayments ───────────────────────────────────────────────────────────
--
-- One row per movement against the limit. Utilisation is the running sum, which is why the
-- movement is the record and the balance is not.
create table if not exists public.facility_drawdowns (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.credit_facilities(id),

  movement_type text not null
    check (movement_type in ('drawdown', 'repayment')),

  -- Always POSITIVE; the sign is carried by movement_type, not by the operator remembering to
  -- type a minus. `signed_amount` below derives it once so no consumer can get it backwards.
  amount numeric(14,2) not null check (amount > 0),
  signed_amount numeric(14,2) generated always as (
    case when movement_type = 'drawdown' then amount else -amount end
  ) stored,

  currency text not null default 'TRY',
  movement_date date not null,

  -- A drawdown on a revolving line often becomes a scheduled loan. Nullable FK rather than a
  -- merged table: the relationship exists, the concepts do not.
  loan_id uuid references public.loans(id),

  reference_no text,
  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);

comment on column public.facility_drawdowns.signed_amount is
  'Generated from movement_type. Stored so utilisation is a plain sum and no caller can invert '
  'the sign by hand.';

create index if not exists facility_drawdowns_facility_idx
  on public.facility_drawdowns (facility_id, movement_date);

-- ── RLS: Faz 24B tier model, `operational` class ───────────────────────────────────────
-- Same class as loans/loan_installments: an operator records a drawdown, a manager corrects or
-- removes one. Chosen from 0058's own reasoning, not by reinstating a blanket policy.
alter table public.credit_facilities enable row level security;
alter table public.facility_drawdowns enable row level security;

drop policy if exists credit_facilities_select_all_tiers on public.credit_facilities;
create policy credit_facilities_select_all_tiers on public.credit_facilities
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (true);
drop policy if exists credit_facilities_insert_enter on public.credit_facilities;
create policy credit_facilities_insert_enter on public.credit_facilities
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);
drop policy if exists credit_facilities_update_enter on public.credit_facilities;
create policy credit_facilities_update_enter on public.credit_facilities
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists credit_facilities_delete_manage on public.credit_facilities;
create policy credit_facilities_delete_manage on public.credit_facilities
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

drop policy if exists facility_drawdowns_select_all_tiers on public.facility_drawdowns;
create policy facility_drawdowns_select_all_tiers on public.facility_drawdowns
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (true);
drop policy if exists facility_drawdowns_insert_enter on public.facility_drawdowns;
create policy facility_drawdowns_insert_enter on public.facility_drawdowns
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);
drop policy if exists facility_drawdowns_update_enter on public.facility_drawdowns;
create policy facility_drawdowns_update_enter on public.facility_drawdowns
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists facility_drawdowns_delete_manage on public.facility_drawdowns;
create policy facility_drawdowns_delete_manage on public.facility_drawdowns
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);
