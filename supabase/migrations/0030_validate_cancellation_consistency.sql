-- Slice 6: validates 0026's three cancel-consistency checks (payment_instances, checks,
-- loan_installments). 0026 added them NOT VALID because exactly one payment_instances row
-- (id 77815c3d-6762-4382-b49e-65905c07d8df) had status='cancelled' with null
-- cancelled_at/cancel_reason — "that row is grandfathered by NOT VALID... until a later
-- repair slice backfills its metadata." Slice 5's legacy-repair apply backfilled that row's
-- metadata (operationId 4841561d-7dcf-48fe-a778-263174c6f0da); live violation count for all
-- three constraints is 0. This is that later repair slice.
--
-- Same fail-closed pattern as 0029: before validating, verify the constraint that actually
-- exists is the RIGHT one (correct table, contype='c', expected expression) — an
-- accidentally-same-named but differently-defined constraint (or a missing one) must never
-- be silently validated; it must stop with a clear exception instead.

do $$
declare
  con_exists boolean;
  con_type text;
  con_expr text;
  expected_expr constant text :=
    '(((status = ''cancelled''::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NOT NULL) = (cancel_reason IS NOT NULL)) AND ((cancel_reason IS NULL) OR (btrim(cancel_reason) <> ''''::text)))';
begin
  select true, contype::text, trim(regexp_replace(pg_get_expr(conbin, conrelid), '\s+', ' ', 'g'))
    into con_exists, con_type, con_expr
  from pg_constraint
  where conname = 'payment_instances_cancel_consistency'
    and conrelid = 'public.payment_instances'::regclass;

  if con_exists is null then
    raise exception
      'payment_instances_cancel_consistency bulunamadı (public.payment_instances üzerinde) — 0026 önce başarıyla uygulanmış olmalı. VALIDATE denenmedi.';
  elsif con_type is distinct from 'c' or con_expr is distinct from expected_expr then
    raise exception
      'payment_instances_cancel_consistency beklenmeyen tanımda (contype=%, expr=%) — beklenen: cancel-consistency check. VALIDATE denenmedi, migration güvenlik nedeniyle durduruldu.',
      con_type, con_expr;
  end if;

  alter table public.payment_instances
    validate constraint payment_instances_cancel_consistency;
end $$;

do $$
declare
  con_exists boolean;
  con_type text;
  con_expr text;
  expected_expr constant text :=
    '(((status = ''cancelled''::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NOT NULL) = (cancel_reason IS NOT NULL)) AND ((cancel_reason IS NULL) OR (btrim(cancel_reason) <> ''''::text)))';
begin
  select true, contype::text, trim(regexp_replace(pg_get_expr(conbin, conrelid), '\s+', ' ', 'g'))
    into con_exists, con_type, con_expr
  from pg_constraint
  where conname = 'checks_cancel_consistency'
    and conrelid = 'public.checks'::regclass;

  if con_exists is null then
    raise exception
      'checks_cancel_consistency bulunamadı (public.checks üzerinde) — 0026 önce başarıyla uygulanmış olmalı. VALIDATE denenmedi.';
  elsif con_type is distinct from 'c' or con_expr is distinct from expected_expr then
    raise exception
      'checks_cancel_consistency beklenmeyen tanımda (contype=%, expr=%) — beklenen: cancel-consistency check. VALIDATE denenmedi, migration güvenlik nedeniyle durduruldu.',
      con_type, con_expr;
  end if;

  alter table public.checks
    validate constraint checks_cancel_consistency;
end $$;

do $$
declare
  con_exists boolean;
  con_type text;
  con_expr text;
  expected_expr constant text :=
    '(((status = ''cancelled''::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NOT NULL) = (cancel_reason IS NOT NULL)) AND ((cancel_reason IS NULL) OR (btrim(cancel_reason) <> ''''::text)))';
begin
  select true, contype::text, trim(regexp_replace(pg_get_expr(conbin, conrelid), '\s+', ' ', 'g'))
    into con_exists, con_type, con_expr
  from pg_constraint
  where conname = 'loan_installments_cancel_consistency'
    and conrelid = 'public.loan_installments'::regclass;

  if con_exists is null then
    raise exception
      'loan_installments_cancel_consistency bulunamadı (public.loan_installments üzerinde) — 0026 önce başarıyla uygulanmış olmalı. VALIDATE denenmedi.';
  elsif con_type is distinct from 'c' or con_expr is distinct from expected_expr then
    raise exception
      'loan_installments_cancel_consistency beklenmeyen tanımda (contype=%, expr=%) — beklenen: cancel-consistency check. VALIDATE denenmedi, migration güvenlik nedeniyle durduruldu.',
      con_type, con_expr;
  end if;

  alter table public.loan_installments
    validate constraint loan_installments_cancel_consistency;
end $$;
