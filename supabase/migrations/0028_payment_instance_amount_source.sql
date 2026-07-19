-- Slice 4: amount_source classifies whether an instance's amount is safe to
-- auto-reconcile from its payment template. Existing rows cannot be distinguished
-- (the only INSERT site is generateInstancesForMonth, but setInstanceAmount may have
-- since overridden any of them with no trace) — they must default to the
-- conservative 'legacy_unknown', never 'generated'. NOT VALID here; 0029 validates.
--
-- `add column if not exists` alone would silently accept a pre-existing amount_source
-- column of the WRONG shape (nullable, wrong default, wrong type) without ever checking
-- it — this block verifies the actual on-disk definition and fails loudly rather than
-- converging or proceeding on an unverified assumption.

do $$
declare
  col_exists boolean;
  col_type text;
  col_nullable boolean;
  col_default text;
begin
  select true into col_exists
  from pg_attribute
  where attrelid = 'public.payment_instances'::regclass
    and attname = 'amount_source'
    and not attisdropped;

  if col_exists is null then
    alter table public.payment_instances
      add column amount_source text not null default 'legacy_unknown';
  else
    select format_type(a.atttypid, a.atttypmod),
           not a.attnotnull,
           pg_get_expr(d.adbin, d.adrelid)
      into col_type, col_nullable, col_default
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.payment_instances'::regclass
      and a.attname = 'amount_source'
      and not a.attisdropped;

    if col_type is distinct from 'text'
       or col_nullable is not false
       or col_default is distinct from '''legacy_unknown''::text' then
      raise exception
        'amount_source kolonu beklenmeyen şekilde zaten mevcut (type=%, nullable=%, default=%) — beklenen: text NOT NULL DEFAULT ''legacy_unknown''. Migration güvenlik nedeniyle durduruldu.',
        col_type, col_nullable, col_default;
    end if;
  end if;
end $$;

-- Aynı ada (+ tabloya) sahip bir constraint bulmak yeterli değil — başka bir kontrol
-- (ör. farklı bir değer kümesi, hatta check(false)) yanlışlıkla aynı isimle mevcutsa bu
-- bloğun onu sessizce "zaten var" sayıp geçmesi, güvenlik anlamında hiçbir şey doğrulamamış
-- olur. contype='c' VE gerçek check ifadesi (pg_get_expr ile) beklenen kümeyle (whitespace
-- normalize edilerek) birebir eşleşmiyorsa migration açık hata ile durur.
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
    alter table public.payment_instances
      add constraint payment_instances_amount_source_check
      check (amount_source in ('generated', 'manual', 'legacy_unknown'))
      not valid;
  elsif con_type is distinct from 'c' or con_expr is distinct from expected_expr then
    raise exception
      'payment_instances_amount_source_check beklenmeyen tanımda zaten mevcut (contype=%, expr=%) — beklenen: CHECK (amount_source IN (''generated'',''manual'',''legacy_unknown'')). Migration güvenlik nedeniyle durduruldu.',
      con_type, con_expr;
  end if;
end $$;
