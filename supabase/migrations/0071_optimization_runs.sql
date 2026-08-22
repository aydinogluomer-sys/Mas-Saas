-- Faz 29 — deterministic optimisation runs and the recommendations they produce.
--
-- ═══ A RECOMMENDATION IS A PROPOSAL, NEVER A MUTATION ═══
--
-- This is the load-bearing rule of the whole phase. CLAUDE.md forbids anything automated from
-- marking payments paid, altering due dates, or changing amounts. So the optimiser NEVER writes to
-- payment_instances, invoices, checks, loans or cashflow_months. It reads them, and it writes rows
-- HERE describing what a person might choose to do. Acting on a recommendation stays a human
-- action, and Faz 24A's approval entity is what gates it.
--
-- That also preserves the Faz 8/13 invariant unchanged: the baseline is read, never written, and
-- everything this phase produces is an overlay in its own tables. phase29:verify re-proves that
-- against this NEW run type by snapshotting every column of a baseline scenario_run and every
-- cashflow_months row, executing the optimiser, and comparing byte for byte.
--
-- ═══ NO LIFECYCLE COLUMN HERE, DELIBERATELY ═══
--
-- The obvious instinct is a status column (draft/approved/applied). It is the wrong instinct: the
-- approval state of an optimisation run belongs to `approvals`, which Faz 24A built precisely so
-- that no third bespoke review variant would exist. Migration 0072 adds 'optimization_runs' to its
-- polymorphic subject_table so this connects to that entity rather than forking it.
--
-- A status column here would be a SECOND source of truth about whether a recommendation set was
-- approved, and the two would eventually disagree — which is the exact failure Faz 24A spent a
-- phase removing. §17 rule 3 does not apply because there is no lifecycle to guard; the gate
-- asserts the absence structurally rather than leaving it as a claim in a comment.

create table if not exists public.optimization_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null,

  -- What the run was asked to improve. Every objective maps to an explicit, named rule set in
  -- src/lib/optimization/rules.ts — there is no solver library and no learned weighting.
  objective text not null
    check (objective in ('min_financing_cost', 'max_liquidity_buffer', 'min_late_payment')),

  anchor_date date not null,
  horizon_days int not null default 90 check (horizon_days between 1 and 365),
  currency text not null default 'TRY',

  -- The constraints the run was given, stored verbatim so a recommendation can always be
  -- re-derived from the inputs that produced it. Faz 8's scenario_runs.assumptions precedent.
  constraints jsonb,

  -- Optional link to the what-if run this optimisation was explored against. Same seam Faz 28
  -- used: the scenario engine is connected, never overloaded.
  scenario_run_id uuid references public.scenario_runs(id),

  -- Deterministic output fingerprint. Two runs over identical inputs must produce identical
  -- recommendations, and this records the digest that proves it — the gate re-runs the optimiser
  -- and compares.
  result_digest text,

  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);

comment on table public.optimization_runs is
  'Faz 29: a deterministic optimisation pass. Produces PROPOSALS only — it never writes to any '
  'financial record. Approval state lives in public.approvals (subject_table=optimization_runs), '
  'not in a status column here.';

create table if not exists public.optimization_recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.optimization_runs(id) on delete cascade,

  -- Worst-first ordering is decided by the engine and stored, so a screen never has to re-rank
  -- and cannot disagree with the run that produced it.
  rank int not null check (rank > 0),

  action_kind text not null
    check (action_kind in (
      'defer_payment', 'advance_payment', 'draw_facility', 'repay_facility', 'hold_buffer'
    )),

  -- What the action is about. Deliberately the same (table, id) shape approvals uses — these
  -- point at rows in several unrelated tables and no single FK could span them.
  subject_table text
    check (subject_table is null or subject_table in (
      'payment_instances', 'invoices', 'checks', 'loan_installments', 'credit_facilities'
    )),
  subject_id uuid,
  subject_label text,

  -- The dates involved. current_date is what the schedule says today; proposed_date is the
  -- suggestion. Both nullable because a buffer recommendation moves nothing.
  current_date_value date,
  proposed_date date,

  amount numeric(14,2),
  currency text not null default 'TRY',

  -- Expected cash effect over the horizon, signed: positive improves the position.
  expected_effect numeric(14,2),

  -- ── the named rules that produced this row ───────────────────────────────────────────
  -- Faz 23's convention: a verdict always travels with the rule names behind it. An
  -- optimisation suggestion a treasurer cannot interrogate is one they will (rightly) ignore.
  rationale_codes text[] not null default '{}',
  rationale_note text,

  -- 0..1, and NULL means unscored rather than "certainly wrong".
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  created_at timestamptz not null default now(),

  -- A proposal that moves a date must say both ends of the move; one without the other is not
  -- actionable and cannot be reviewed.
  constraint optimization_recommendations_date_pair check (
    (action_kind in ('defer_payment', 'advance_payment'))
      = (current_date_value is not null and proposed_date is not null)
  ),
  -- Deferring means later, advancing means earlier. Getting this backwards would silently invert
  -- every suggestion while every number still looked plausible.
  constraint optimization_recommendations_direction check (
    action_kind <> 'defer_payment' or proposed_date > current_date_value
  ),
  constraint optimization_recommendations_advance_direction check (
    action_kind <> 'advance_payment' or proposed_date < current_date_value
  ),
  -- A subject id without its table (or the reverse) points nowhere.
  constraint optimization_recommendations_subject_pair check (
    (subject_table is null) = (subject_id is null)
  ),
  -- Every recommendation must name at least one rule. An unexplained suggestion is exactly what
  -- this column exists to prevent.
  --
  -- coalesce() is load-bearing and was added after the gate caught its absence: array_length() on
  -- an EMPTY array returns NULL, not 0, so `array_length(x,1) >= 1` evaluates to NULL for '{}' —
  -- and a CHECK that evaluates to NULL PASSES. The constraint therefore accepted exactly the rows
  -- it existed to reject, while reading as though it worked.
  constraint optimization_recommendations_has_rationale check (
    coalesce(array_length(rationale_codes, 1), 0) >= 1
  ),

  unique (run_id, rank)
);

create index if not exists optimization_recommendations_run_idx
  on public.optimization_recommendations (run_id, rank);
create index if not exists optimization_runs_anchor_idx
  on public.optimization_runs (anchor_date desc);

-- ── RLS: Faz 24B tier model, `operational` class ───────────────────────────────────────
-- An operator runs the optimiser and reads what it suggests; a manager clears runs. Acting on a
-- recommendation is a separate, approved action against the underlying record, governed by that
-- record's own policies — nothing here grants any power over a payment.
alter table public.optimization_runs enable row level security;
alter table public.optimization_recommendations enable row level security;

drop policy if exists optimization_runs_select_all_tiers on public.optimization_runs;
create policy optimization_runs_select_all_tiers on public.optimization_runs
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists optimization_runs_insert_enter on public.optimization_runs;
create policy optimization_runs_insert_enter on public.optimization_runs
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists optimization_runs_update_enter on public.optimization_runs;
create policy optimization_runs_update_enter on public.optimization_runs
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists optimization_runs_delete_manage on public.optimization_runs;
create policy optimization_runs_delete_manage on public.optimization_runs
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

drop policy if exists optimization_recommendations_select_all_tiers on public.optimization_recommendations;
create policy optimization_recommendations_select_all_tiers on public.optimization_recommendations
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists optimization_recommendations_insert_enter on public.optimization_recommendations;
create policy optimization_recommendations_insert_enter on public.optimization_recommendations
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists optimization_recommendations_update_enter on public.optimization_recommendations;
create policy optimization_recommendations_update_enter on public.optimization_recommendations
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists optimization_recommendations_delete_manage on public.optimization_recommendations;
create policy optimization_recommendations_delete_manage on public.optimization_recommendations
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

-- Repair for databases created before the coalesce() fix above. `create table if not exists`
-- cannot alter an existing constraint, so the corrected form is (re)applied explicitly here;
-- both statements are safe to re-run.
alter table public.optimization_recommendations
  drop constraint if exists optimization_recommendations_has_rationale;
alter table public.optimization_recommendations
  add constraint optimization_recommendations_has_rationale
  check (coalesce(array_length(rationale_codes, 1), 0) >= 1);
