-- Faz 30 — cost allocation rules, as DATA.
--
-- The plan asks for allocation rules over Faz 19's dimensions (cost_centers / departments /
-- projects). Following the precedent set by approval_rules (0054) and treasury_policies (0062):
-- the rule lives in a row, the views read it, and changing how overhead is spread is an audited
-- operator action rather than a redeploy. An allocation basis buried in a SQL view is a number
-- only a developer can change, which is the wrong owner for a costing decision.
--
-- NO LIFECYCLE COLUMN, and §17 rule 3 is genuinely N/A here — asserted structurally by
-- phase30:verify rather than merely claimed in this comment, the same way Faz 26 and Faz 28 did
-- it. A rule is active or it is not; `is_active` is a boolean with no intermediate state for a
-- transition guard to protect. There is no draft/approved/superseded story because an allocation
-- rule is configuration, not a versioned financial artifact.

create table if not exists public.cost_allocation_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,

  -- The five kinds the plan names. `common` is shared overhead with no natural home; the other
  -- four each have a driver that actually exists in this schema.
  cost_kind text not null
    check (cost_kind in ('common', 'machine', 'personnel', 'energy', 'project')),

  -- HOW the cost is spread. Every basis names a driver this database can actually measure —
  -- machine_minutes comes from machine_minute_allocations, revenue_share from invoices. A basis
  -- whose driver did not exist would be a rule that silently allocated nothing.
  allocation_basis text not null
    check (allocation_basis in (
      'machine_minutes', 'revenue_share', 'direct_cost', 'equal_split', 'fixed_percent'
    )),

  -- Where the cost lands. All nullable: a rule may target one dimension or apply company-wide.
  cost_center_id uuid references public.cost_centers(id),
  department_id uuid references public.departments(id),
  project_id uuid references public.projects(id),

  -- Only meaningful for 'fixed_percent', and the CHECK below enforces that in BOTH directions so
  -- a percentage cannot be attached to a rule that does not read it, and a fixed_percent rule
  -- cannot exist without one. Stored at RATE_DP scale: 0.125 is 12,5%.
  fixed_percent numeric(9,6),

  is_active boolean not null default true,
  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cost_allocation_rules_percent_scope check (
    (allocation_basis = 'fixed_percent') = (fixed_percent is not null)
  ),
  -- A share outside 0..1 is not a share. Zero is valid and means "allocate nothing here", which
  -- is a different statement from an unset percentage (CLAUDE.md).
  constraint cost_allocation_rules_percent_range check (
    fixed_percent is null or (fixed_percent >= 0 and fixed_percent <= 1)
  )
);

comment on table public.cost_allocation_rules is
  'Faz 30: how overhead is spread across cost centres / departments / projects. Configuration, '
  'read by the profitability views — never hardcoded in a view or in application code.';

drop trigger if exists cost_allocation_rules_updated_at on public.cost_allocation_rules;
create trigger cost_allocation_rules_updated_at before update on public.cost_allocation_rules
  for each row execute function public.set_updated_at();

create index if not exists cost_allocation_rules_active_idx
  on public.cost_allocation_rules (cost_kind, is_active);

-- One ACTIVE rule per (kind, target). Without this a second, contradictory rule could be added
-- and the views would silently use whichever the planner returned first — the same hazard
-- treasury_policies guards against. NULLS NOT DISTINCT because most rules leave most dimensions
-- null, and under the default rule the index would protect nothing for the commonest shape.
create unique index if not exists cost_allocation_rules_active_unique
  on public.cost_allocation_rules
     (cost_kind, cost_center_id, department_id, project_id)
  nulls not distinct
  where is_active;

-- ── seeds ──────────────────────────────────────────────────────────────────────────────
-- Machine cost follows machine minutes, which is the driver production/engine.ts already uses
-- for part costing — the same basis, so a machine-hour cost cannot mean two different things in
-- two places. Common overhead ships on revenue_share as the least surprising default, and
-- personnel/energy ship INACTIVE because spreading them changes every margin on the screen and
-- that is an operator's decision to make deliberately, not one a migration makes for them.
insert into public.cost_allocation_rules (code, description, cost_kind, allocation_basis, is_active)
values
  ('machine_by_minutes', 'Makine maliyeti — makine dakikalarına göre', 'machine', 'machine_minutes', true),
  ('common_by_revenue',  'Ortak giderler — ciro payına göre',          'common',  'revenue_share',   true),
  ('personnel_by_revenue', 'Personel gideri — ciro payına göre',       'personnel', 'revenue_share', false),
  ('energy_by_minutes',  'Enerji gideri — makine dakikalarına göre',   'energy',  'machine_minutes', false)
on conflict (code) do nothing;

-- ── RLS: Faz 24B tier model, `config` access class ────────────────────────────────────
-- Same class as settings and treasury_policies: every tier reads it (the basis explains why a
-- margin looks the way it does), only admin changes it. Deliberately not manager-writable — a
-- manager who could re-base allocation would be able to move cost off their own cost centre and
-- onto someone else's without anyone seeing a financial record change.
alter table public.cost_allocation_rules enable row level security;

drop policy if exists cost_allocation_rules_select_all_tiers on public.cost_allocation_rules;
create policy cost_allocation_rules_select_all_tiers on public.cost_allocation_rules
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists cost_allocation_rules_insert_admin on public.cost_allocation_rules;
create policy cost_allocation_rules_insert_admin on public.cost_allocation_rules
  for insert to mas_radar_admin with check (true);
drop policy if exists cost_allocation_rules_update_admin on public.cost_allocation_rules;
create policy cost_allocation_rules_update_admin on public.cost_allocation_rules
  for update to mas_radar_admin using (true) with check (true);
drop policy if exists cost_allocation_rules_delete_admin on public.cost_allocation_rules;
create policy cost_allocation_rules_delete_admin on public.cost_allocation_rules
  for delete to mas_radar_admin using (true);
