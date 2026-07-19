-- Slice 4: validates 0028's amount_source check. Safe by construction — 0028's
-- ADD COLUMN ... DEFAULT 'legacy_unknown' NOT NULL satisfied every existing row in
-- the same ALTER TABLE, so no row can ever have violated this constraint.
-- VALIDATE on an already-valid constraint is a no-op (idempotent).
--
-- Before validating, this verifies the constraint that actually exists is the RIGHT one
-- (correct table, contype='c', expected expression) — an accidentally-same-named but
-- differently-defined constraint (or a missing one) must never be silently validated;
-- it must stop with a clear exception instead.

do $$
declare
  con_exists boolean;
  con_type text;
  con_expr text;
  expected_expr constant text :=
    '(amount_source = ANY (ARRAY[''generated''::text, ''manual''::text, ''legacy_unknown''::text]))';
begin
  select true, contype::text, trim(regexp_replace(pg_get_expr(conbin, conrelid), '\s+', ' ', 'g'))
    into con_exists, con_type, con_expr
  from pg_constraint
  where conname = 'payment_instances_amount_source_check'
    and conrelid = 'public.payment_instances'::regclass;

  if con_exists is null then
    raise exception
      'payment_instances_amount_source_check bulunamadı (public.payment_instances üzerinde) — 0028 önce başarıyla uygulanmış olmalı. VALIDATE denenmedi.';
  elsif con_type is distinct from 'c' or con_expr is distinct from expected_expr then
    raise exception
      'payment_instances_amount_source_check beklenmeyen tanımda (contype=%, expr=%) — beklenen: CHECK (amount_source IN (''generated'',''manual'',''legacy_unknown'')). VALIDATE denenmedi, migration güvenlik nedeniyle durduruldu.',
      con_type, con_expr;
  end if;

  alter table public.payment_instances
    validate constraint payment_instances_amount_source_check;
end $$;
