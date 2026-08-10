-- Phase 1 verification assertions (implementation.md §20 Phase 1 + qa-gate invariants)
\set ON_ERROR_STOP on

do $$
declare n int; d int;
begin
  -- 1) seed sanity
  select count(*) into n from public.categories;
  if n <> 18 then raise exception 'FAIL seed categories: %', n; end if;
  select count(*) into n from public.reminders;
  if n <> 5 then raise exception 'FAIL seed reminders: %', n; end if;
  select count(*) into n from public.settings;
  if n < 7 then raise exception 'FAIL seed settings: %', n; end if;
  raise notice 'PASS seed counts';

  -- 2) monthly payment without due_day must fail (payment_due_rule)
  begin
    insert into public.payments (name, recurrence_type) values ('X','monthly');
    raise exception 'FAIL payment_due_rule did not fire';
  exception when check_violation then raise notice 'PASS payment_due_rule'; end;

end $$;
do $$
declare pid uuid; iid uuid; amt numeric; dd int; rls_missing int; pol_missing int; ledger_check int;
begin
  insert into public.payments (name, recurrence_type, due_day) values ('Test Kalem','monthly',31) returning id into pid;

  begin
    insert into public.payment_instances (payment_id, instance_month, due_date, status)
    values (pid, date '2027-02-01', date '2027-02-28', 'paid');
    raise exception 'FAIL paid_requires_paid_at did not fire';
  exception when check_violation then raise notice 'PASS paid_requires_paid_at'; end;

  -- 4) null amount stays null (not zero) + generated due_day + short-month date
  insert into public.payment_instances (payment_id, instance_month, due_date, amount, amount_status)
  values (pid, date '2027-02-01', date '2027-02-28', null, 'missing') returning id into iid;
  select amount, due_day into amt, dd from public.payment_instances where id = iid;
  if amt is not null then raise exception 'FAIL null amount mutated to %', amt; end if;
  if dd <> 28 then raise exception 'FAIL generated due_day: %', dd; end if;
  raise notice 'PASS null-amount-is-null + generated due_day(28)';

  -- 5) idempotency: duplicate (payment_id, instance_month) must fail
  begin
    insert into public.payment_instances (payment_id, instance_month, due_date)
    values (pid, date '2027-02-01', date '2027-02-28');
    raise exception 'FAIL instance idempotency unique did not fire';
  exception when unique_violation then raise notice 'PASS instance idempotency'; end;

  -- 6) instance_month must be first-of-month
  begin
    insert into public.payment_instances (payment_id, instance_month, due_date)
    values (pid, date '2027-03-05', date '2027-03-05');
    raise exception 'FAIL instance_month_normalized did not fire';
  exception when check_violation then raise notice 'PASS instance_month_normalized'; end;

  -- 7) checks signed-amount consistency
  begin
    insert into public.checks (maturity_date, amount, signed_amount) values (current_date, 100, -200);
    raise exception 'FAIL check_amount_sign_consistency did not fire';
  exception when check_violation then raise notice 'PASS check_amount_sign_consistency'; end;

  -- 8) reminder delivery duplicate key
  insert into public.reminder_deliveries (reminder_id, entity_table, entity_id, scheduled_for)
  select id, 'payment_instances', iid, date '2027-02-27' from public.reminders where offset_days = 1;
  begin
    insert into public.reminder_deliveries (reminder_id, entity_table, entity_id, scheduled_for)
    select id, 'payment_instances', iid, date '2027-02-27' from public.reminders where offset_days = 1;
    raise exception 'FAIL reminder duplicate key did not fire';
  exception when unique_violation then raise notice 'PASS reminder duplicate prevention'; end;

  -- 9) RLS enabled + policy present on every public table
  select count(*) into rls_missing from pg_tables t
    join pg_class c on c.relname = t.tablename
    join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
  where t.schemaname = 'public' and not c.relrowsecurity;
  if rls_missing > 0 then raise exception 'FAIL RLS missing on % tables', rls_missing; end if;
  -- schema_migrations is a deliberate exception (0020 + docs/database-schema.md): the ledger
  -- records real schema history and must NOT be writable by ordinary app sessions, so it gets
  -- RLS with zero policies and no grants instead of 0007's blanket authenticated-all policy.
  -- Exempting it here is paired with the positive assertions below, so the exception stays a
  -- verified invariant rather than a hole this check silently stops covering.
  select count(*) into pol_missing from pg_tables t
  where t.schemaname='public'
    and t.tablename <> 'schema_migrations'
    and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.tablename);
  if pol_missing > 0 then raise exception 'FAIL policy missing on % tables', pol_missing; end if;

  select count(*) into ledger_check from pg_policies
  where schemaname='public' and tablename='schema_migrations';
  if ledger_check <> 0 then raise exception 'FAIL schema_migrations must have no policy, found %', ledger_check; end if;
  select count(*) into ledger_check from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname='public'
  where c.relname='schema_migrations' and c.relrowsecurity;
  if ledger_check <> 1 then raise exception 'FAIL schema_migrations RLS not enabled'; end if;
  select count(*) into ledger_check from information_schema.role_table_grants
  where table_schema='public' and table_name='schema_migrations'
    and grantee in ('PUBLIC','public','anon','authenticated');
  if ledger_check <> 0 then raise exception 'FAIL schema_migrations must not be granted to app roles, found %', ledger_check; end if;
  raise notice 'PASS RLS enabled + policies on all public tables (schema_migrations: RLS on, no policy, no app grants)';

  -- 10) loan installment paid requires paid_at
  declare lid uuid;
  begin
    insert into public.loans (name, principal) values ('Test Kredi', 1500000) returning id into lid;
    begin
      insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
      values (lid, 1, current_date, 71744, 'paid');
      raise exception 'FAIL installment_paid_requires_paid_at did not fire';
    exception when check_violation then raise notice 'PASS installment_paid_requires_paid_at'; end;
  end;

  -- 11) financing mapping idempotency uniques (0008)
  declare wid uuid; sid uuid; rid uuid; lid2 uuid;
  begin
    insert into public.source_workbooks (original_filename) values ('assert.xlsx') returning id into wid;
    insert into public.source_sheets (workbook_id, sheet_name, sheet_index) values (wid, 'ÇEKLER', 0) returning id into sid;
    insert into public.import_rows (workbook_id, sheet_id, row_index, row_json) values (wid, sid, 2, '{}'::jsonb) returning id into rid;
    insert into public.checks (maturity_date, signed_amount, amount, direction, source_row_id)
    values (current_date, -100, 100, 'outflow', rid);
    begin
      insert into public.checks (maturity_date, signed_amount, amount, direction, source_row_id)
      values (current_date, -100, 100, 'outflow', rid);
      raise exception 'FAIL checks source_row idempotency did not fire';
    exception when unique_violation then raise notice 'PASS checks source_row idempotency'; end;
    insert into public.loans (name, principal, source_sheet_id) values ('K1', 1, sid) returning id into lid2;
    begin
      insert into public.loans (name, principal, source_sheet_id) values ('K2', 2, sid);
      raise exception 'FAIL loans source_sheet idempotency did not fire';
    exception when unique_violation then raise notice 'PASS loans source_sheet idempotency'; end;
  end;

  -- 12) production analytics (0010): seed machines, ROI needs_review default, mapping uniques
  declare wid2 uuid; sid2 uuid; rid2 uuid; pid3 uuid; cmid uuid; mid uuid; mcount int;
  begin
    select count(*) into mcount from public.machine_assets;
    if mcount <> 4 then raise exception 'FAIL machine seed: %', mcount; end if;
    -- ROI confidence defaults to needs_review
    select id into mid from public.machine_assets limit 1;
    insert into public.machine_roi_snapshots (machine_asset_id, snapshot_year, revenue)
    values (mid, 2026, 100) returning id into rid2;
    if (select confidence from public.machine_roi_snapshots where id=rid2) <> 'needs_review'
      then raise exception 'FAIL ROI confidence default'; end if;
    raise notice 'PASS machine seed + ROI needs_review default';
    -- production_parts source-row idempotency
    insert into public.source_workbooks (original_filename) values ('cap.xlsx') returning id into wid2;
    insert into public.source_sheets (workbook_id, sheet_name, sheet_index) values (wid2,'kapasite',0) returning id into sid2;
    insert into public.import_rows (workbook_id, sheet_id, row_index, row_json) values (wid2,sid2,10,'{}'::jsonb) returning id into rid2;
    insert into public.production_parts (part_name, source_row_id) values ('TAKOZ', rid2) returning id into pid3;
    begin
      insert into public.production_parts (part_name, source_row_id) values ('TAKOZ', rid2);
      raise exception 'FAIL production_parts idempotency did not fire';
    exception when unique_violation then raise notice 'PASS production_parts source_row idempotency'; end;
    -- capacity/cost one-per-sheet uniques + profitability unique
    insert into public.capacity_models (name, scenario_type, source_sheet_id) values ('cap','normal',sid2);
    begin
      insert into public.capacity_models (name, scenario_type, source_sheet_id) values ('cap2','normal',sid2);
      raise exception 'FAIL capacity_models idempotency did not fire';
    exception when unique_violation then raise notice 'PASS capacity/cost source_sheet idempotency'; end;
    insert into public.cost_models (model_name, source_sheet_id) values ('cm', sid2) returning id into cmid;
    insert into public.part_profitability_runs (part_id, cost_model_id) values (pid3, cmid);
    begin
      insert into public.part_profitability_runs (part_id, cost_model_id) values (pid3, cmid);
      raise exception 'FAIL profitability idempotency did not fire';
    exception when unique_violation then raise notice 'PASS part_profitability idempotency'; end;
  end;

  -- 13) scenario engine (0011): run-line idempotency + comparison uniqueness
  declare scid uuid; runid uuid; lcount int;
  begin
    insert into public.scenarios (name, scenario_type, baseline_month_count)
    values ('assert', 'revenue_up_down_percent', 35) returning id into scid;
    insert into public.scenario_runs (scenario_id, assumptions) values (scid, '{"revenuePct":0.1}'::jsonb) returning id into runid;
    insert into public.scenario_run_lines (run_id, month_start, scenario_closing) values (runid, date '2026-05-01', 100);
    begin
      insert into public.scenario_run_lines (run_id, month_start, scenario_closing) values (runid, date '2026-05-01', 200);
      raise exception 'FAIL scenario_run_lines idempotency did not fire';
    exception when unique_violation then raise notice 'PASS scenario_run_lines idempotency'; end;
    insert into public.scenario_comparisons (run_id, metric, delta) values (runid, 'final_cash', 50);
    begin
      insert into public.scenario_comparisons (run_id, metric, delta) values (runid, 'final_cash', 60);
      raise exception 'FAIL scenario_comparisons uniqueness did not fire';
    exception when unique_violation then raise notice 'PASS scenario_comparisons uniqueness'; end;
    -- cascade delete stays within scenario tables
    delete from public.scenario_runs where id = runid;
    select count(*) into lcount from public.scenario_run_lines where run_id = runid;
    if lcount <> 0 then raise exception 'FAIL scenario cascade delete'; end if;
    raise notice 'PASS scenario cascade delete';
  end;

  -- 14) cost breakdown (0012): RLS + line idempotency + akon columns
  declare wid3 uuid; sid3 uuid; cm3 uuid; rls3 int;
  begin
    select count(*) into rls3 from pg_tables t join pg_class c on c.relname=t.tablename
      join pg_namespace ns on ns.oid=c.relnamespace and ns.nspname='public'
      where t.tablename='cost_breakdown_lines' and not c.relrowsecurity;
    if rls3 > 0 then raise exception 'FAIL cost_breakdown_lines RLS off'; end if;
    insert into public.source_workbooks (original_filename) values ('cost.xlsx') returning id into wid3;
    insert into public.source_sheets (workbook_id, sheet_name, sheet_index) values (wid3,'maliyet',0) returning id into sid3;
    insert into public.cost_models (model_name, source_sheet_id, akon_freze_tl_per_min, akon_torna_tl_per_min)
      values ('cm', sid3, 27.5, 21.88) returning id into cm3;
    insert into public.cost_breakdown_lines (cost_model_id, block, label, amount) values (cm3,'fixed','eleman',357442);
    begin
      insert into public.cost_breakdown_lines (cost_model_id, block, label, amount) values (cm3,'fixed','eleman',999);
      raise exception 'FAIL cost_breakdown idempotency did not fire';
    exception when unique_violation then raise notice 'PASS cost_breakdown idempotency + akon cols + RLS'; end;
  end;

  -- 15) machine-minute + finance allocation (0013): RLS + idempotency
  declare wid4 uuid; sid4 uuid; cap4 uuid; loan4 uuid; rls4 int;
  begin
    select count(*) into rls4 from pg_tables t join pg_class c on c.relname=t.tablename
      join pg_namespace ns on ns.oid=c.relnamespace and ns.nspname='public'
      where t.tablename in ('machine_minute_allocations','finance_cost_allocations') and not c.relrowsecurity;
    if rls4 > 0 then raise exception 'FAIL allocation table RLS off'; end if;
    insert into public.source_workbooks (original_filename) values ('alloc.xlsx') returning id into wid4;
    insert into public.source_sheets (workbook_id, sheet_name, sheet_index) values (wid4,'kapasite',0) returning id into sid4;
    insert into public.capacity_models (name, scenario_type, source_workbook_id, source_sheet_id)
      values ('cap alloc','normal',wid4,sid4) returning id into cap4;
    insert into public.machine_minute_allocations
      (capacity_model_id, operation_type, machine_count, demand_minutes, available_minutes)
      values (cap4,'torna',3,276750,285120);
    begin
      insert into public.machine_minute_allocations
        (capacity_model_id, operation_type, machine_count, demand_minutes, available_minutes)
        values (cap4,'torna',3,1,1);
      raise exception 'FAIL machine-minute idempotency did not fire';
    exception when unique_violation then raise notice 'PASS machine-minute idempotency'; end;
    insert into public.loans (name, principal, total_finance_cost, source_workbook_id, source_sheet_id)
      values ('alloc loan', 1500000, 1943717.58, wid4, sid4) returning id into loan4;
    insert into public.finance_cost_allocations
      (loan_id, capacity_model_id, operation_type, allocated_finance_cost, finance_cost_per_minute)
      values (loan4, cap4, 'torna', 448000, 1.6);
    begin
      insert into public.finance_cost_allocations
        (loan_id, capacity_model_id, operation_type, allocated_finance_cost, finance_cost_per_minute)
        values (loan4, cap4, 'torna', 1, 1);
      raise exception 'FAIL finance allocation idempotency did not fire';
    exception when unique_violation then raise notice 'PASS finance allocation idempotency + RLS'; end;
  end;

  -- 16) AI response snapshots (0014): RLS + commentary-only append
  declare ai1 uuid; ai2 uuid; rls5 int;
  begin
    select count(*) into rls5 from pg_tables t join pg_class c on c.relname=t.tablename
      join pg_namespace ns on ns.oid=c.relnamespace and ns.nspname='public'
      where t.tablename='ai_response_snapshots' and not c.relrowsecurity;
    if rls5 > 0 then raise exception 'FAIL ai_response_snapshots RLS off'; end if;
    insert into public.ai_response_snapshots (question, answer_md, response_mode, source_fact_keys, source_hrefs)
      values ('risk nedir?', 'salt-okunur cevap', 'deterministic', array['first_negative_month'], array['/cashflow'])
      returning id into ai1;
    insert into public.ai_response_snapshots (question, answer_md, response_mode)
      values ('risk nedir?', 'ikinci snapshot', 'fallback')
      returning id into ai2;
    if ai1 = ai2 then raise exception 'FAIL ai snapshots should append distinct rows'; end if;
    raise notice 'PASS ai response snapshots append + RLS';
  end;

  -- 17) action items (0015): RLS + open duplicate guards + status constraint
  declare act1 uuid; rls6 int; fact_key text;
  begin
    fact_key := 'assert_' || replace(gen_random_uuid()::text, '-', '');
    select count(*) into rls6 from pg_tables t join pg_class c on c.relname=t.tablename
      join pg_namespace ns on ns.oid=c.relnamespace and ns.nspname='public'
      where t.tablename='action_items' and not c.relrowsecurity;
    if rls6 > 0 then raise exception 'FAIL action_items RLS off'; end if;
    insert into public.action_items (title, severity, source_type, source_fact_key)
      values ('Kasa kontrolu', 'high', 'home_action', fact_key) returning id into act1;
    begin
      insert into public.action_items (title, severity, source_type, source_fact_key)
        values ('Duplicate kasa kontrolu', 'high', 'home_action', fact_key);
      raise exception 'FAIL action_items fact duplicate guard did not fire';
    exception when unique_violation then raise notice 'PASS action_items fact duplicate guard'; end;
    update public.action_items set status='done' where id=act1;
    insert into public.action_items (title, severity, source_type, source_fact_key)
      values ('Kasa kontrolu yeniden', 'high', 'home_action', fact_key);
    begin
      insert into public.action_items (title, status) values ('Bad status', 'paid');
      raise exception 'FAIL action_items status constraint did not fire';
    exception when check_violation then raise notice 'PASS action_items status constraint + RLS'; end;
  end;

  -- 18) external assumptions (0016): RLS + source/date + internet review gate
  declare ext1 uuid; rls7 int;
  begin
    select count(*) into rls7 from pg_tables t join pg_class c on c.relname=t.tablename
      join pg_namespace ns on ns.oid=c.relnamespace and ns.nspname='public'
      where t.tablename='external_assumptions' and not c.relrowsecurity;
    if rls7 > 0 then raise exception 'FAIL external_assumptions RLS off'; end if;
    begin
      insert into public.external_assumptions
        (assumption_type, label, value_numeric, unit, source_kind, source_name, source_date, review_status)
        values ('interest_rate','internet approved without review', 45, 'percent', 'internet', 'test source', current_date, 'approved');
      raise exception 'FAIL internet assumption review gate did not fire';
    exception when check_violation then raise notice 'PASS external assumption internet review gate'; end;
    insert into public.external_assumptions
      (assumption_type, label, value_numeric, unit, source_kind, source_name, source_date)
      values ('energy_cost','manual electricity', 4.2, 'TRY/kWh', 'manual', 'manual estimate', current_date)
      returning id into ext1;
    update public.external_assumptions set review_status='approved', reviewed_at=now() where id=ext1;
    if (select review_status from public.external_assumptions where id=ext1) <> 'approved'
      then raise exception 'FAIL external assumption approve flow'; end if;
    raise notice 'PASS external assumptions source/date + RLS';
  end;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;
