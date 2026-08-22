-- Faz 28 — budgets and budget lines.
--
-- Dimensions come from Faz 19's tables (cost_centers, departments, projects) plus the existing
-- categories, and the real column names were introspected before this was written: each of those
-- is (id, code, name, is_active), so the line below carries plain nullable FKs rather than a
-- code string that could drift from the dimension it names.
--
-- A MEASURED LIMIT, RECORDED RATHER THAN PAPERED OVER: of those dimensions, only cost_center and
-- project are actually attached to any transaction table (invoices / invoice_lines), and
-- category only to payments. NOTHING in this schema links a department to a transaction. So a
-- department budget can be WRITTEN here and compared against nothing — 0070's variance view
-- reports actuals for the dimensions that exist and leaves department actuals NULL rather than
-- inventing an allocation rule. Adding one would be fabricating the answer to "which department
-- spent this", which no row in this database records.

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  fiscal_year int not null check (fiscal_year between 2000 and 2100),

  -- How the lines are laid out. 'annual' budgets carry one line per dimension for the year;
  -- 'monthly' carry twelve. Both are real practice and the difference matters for variance
  -- timing, so it is recorded rather than inferred from how many lines happen to exist.
  period_kind text not null default 'monthly'
    check (period_kind in ('annual', 'monthly')),

  currency text not null default 'TRY',
  notes text,
  is_active boolean not null default true,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (name, fiscal_year)
);

-- NO LIFECYCLE COLUMN ON THE HEADER, deliberately. The plan puts the version lifecycle on the
-- LINES (draft/approved/superseded), which is where budgeting revisions actually happen: a
-- finance team re-cuts individual lines and supersedes them one at a time, it does not flip a
-- whole year between draft and approved atomically. Giving the header its own status would create
-- a second lifecycle that could disagree with its own lines — an approved budget full of draft
-- rows. §17 rule 3 is satisfied on the table that carries the versioning.
comment on table public.budgets is
  'Faz 28: a budget container. The version lifecycle lives on budget_lines, not here — revisions '
  'happen line by line, and a second header lifecycle could disagree with its own rows.';

create table if not exists public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.budgets(id) on delete cascade,

  -- Month start for monthly budgets; 1 January for annual ones. One column rather than
  -- (year, month) so every period comparison is a plain date comparison.
  period_start date not null,

  direction text not null check (direction in ('income', 'expense')),

  -- NOT NULL: a budget line without a figure is not a budget, it is an intention. This is the
  -- one place in this schema where a null amount is NOT "unknown but valid" — the whole purpose
  -- of the row is to state a number to be measured against.
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'TRY',

  -- Dimensions, all optional: a line may be company-wide, or scoped to any combination.
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
  superseded_by_line_id uuid references public.budget_lines(id),

  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Exhaustive rather than a pile of implications, so every state names exactly which timestamps
  -- it may carry. A superseded line MAY have been approved first or may have been superseded
  -- straight out of draft, which is why approved_at is unconstrained only in that branch.
  constraint budget_lines_version_consistency check (
    (version_status = 'draft'      and approved_at is null     and superseded_at is null)
    or (version_status = 'approved'   and approved_at is not null and superseded_at is null)
    or (version_status = 'superseded' and superseded_at is not null)
  ),
  constraint budget_lines_approval_actor check (
    (approved_at is not null) = (approved_by is not null)
  )
);

-- ── version transition guard, in the SAME migration as the CHECK (0027's lesson) ───────
--
-- Three permitted moves out of the six ordered pairs:
--   draft    -> approved     the line was signed off
--   draft    -> superseded   replaced before anyone approved it
--   approved -> superseded   a new version replaces it
--
-- `approved -> draft` is REFUSED, and that is the whole point of the guard: reopening an approved
-- budget line would silently rewrite a figure someone signed off, and every variance report built
-- on it would change underneath its readers with no record that it had. A revision is a NEW line
-- that supersedes this one, which is also what `superseded_by_line_id` exists to record.
-- `superseded` is terminal in both directions for the same reason.
create or replace function public.budget_lines_guard_transition()
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
    raise exception 'Geçersiz bütçe satırı versiyon geçişi: % → % (satır %)',
      old.version_status, new.version_status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists budget_lines_version_guard on public.budget_lines;
create trigger budget_lines_version_guard
  before update of version_status on public.budget_lines
  for each row execute function public.budget_lines_guard_transition();

drop trigger if exists budget_lines_updated_at on public.budget_lines;
create trigger budget_lines_updated_at before update on public.budget_lines
  for each row execute function public.set_updated_at();

create index if not exists budget_lines_budget_idx
  on public.budget_lines (budget_id, period_start, version_status);
create index if not exists budget_lines_dimension_idx
  on public.budget_lines (cost_center_id, project_id, department_id, category_id);

-- One LIVE line per budget/period/dimension/direction. Superseded rows are excluded so history
-- accumulates freely, and NULLS NOT DISTINCT matters because most lines leave most dimensions
-- null — under the default rule the index would protect nothing for the commonest shape.
create unique index if not exists budget_lines_live_unique
  on public.budget_lines
     (budget_id, period_start, direction, cost_center_id, department_id, project_id, category_id)
  nulls not distinct
  where version_status <> 'superseded';

-- ── RLS: Faz 24B tier model, `operational` class ───────────────────────────────────────
-- Same class as the other financial records: an operator drafts lines, a manager corrects or
-- removes them. Approving a line is an UPDATE, so it sits with the same tiers — the maker-checker
-- question for budgets belongs to Faz 24A's approval entity, not to a second mechanism here.
alter table public.budgets enable row level security;
alter table public.budget_lines enable row level security;

drop policy if exists budgets_select_all_tiers on public.budgets;
create policy budgets_select_all_tiers on public.budgets
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists budgets_insert_enter on public.budgets;
create policy budgets_insert_enter on public.budgets
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists budgets_update_enter on public.budgets;
create policy budgets_update_enter on public.budgets
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists budgets_delete_manage on public.budgets;
create policy budgets_delete_manage on public.budgets
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

drop policy if exists budget_lines_select_all_tiers on public.budget_lines;
create policy budget_lines_select_all_tiers on public.budget_lines
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists budget_lines_insert_enter on public.budget_lines;
create policy budget_lines_insert_enter on public.budget_lines
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists budget_lines_update_enter on public.budget_lines;
create policy budget_lines_update_enter on public.budget_lines
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists budget_lines_delete_manage on public.budget_lines;
create policy budget_lines_delete_manage on public.budget_lines
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);
