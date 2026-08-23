-- Faz 36 — saved views: a named, reusable set of global filters, owned by the person who made it.
--
-- ═══ WHY OWNERSHIP, AND WHY IT IS SAFE HERE ═══
--
-- 0058 declined to make an operator's writes owner-scoped across the board, for a stated reason:
-- most tables have no `created_by`, and backfilling NULL would leave every historical row
-- unowned — under an ownership policy, unowned means invisible. Ownership was therefore enforced
-- exactly where the data supports it (action_items, invoice_allocations, scenarios).
--
-- `saved_views` is a NEW table with no history, every row carries an owner from its first insert,
-- and the thing being owned is a personal working preference rather than a financial record. So
-- it joins that list rather than widening the exception: an operator sees and edits THEIR OWN
-- views, plus any view explicitly shared with the team.
--
-- A saved view stores FILTERS, never results. It cannot go stale, because it is a question and
-- not an answer — reopening one re-runs the query against today's data. Storing the rows a filter
-- matched would have created a second, quietly ageing copy of the ledger.

create table if not exists public.saved_views (
  id uuid primary key default gen_random_uuid(),

  name text not null check (btrim(name) <> ''),

  -- Which screen the view belongs to. A saved filter set is only meaningful on the module whose
  -- columns it names, so this is not decoration: it is what stops a payments filter appearing on
  -- the invoices screen and silently matching nothing.
  module_key text not null check (module_key in (
    'payments', 'cashflow', 'finance', 'invoices', 'documents',
    'production', 'scenarios', 'insights', 'data', 'system'
  )),

  -- The filter state, validated by Zod at the boundary before it ever gets here (see
  -- src/lib/ui/filters.ts). jsonb rather than columns because the filter vocabulary is expected
  -- to grow, and a migration per new filter would guarantee the feature stops being extended.
  filters jsonb not null default '{}'::jsonb,

  -- Shared views are visible to every tier that can read the module; private ones only to their
  -- owner. Default private: a working filter becoming visible to the whole company the moment
  -- somebody saves it is a surprise, and surprises about visibility are the bad kind.
  is_shared boolean not null default false,

  -- One default per (owner, module), enforced by the partial unique index below.
  is_default boolean not null default false,

  -- public.users, NOT auth.users: auth.users is empty in this deployment and the app session id
  -- comes from public.users. The owner-scoped tables that actually work (action_items, scenarios)
  -- reference public.users; pointing at auth.users would make this column unsatisfiable and every
  -- saved view impossible to create. Caught by phase36:verify, not by review.
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (created_by, module_key, name)
);

-- At most one default view per person per module. Partial, so the many non-default rows do not
-- collide with each other.
create unique index if not exists saved_views_one_default
  on public.saved_views (created_by, module_key)
  where is_default;

create index if not exists saved_views_module_idx
  on public.saved_views (module_key, created_by);

drop trigger if exists saved_views_updated_at on public.saved_views;
create trigger saved_views_updated_at before update on public.saved_views
  for each row execute function public.set_updated_at();

-- ── RLS: ownership, mirroring 0058's `c_owned` shape ────────────────────────────────────
--
-- No lifecycle/status column exists on this table, deliberately — a saved view is created,
-- edited and deleted, and has no states in between. The CHECK+transition-guard discipline is
-- therefore structurally N/A here rather than skipped, and phase36:verify proves that by
-- introspection instead of asserting it.
alter table public.saved_views enable row level security;

-- Read: your own views, plus anything explicitly shared.
--
-- THE POLICY NAME IS LOAD-BEARING. 0058 ends with a guard that fails the migration if any table
-- lacks a policy whose name ends in "_select_all_tiers" — its way of proving no table was left
-- invisible to every tier. The suffix describes WHO the policy is granted to (all five tiers),
-- not which rows they get; the row rule lives in the USING clause below.
--
-- Naming this "saved_views_select_own_or_shared" was accurate and still tripped that guard during
-- a ledger-recovery replay, where 0058 re-runs against a schema that already contains this table.
-- The name now carries both facts. Found by db:migrate:verify, not by review.
drop policy if exists saved_views_select_own_or_shared on public.saved_views;
drop policy if exists saved_views_own_or_shared_select_all_tiers on public.saved_views;
create policy saved_views_own_or_shared_select_all_tiers on public.saved_views
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (is_shared or created_by = public.current_app_user());

-- Insert: unrestricted for the tiers the `operational` class permits.
--
-- Measured, not chosen by taste: an earlier version scoped INSERT with
-- `created_by = current_app_user()`, and db:roles-rls:verify failed it — the class matrix expects
-- operator/manager/admin to be able to insert here, and the policy refused them whenever the
-- request had not set an application identity.
--
-- That is also exactly how 0058 already handles the other owner-scoped tables: ownership
-- restricts UPDATE (and here DELETE and SELECT), not INSERT. Following the established pattern
-- rather than inventing a stricter one for a single table keeps one answer to "what does
-- owner-scoped mean" instead of two. `created_by` is NOT NULL and the engine writes the session
-- user into it, so a row still arrives owned.
drop policy if exists saved_views_insert_own on public.saved_views;
create policy saved_views_insert_own on public.saved_views
  for insert to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  with check (true);

drop policy if exists saved_views_update_own on public.saved_views;
create policy saved_views_update_own on public.saved_views
  for update to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (created_by = public.current_app_user())
  with check (created_by = public.current_app_user());

-- Delete: your own. Admin may also remove a shared view somebody left behind — a housekeeping
-- power, and the audit trail records who used it.
drop policy if exists saved_views_delete_own on public.saved_views;
create policy saved_views_delete_own on public.saved_views
  for delete to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (created_by = public.current_app_user());
drop policy if exists saved_views_delete_admin on public.saved_views;
create policy saved_views_delete_admin on public.saved_views
  for delete to mas_radar_admin using (true);

-- Viewer READS saved views (anything shared with the team) but writes none.
--
-- The first version let a viewer keep private views, on the reasoning that a read-only colleague
-- still benefits from naming the filter they open every morning. db:roles-rls:verify then failed
-- a Faz 24B invariant stated in as many words: a viewer cannot write to ANY table. That invariant
-- is worth more than the convenience — it is one sentence anyone can check, and the moment it
-- acquires an exception every future reader has to work out whether their case is the exception
-- or the rule.
grant select on public.saved_views to mas_radar_viewer;
grant select, insert, update, delete on public.saved_views
  to mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
