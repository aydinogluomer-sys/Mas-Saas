-- Faz 28 — rolling forecast: forecasts + forecast_lines.
--
-- ═══ WHY NEW TABLES RATHER THAN EXTENDING scenario_runs / scenario_run_lines ═══
--
-- The plan leaves both options open and asks for the reasoning. I introspected the existing
-- tables first, and the shape decides it:
--
--   scenario_run_lines is (month_start, baseline_income, scenario_income, baseline_expense,
--   scenario_expense, baseline_closing, scenario_closing, delta).
--
-- EVERY value column is a baseline/scenario PAIR. That table answers one question — "how do these
-- two worlds differ" — and answers it well. A rolling forecast is not a comparison of two worlds;
-- it is ONE projection that gets revised, classified by source, scored for confidence, and later
-- measured against what actually happened. Storing it there would leave half of every row
-- meaningless (which baseline does a forecast line have?) and require a discriminator column to
-- say "this run isn't really a what-if".
--
-- Three further mismatches, each concrete rather than aesthetic:
--
--   1. GRANULARITY. scenario_run_lines.month_start is strictly monthly. The 13-week cash forecast
--      this phase must deliver is WEEKLY. Writing week starts into a column named month_start
--      would be a lie that every later reader inherits.
--   2. LIFECYCLE. scenario_runs is archival — it carries archived_at/archive_reason and a triplet
--      consistency constraint, i.e. it is immutable OUTPUT of a computation. This phase requires a
--      version lifecycle (draft/approved/superseded) on forecast lines. Bolting versioning onto
--      scenario_runs would change the meaning of every existing scenario row.
--   3. IDENTITY. A scenario run is produced once and read; a forecast is maintained — revised
--      weekly, re-approved, and scored for accuracy after the fact.
--
-- WHAT IS REUSED RATHER THAN DUPLICATED: `forecasts.scenario_run_id` is a nullable FK, so a
-- forecast produced from a what-if run keeps the link to the machinery that generated it. The
-- scenario engine is extended by being connected, not by being overloaded.

create table if not exists public.forecasts (
  id uuid primary key default gen_random_uuid(),
  name text not null,

  -- The named horizons. 'weekly_13' is the 13-week cash forecast the plan asks for by name;
  -- the monthly horizons let the same table carry the rolling annual view.
  horizon_kind text not null default 'weekly_13'
    check (horizon_kind in ('weekly_13', 'monthly_12', 'monthly_24')),

  -- Where the horizon starts. A rolling forecast is re-anchored each cycle, and the anchor is
  -- what makes two vintages of the same forecast comparable.
  anchor_date date not null,
  currency text not null default 'TRY',

  -- The reuse seam: set when this forecast was produced from a scenario run.
  scenario_run_id uuid references public.scenario_runs(id),

  notes text,
  is_active boolean not null default true,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (name, anchor_date)
);

create table if not exists public.forecast_lines (
  id uuid primary key default gen_random_uuid(),
  forecast_id uuid not null references public.forecasts(id) on delete cascade,

  -- Explicit start AND end, because weeks and months live in the same table and a period is not
  -- inferable from its start alone.
  period_start date not null,
  period_end date not null,

  direction text not null check (direction in ('inflow', 'outflow')),
  amount numeric(14,2) not null,
  currency text not null default 'TRY',

  -- ── the source classification the plan specifies ─────────────────────────────────────
  -- Ordered by how much the number can be relied on:
  --   contracted  a signed obligation exists (an instalment, an issued invoice)
  --   scheduled   recurring and dated, but not individually contracted yet
  --   historical  derived from what this business actually did before
  --   manual      a person typed it
  --   estimated   a rule produced it from something indirect
  -- This is a property of WHERE THE NUMBER CAME FROM, never of how much someone likes it, which
  -- is why it is a column and not a comment.
  source_kind text not null default 'estimated'
    check (source_kind in ('contracted', 'scheduled', 'historical', 'manual', 'estimated')),

  -- 0..1. NULL means nobody scored it — different from 0, which asserts "certainly wrong".
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  -- ── forecast versus actual ───────────────────────────────────────────────────────────
  -- Filled in after the period closes. NULL means the period has not been measured yet, NOT that
  -- nothing happened — 0070's accuracy view counts only measured lines for exactly this reason.
  actual_amount numeric(14,2),
  actual_recorded_at timestamptz,

  cost_center_id uuid references public.cost_centers(id),
  department_id uuid references public.departments(id),
  project_id uuid references public.projects(id),
  category_id uuid references public.categories(id),

  version_no int not null default 1 check (version_no > 0),
  version_status text not null default 'draft'
    check (version_status in ('draft', 'approved', 'superseded')),

  approved_at timestamptz,
  approved_by uuid references public.users(id),
  superseded_at timestamptz,
  superseded_by_line_id uuid references public.forecast_lines(id),

  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint forecast_lines_period_order check (period_end >= period_start),
  constraint forecast_lines_actual_consistency check (
    (actual_amount is not null) = (actual_recorded_at is not null)
  ),
  -- Same exhaustive form as budget_lines, for the same reason.
  constraint forecast_lines_version_consistency check (
    (version_status = 'draft'      and approved_at is null     and superseded_at is null)
    or (version_status = 'approved'   and approved_at is not null and superseded_at is null)
    or (version_status = 'superseded' and superseded_at is not null)
  ),
  constraint forecast_lines_approval_actor check (
    (approved_at is not null) = (approved_by is not null)
  )
);

-- ── version transition guard — IDENTICAL allow-list to budget_lines ────────────────────
-- draft->approved, draft->superseded, approved->superseded. `approved -> draft` refused: a
-- forecast line that was approved and then quietly reopened would change accuracy history after
-- the fact, which is precisely the number this phase exists to be able to trust.
create or replace function public.forecast_lines_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.version_status = old.version_status then
    return new;
  end if;

  if (old.version_status, new.version_status) not in (
    ('draft',    'approved'),
    ('draft',    'superseded'),
    ('approved', 'superseded')
  ) then
    raise exception 'Geçersiz tahmin satırı versiyon geçişi: % → % (satır %)',
      old.version_status, new.version_status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists forecast_lines_version_guard on public.forecast_lines;
create trigger forecast_lines_version_guard
  before update of version_status on public.forecast_lines
  for each row execute function public.forecast_lines_guard_transition();

drop trigger if exists forecast_lines_updated_at on public.forecast_lines;
create trigger forecast_lines_updated_at before update on public.forecast_lines
  for each row execute function public.set_updated_at();

drop trigger if exists forecasts_updated_at on public.forecasts;
create trigger forecasts_updated_at before update on public.forecasts
  for each row execute function public.set_updated_at();

create index if not exists forecast_lines_forecast_idx
  on public.forecast_lines (forecast_id, period_start, version_status);
create index if not exists forecast_lines_measured_idx
  on public.forecast_lines (period_start) where actual_amount is not null;

create unique index if not exists forecast_lines_live_unique
  on public.forecast_lines
     (forecast_id, period_start, direction, source_kind,
      cost_center_id, department_id, project_id, category_id)
  nulls not distinct
  where version_status <> 'superseded';

-- ── RLS: Faz 24B `operational` class ───────────────────────────────────────────────────
alter table public.forecasts enable row level security;
alter table public.forecast_lines enable row level security;

drop policy if exists forecasts_select_all_tiers on public.forecasts;
create policy forecasts_select_all_tiers on public.forecasts
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists forecasts_insert_enter on public.forecasts;
create policy forecasts_insert_enter on public.forecasts
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists forecasts_update_enter on public.forecasts;
create policy forecasts_update_enter on public.forecasts
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists forecasts_delete_manage on public.forecasts;
create policy forecasts_delete_manage on public.forecasts
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

drop policy if exists forecast_lines_select_all_tiers on public.forecast_lines;
create policy forecast_lines_select_all_tiers on public.forecast_lines
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists forecast_lines_insert_enter on public.forecast_lines;
create policy forecast_lines_insert_enter on public.forecast_lines
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists forecast_lines_update_enter on public.forecast_lines;
create policy forecast_lines_update_enter on public.forecast_lines
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists forecast_lines_delete_manage on public.forecast_lines;
create policy forecast_lines_delete_manage on public.forecast_lines
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);
