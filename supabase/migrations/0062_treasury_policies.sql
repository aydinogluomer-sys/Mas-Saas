-- Faz 26 — treasury policy thresholds, as DATA.
--
-- The plan asks for a "configurable cash-buffer policy threshold", and the operative word is
-- configurable. A minimum-cash floor buried in a TypeScript constant is a number only a developer
-- can change, which is the wrong owner for a treasury decision. This follows Faz 24A's
-- approval_rules precedent: the rule lives in a row, the engine reads it, and changing it is an
-- audited operator action rather than a deploy.
--
-- NO SECOND NUMBER IS INVENTED. public.settings already carries `negative_cash_threshold_try = 0`
-- — the floor Faz 4/5's projection already treats as "cash has gone negative". The seeded default
-- min-cash policy is therefore 0 and MUST equal that setting; phase26:verify asserts the equality,
-- the same way Faz 24A pinned amount_over_100k to critical_payment_threshold_try. Raising the
-- floor above zero is exactly what a buffer policy is for, and now it is a row edit.
--
-- NO STATUS COLUMN, DELIBERATELY. §17 rule 3 (every lifecycle entity needs a transition guard on
-- day one) is genuinely N/A here: a policy is active or it is not, and `is_active` is a boolean
-- with no intermediate state to constrain. This is the same reasoning recorded for
-- approval_rules in 0054 — stated rather than left as a silent omission, so a reviewer can see
-- the rule was considered and found not to apply.

create table if not exists public.treasury_policies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,

  -- Two kinds, and only two. A concentration limit is a different question (Faz 23 already
  -- scores counterparty concentration) and adding it here would create a second place to answer
  -- it.
  policy_kind text not null check (policy_kind in ('min_cash', 'buffer_days')),

  -- Which currency the floor is expressed in. Positions are never netted across currencies
  -- (see 0063), so a policy belongs to exactly one.
  currency text not null default 'TRY',

  -- NULL means the policy applies to EVERY account. A per-account floor is the exception, not
  -- the rule, so the general case needs no row-per-account bookkeeping.
  cash_account_id uuid references public.cash_accounts(id),

  threshold_amount numeric(14,2),
  threshold_days int,

  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Scope, enforced in BOTH directions so a threshold cannot be attached to a policy that does
  -- not read it, and a policy cannot exist without the threshold it needs. Faz 24A's
  -- approval_rules_threshold_scope is the pattern.
  constraint treasury_policies_kind_scope check (
    (policy_kind = 'min_cash')    = (threshold_amount is not null)
    and (policy_kind = 'buffer_days') = (threshold_days is not null)
  ),

  -- A negative floor is not a floor. ZERO IS VALID and means "do not go below zero", which is
  -- precisely the seeded default — 0 and NULL are different statements (CLAUDE.md).
  constraint treasury_policies_amount_sign check (threshold_amount is null or threshold_amount >= 0),
  constraint treasury_policies_days_sign check (threshold_days is null or threshold_days > 0)
);

comment on table public.treasury_policies is
  'Faz 26: configurable treasury thresholds. min_cash = absolute floor; buffer_days = days of '
  'average outflow to hold. Read by the liquidity views; never hardcoded in application code.';
comment on column public.treasury_policies.cash_account_id is
  'NULL = applies to every account. A per-account floor is the exception.';

drop trigger if exists treasury_policies_updated_at on public.treasury_policies;
create trigger treasury_policies_updated_at before update on public.treasury_policies
  for each row execute function public.set_updated_at();

create index if not exists treasury_policies_active_idx
  on public.treasury_policies (policy_kind, is_active);

-- One active policy of a given kind per (currency, account). Without this a second, contradictory
-- floor could be added and the views would silently pick whichever the planner returned first.
create unique index if not exists treasury_policies_active_unique
  on public.treasury_policies (policy_kind, currency, cash_account_id)
  nulls not distinct
  where is_active;

-- ── seeds ──────────────────────────────────────────────────────────────────────────────
-- The min-cash default is 0 to match settings.negative_cash_threshold_try exactly.
-- buffer_days ships INACTIVE: holding N days of outflow is a real policy, but switching it on
-- changes what the dashboard calls a shortfall, and that is an operator's decision to make
-- deliberately rather than something a migration turns on for them.
insert into public.treasury_policies (code, description, policy_kind, currency, threshold_amount, is_active)
values ('min_cash_try', 'TRY asgari kasa tabanı', 'min_cash', 'TRY', 0.00, true)
on conflict (code) do nothing;

insert into public.treasury_policies (code, description, policy_kind, currency, threshold_days, is_active)
values ('buffer_days_try', 'TRY nakit tamponu (gün cinsinden ortalama gider)', 'buffer_days', 'TRY', 30, false)
on conflict (code) do nothing;

-- ── RLS: Faz 24B tier model, `config` access class ────────────────────────────────────
-- Same class as public.settings: every tier reads it (the floor explains why a screen is showing
-- a warning), only admin writes it. Deliberately NOT manager-writable — a manager who could
-- lower the floor governing their own liquidity alerts would be turning off the alarm rather
-- than answering it, which is the same argument 0058 used to keep approval_rules admin-only.
alter table public.treasury_policies enable row level security;

drop policy if exists treasury_policies_select_all_tiers on public.treasury_policies;
create policy treasury_policies_select_all_tiers on public.treasury_policies
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists treasury_policies_insert_admin on public.treasury_policies;
create policy treasury_policies_insert_admin on public.treasury_policies
  for insert to mas_radar_admin with check (true);

drop policy if exists treasury_policies_update_admin on public.treasury_policies;
create policy treasury_policies_update_admin on public.treasury_policies
  for update to mas_radar_admin using (true) with check (true);

drop policy if exists treasury_policies_delete_admin on public.treasury_policies;
create policy treasury_policies_delete_admin on public.treasury_policies
  for delete to mas_radar_admin using (true);
