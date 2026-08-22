-- Faz 24B — replacing every blanket RLS policy with tier-aware ones.
--
-- Before this migration 58 tables carried one policy each: `for all to authenticated
-- using(true) with check(true)`. That was a deliberate single-operator design (CLAUDE.md), and
-- it is what the plan asked to replace. Every one of those 58 is dropped here — none is left
-- silently in place, and the four tables that keep a deliberately broad rule say why in a
-- comment at the point of definition.
--
-- HOW THIS IS ORGANISED, AND WHY BY CLASS
--
-- Sixty-one tables times five tiers times four commands is over a thousand decisions, and a
-- migration that spelled each one out would be unreviewable — the place where a wrong cell
-- hides. Instead every table is assigned to ONE access class, the classes are few enough to
-- reason about, and the policies are generated from that assignment. The list below is the
-- whole security model: if a table is not in it, the DO block at the end raises rather than
-- letting it keep an unexamined policy or none at all.
--
-- THE CLASSES
--
--   reference   Master and configuration data — parties, IBANs, cost centres, machines.
--               Everyone reads it; only manager/admin change it. Read access is deliberately
--               wide because nearly every screen joins against these.
--   operational Day-to-day financial records — payments, invoices, checks, bank movements.
--               This is where finance_operator does its work: insert and update, never delete.
--   evidence    Append-only trails — audit_logs, check_events, reversals, approval_steps.
--               INSERT and SELECT only, for EVERY tier including admin. There is deliberately
--               no UPDATE or DELETE policy: the 0022-pattern triggers already refuse those,
--               and RLS agreeing with the trigger means the refusal does not depend on which
--               of the two layers a future change touches.
--   derived     Model output — snapshots, reports, scenario runs. Written by the runs an
--               operator triggers, so it follows operational rather than reference.
--   config      public.settings. Read by everyone (thresholds drive nearly every screen),
--               written by admin only — this is where the critical payment threshold lives.
--
-- Handled outside the loop because their rules are not command-shaped: approvals (row-level
-- maker-checker), approval_rules (who may weaken a control), users/sessions (the auth pattern
-- from Faz 15, which must not change), schema_migrations (owner only, no policy at all).
--
-- ROW LEVEL, HONESTLY SCOPED
--
-- The plan suggests finance_operator edit "records it entered". That needs an owner column,
-- and only 8 of 61 tables have one — measured, not assumed. Adding `created_by` to the other
-- 53 and backfilling NULL would make every historical row unowned, which under an ownership
-- policy means no operator could edit any pre-existing record: an availability regression far
-- worse than the tightening is worth, and a silent rewrite of financial history's authorship.
-- So ownership is enforced exactly where the data supports it (action_items,
-- invoice_allocations, scenarios, and approvals' maker-checker rule) and the remaining tables
-- are enforced at command granularity, which is still a real and tested restriction.

-- ── 1) drop every blanket policy ───────────────────────────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public' and policyname like '%\_authenticated\_all'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ── 2) generate the tier policies ──────────────────────────────────────────────────────
do $$
declare
  -- The five tiers, widest read audience first. Written once so a tier can never be spelled
  -- differently in two policies.
  c_all_tiers  text := 'mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin';
  c_enter      text := 'mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin';
  c_record     text := 'mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin';
  c_manage     text := 'mas_radar_finance_manager, mas_radar_admin';
  c_admin      text := 'mas_radar_admin';

  -- Tables whose UPDATE by an operator is restricted to rows that operator created. These are
  -- exactly the tables that already carry created_by AND that an operator may write at all.
  c_owned      text[] := array['action_items', 'invoice_allocations', 'scenarios'];

  v_table text;
  v_class text;
  v_name  text;
  v_pairs text[][] := array[
    -- reference (16)
    ['categories','reference'], ['parties','reference'], ['counterparty_profiles','reference'],
    ['ibans','reference'], ['cash_accounts','reference'], ['bank_accounts','reference'],
    ['cost_centers','reference'], ['departments','reference'], ['projects','reference'],
    ['products','reference'], ['orders','reference'], ['capacity_models','reference'],
    ['cost_models','reference'], ['machine_assets','reference'], ['production_parts','reference'],
    ['external_assumptions','reference'],
    -- operational (21)
    ['payments','operational'], ['payment_instances','operational'], ['checks','operational'],
    ['loans','operational'], ['loan_installments','operational'], ['invoices','operational'],
    ['invoice_lines','operational'], ['invoice_allocations','operational'],
    ['bank_transactions','operational'], ['bank_transaction_match_candidates','operational'],
    ['cashflow_months','operational'], ['cashflow_lines','operational'],
    ['finance_cost_allocations','operational'], ['cost_breakdown_lines','operational'],
    ['machine_minute_allocations','operational'], ['reminders','operational'],
    ['action_items','operational'], ['mapping_reviews','operational'],
    ['source_workbooks','operational'], ['source_sheets','operational'], ['import_rows','operational'],
    -- evidence (7)
    ['audit_logs','evidence'], ['check_events','evidence'], ['iban_change_events','evidence'],
    ['invoice_reversals','evidence'], ['approval_steps','evidence'], ['source_cells','evidence'],
    ['reminder_deliveries','evidence'],
    -- derived (11)
    ['metric_snapshots','derived'], ['cashflow_snapshots','derived'],
    ['ai_response_snapshots','derived'], ['reports','derived'], ['scenarios','derived'],
    ['scenario_runs','derived'], ['scenario_run_lines','derived'],
    ['scenario_assumptions','derived'], ['scenario_comparisons','derived'],
    ['machine_roi_snapshots','derived'], ['part_profitability_runs','derived'],
    -- config (1)
    ['settings','config']
  ];
  i int;
begin
  for i in 1 .. array_length(v_pairs, 1) loop
    v_table := v_pairs[i][1];
    v_class := v_pairs[i][2];

    -- Idempotent by construction: EVERY name this migration might create for this table is
    -- dropped first, regardless of which class branch runs below. Dropping per-branch was the
    -- obvious way to write this and it was wrong — two names (_update_manage, _delete_manage)
    -- are produced by more than one branch, so a per-branch drop covered only the first and a
    -- replay (LEDGER_EMPTY_RECOVERY) would have failed on "policy already exists". Dropping the
    -- full set is both shorter and immune to that whole class of mistake.
    foreach v_name in array array[
      '_select_all_tiers', '_insert_manage', '_update_manage', '_delete_manage',
      '_insert_enter', '_update_own', '_update_enter', '_insert_record',
      '_insert_admin', '_update_admin', '_delete_admin'
    ] loop
      execute format('drop policy if exists %I on public.%I', v_table || v_name, v_table);
    end loop;

    -- Every class is readable by every tier. A finance dashboard whose viewer cannot read is
    -- not a dashboard, and nothing in this schema is secret FROM an authenticated colleague —
    -- the control being enforced is over WRITES.
    execute format(
      'create policy %I on public.%I for select to %s using (true)',
      v_table || '_select_all_tiers', v_table, c_all_tiers);

    if v_class = 'reference' then
      execute format('create policy %I on public.%I for insert to %s with check (true)',
        v_table || '_insert_manage', v_table, c_manage);
      execute format('create policy %I on public.%I for update to %s using (true) with check (true)',
        v_table || '_update_manage', v_table, c_manage);
      execute format('create policy %I on public.%I for delete to %s using (true)',
        v_table || '_delete_manage', v_table, c_manage);

    elsif v_class in ('operational', 'derived') then
      execute format('create policy %I on public.%I for insert to %s with check (true)',
        v_table || '_insert_enter', v_table, c_enter);

      if v_table = any (c_owned) then
        -- Row level: the operator tier may only revise what it created. Manager/admin keep the
        -- unrestricted rule, because someone must be able to correct a record whose author has
        -- left. current_app_user() is NULL on an unswitched connection, and `=` against NULL is
        -- NULL, so an unset context matches no row rather than every row.
        execute format(
          'create policy %I on public.%I for update to mas_radar_finance_operator '
          'using (created_by = public.current_app_user()) '
          'with check (created_by = public.current_app_user())',
          v_table || '_update_own', v_table);
        execute format('create policy %I on public.%I for update to %s using (true) with check (true)',
          v_table || '_update_manage', v_table, c_manage);
      else
        execute format('create policy %I on public.%I for update to %s using (true) with check (true)',
          v_table || '_update_enter', v_table, c_enter);
      end if;

      execute format('create policy %I on public.%I for delete to %s using (true)',
        v_table || '_delete_manage', v_table, c_manage);

    elsif v_class = 'evidence' then
      -- INSERT only. No UPDATE/DELETE policy is created for ANY tier, admin included.
      execute format('create policy %I on public.%I for insert to %s with check (true)',
        v_table || '_insert_record', v_table, c_record);

    elsif v_class = 'config' then
      execute format('create policy %I on public.%I for insert to %s with check (true)',
        v_table || '_insert_admin', v_table, c_admin);
      execute format('create policy %I on public.%I for update to %s using (true) with check (true)',
        v_table || '_update_admin', v_table, c_admin);
      execute format('create policy %I on public.%I for delete to %s using (true)',
        v_table || '_delete_admin', v_table, c_admin);

    else
      raise exception 'Faz 24B: % tablosu için bilinmeyen erişim sınıfı %', v_table, v_class;
    end if;
  end loop;
end $$;

-- ── 3) approvals — the row-level maker-checker rule ────────────────────────────────────
-- Faz 24A put maker-checker in a CHECK constraint. This adds the same rule as a policy, one
-- layer down: a constraint states what a valid row looks like, a policy states who may reach
-- the row at all. An approver who cannot see their own request as updatable never gets far
-- enough to be refused by the constraint.
drop policy if exists approvals_select_all_tiers on public.approvals;
create policy approvals_select_all_tiers on public.approvals
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (true);

-- Requesting an approval is data entry, so the operator tier may do it.
drop policy if exists approvals_insert_enter on public.approvals;
create policy approvals_insert_enter on public.approvals
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);

-- Deciding is the approver's job. The row-level clause is the maker-checker rule: a row whose
-- requested_by is the acting user is not updatable BY that user. NULL requested_by (the legacy
-- bridge's anonymous history, Faz 24A) stays updatable — `is distinct from` is true against
-- NULL, which is the intended reading: an unattributed request has no maker to collide with.
drop policy if exists approvals_decide on public.approvals;
create policy approvals_decide on public.approvals
  for update to mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
  using (requested_by is distinct from public.current_app_user())
  with check (requested_by is distinct from public.current_app_user());

-- No DELETE policy for any tier. An approval is the record that a control was exercised;
-- deleting one would erase the evidence that it happened.

-- ── 4) approval_rules — who may weaken a control ───────────────────────────────────────
-- Read by everyone (screens explain WHY something needs approval), changed by admin only.
-- Deliberately NOT manager: a manager who could lower the threshold that governs their own
-- approvals would be the whole maker-checker design undone by a configuration screen.
drop policy if exists approval_rules_select_all_tiers on public.approval_rules;
create policy approval_rules_select_all_tiers on public.approval_rules
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (true);
drop policy if exists approval_rules_write_admin on public.approval_rules;
create policy approval_rules_write_admin on public.approval_rules
  for all to mas_radar_admin using (true) with check (true);

-- ── 5) users / sessions — Faz 15's pattern, extended, not replaced ─────────────────────
-- users_deny_all / sessions_deny_all (0031) and users_app_runtime / sessions_app_runtime
-- (0035) are LEFT EXACTLY AS THEY ARE. The app_runtime pair targets `mas_radar_app` itself and
-- is what makes login possible: the session lookup happens BEFORE any tier is known, so it
-- necessarily runs on an unswitched connection.
--
-- What must be added is the other half of that request. Once the runtime has switched into a
-- tier, current_user is no longer mas_radar_app, so app_runtime stops matching — and every
-- later requireSession() in the same request would find no readable user row. These policies
-- restore exactly that much and no more: a switched connection may read ITS OWN user and
-- session row, by id. Not the table — the row.
drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (id = public.current_app_user());

drop policy if exists sessions_self_read on public.sessions;
create policy sessions_self_read on public.sessions
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  using (user_id = public.current_app_user());

-- Administering accounts stays with admin, and stays a WRITE the tier does explicitly.
drop policy if exists users_admin_write on public.users;
create policy users_admin_write on public.users
  for all to mas_radar_admin using (true) with check (true);

-- ── 6) schema_migrations — unchanged, and deliberately policy-free ─────────────────────
-- RLS on, no policy, privileges revoked (0020/0035). The ledger belongs to the owner
-- connection alone. Named here so the completeness assertion below does not flag it as an
-- oversight: it is the one table whose correct policy count is zero.

-- ── 7) completeness — no table may leave this migration unexamined ─────────────────────
-- The failure this defends against is a table added later (or missed today) silently keeping
-- no policy and therefore being invisible to every tier, which presents as an empty screen
-- rather than an error. Cheaper to fail the migration.
do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname <> 'schema_migrations'
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = c.relname
        and p.policyname like '%\_select\_all\_tiers'
    )
    and not exists (
      -- users/sessions read through their own self-read policies, named differently on purpose.
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = c.relname
        and p.policyname in ('users_self_read', 'sessions_self_read')
    );

  if v_missing is not null then
    raise exception 'Faz 24B: şu tablolar rol-farkında bir SELECT politikası almadı: %', v_missing;
  end if;
end $$;

-- Nothing may still be running on the old blanket rule.
do $$
declare
  v_left int;
begin
  select count(*) into v_left from pg_policies
  where schemaname = 'public' and policyname like '%\_authenticated\_all';
  if v_left > 0 then
    raise exception 'Faz 24B: % adet blanket politika hâlâ duruyor', v_left;
  end if;
end $$;
