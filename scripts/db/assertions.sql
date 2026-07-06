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
declare pid uuid; iid uuid; amt numeric; dd int; rls_missing int; pol_missing int;
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
  select count(*) into pol_missing from pg_tables t
  where t.schemaname='public'
    and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.tablename);
  if pol_missing > 0 then raise exception 'FAIL policy missing on % tables', pol_missing; end if;
  raise notice 'PASS RLS enabled + policies on all public tables';

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

  raise notice 'ALL ASSERTIONS PASSED';
end $$;
