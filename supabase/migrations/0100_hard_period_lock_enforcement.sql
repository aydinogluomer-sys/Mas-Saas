-- 0100 — Faz 45 (C2): Veritabanı seviyesinde sert dönem kilidi (Hard Period Lock),
-- rol-korumalı dönem kilit/yeniden açma geçişi ve kapalı dönem mutasyon görünümü onarımı.
--
-- Kurallar:
--   * Üst-seviye işlem komutu ve eşzamanlı indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric); tüm görünümler WITH (security_invoker = true) taşır.

-- ── 1) cashflow_months kilit ve yeniden açma metadata kolonları ──────────────────────────────
alter table public.cashflow_months
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by uuid references public.users(id) on delete set null,
  add column if not exists reopened_at timestamptz,
  add column if not exists reopened_by uuid references public.users(id) on delete set null,
  add column if not exists reopen_reason text,
  add column if not exists lock_fingerprint text;

update public.cashflow_months
   set locked_at = coalesce(locked_at, updated_at, created_at, now())
 where status = 'locked'
   and locked_at is null;

-- ── 2) Rol-korumalı dönem kilit / yeniden açma geçiş bekçisi ─────────────────────────────────
create or replace function public.enforce_cashflow_month_lock_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'locked' then
      raise exception 'period_locked: % ayı kilitlidir, dönem kaydı silinemez.',
        to_char(old.month_start, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'locked' then
      if current_user not in ('mas_radar_finance_manager', 'mas_radar_admin', 'postgres') then
        raise exception 'period_lock_requires_manager: dönem kilitleme yetkisi yalnız finans yöneticisi veya yöneticiye aittir.'
          using errcode = '42501';
      end if;
      new.locked_at := coalesce(new.locked_at, new.updated_at, now());
    end if;
    return new;
  end if;

  -- UPDATE
  if new.status = 'locked' or old.status = 'locked' then
    if current_user not in ('mas_radar_finance_manager', 'mas_radar_admin', 'postgres') then
      raise exception 'period_lock_requires_manager: dönem kilitleme ve kilit açma yetkisi yalnız finans yöneticisi veya yöneticiye aittir.'
        using errcode = '42501';
    end if;
  end if;

  -- Açık dönemden kilitli döneme geçiş
  if old.status <> 'locked' and new.status = 'locked' then
    new.locked_at := coalesce(new.locked_at, now());
    return new;
  end if;

  -- Kilitli dönemden açık döneme geçiş (reopen)
  if old.status = 'locked' and new.status <> 'locked' then
    if new.status <> 'reviewed' then
      raise exception 'period_reopen_target_invalid: kilitli dönem yalnız reviewed durumuna açılabilir (istenen: %).',
        new.status
        using errcode = '23514';
    end if;
    if coalesce(length(btrim(new.reopen_reason)), 0) < 10 then
      raise exception 'period_reopen_reason_required: dönem kilidini açmak için en az 10 karakterlik gerekçe zorunludur.'
        using errcode = '23514';
    end if;
    new.reopened_at := coalesce(new.reopened_at, now());
    return new;
  end if;

  -- Kilitli dönemde kalırken finansal başlık rakamlarının veya kilit zamanının değiştirilmesi yasaktır
  if old.status = 'locked' and new.status = 'locked' then
    if new.month_start is distinct from old.month_start
       or new.opening_balance is distinct from old.opening_balance
       or new.projected_income is distinct from old.projected_income
       or new.projected_expense is distinct from old.projected_expense
       or new.monthly_delta is distinct from old.monthly_delta
       or new.closing_balance is distinct from old.closing_balance
       or new.locked_at is distinct from old.locked_at
    then
      raise exception 'period_locked: % ayı kilitlidir, dönem toplamları değiştirilemez.',
        to_char(old.month_start, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists cashflow_months_lock_guard on public.cashflow_months;
create trigger cashflow_months_lock_guard
  before insert or update or delete on public.cashflow_months
  for each row execute function public.enforce_cashflow_month_lock_transition();

-- ── 3) Kilitli döneme geçmişe dönük yazma / silme / tarih kaydırma kalkanı ───────────────────
create or replace function public.assert_date_not_in_locked_period(
  p_date date,
  p_table text
)
returns void
language plpgsql
as $$
declare
  v_month date;
begin
  if p_date is null then
    return;
  end if;

  v_month := date_trunc('month', p_date)::date;

  if exists (
    select 1
      from public.cashflow_months cm
     where cm.month_start = v_month
       and cm.status = 'locked'
  ) then
    raise exception 'period_locked: % ayı kilitlidir, kayıt değiştirilemez (tablo: %).',
      to_char(v_month, 'YYYY-MM'), p_table
      using errcode = 'P0001';
  end if;
end $$;

create or replace function public.assert_cashflow_month_id_not_locked(
  p_month_id uuid,
  p_table text
)
returns void
language plpgsql
as $$
declare
  v_month date;
begin
  if p_month_id is null then
    return;
  end if;

  select cm.month_start
    into v_month
    from public.cashflow_months cm
   where cm.id = p_month_id
     and cm.status = 'locked';

  if v_month is not null then
    raise exception 'period_locked: % ayı kilitlidir, kayıt değiştirilemez (tablo: %).',
      to_char(v_month, 'YYYY-MM'), p_table
      using errcode = 'P0001';
  end if;
end $$;

create or replace function public.enforce_closed_period_lock()
returns trigger
language plpgsql
as $$
begin
  case tg_table_name
    when 'payment_instances' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(old.instance_month, tg_table_name);
        if old.paid_at is not null then
          perform public.assert_date_not_in_locked_period((old.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(new.instance_month, tg_table_name);
        if new.paid_at is not null then
          perform public.assert_date_not_in_locked_period((new.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;

    when 'payments' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
      end if;

    when 'cashflow_lines' then
      if tg_op <> 'INSERT' then
        perform public.assert_cashflow_month_id_not_locked(old.cashflow_month_id, tg_table_name);
        perform public.assert_date_not_in_locked_period(old.date_value, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_cashflow_month_id_not_locked(new.cashflow_month_id, tg_table_name);
        perform public.assert_date_not_in_locked_period(new.date_value, tg_table_name);
      end if;

    when 'invoices' then
      -- Açık bir dönemde yapılan tahsilat/ödeme dağıtımı (invoice_allocations -> allocations_enforce_invoice_ceiling,
      -- pg_trigger_depth() > 1) geçmiş dönemde kesilmiş açık bir faturanın YALNIZ allocated_amount önbelleğini
      -- güncellediğinde faturanın kendisi değişmemiştir; dağıtımın kendi tarihi zaten invoice_allocations
      -- üzerindeki period_lock tetikleyicisiyle denetlenir. Doğrudan yapılan her türlü fatura güncellemesi
      -- (pg_trigger_depth() = 1) veya başlık alanı değişimi ise kesin olarak engellenir.
      if tg_op = 'UPDATE'
         and pg_trigger_depth() > 1
         and new.direction is not distinct from old.direction
         and new.invoice_no is not distinct from old.invoice_no
         and new.party_id is not distinct from old.party_id
         and new.issue_date is not distinct from old.issue_date
         and new.due_date is not distinct from old.due_date
         and new.currency is not distinct from old.currency
         and new.net_amount is not distinct from old.net_amount
         and new.tax_amount is not distinct from old.tax_amount
         and new.gross_amount is not distinct from old.gross_amount
         and new.status is not distinct from old.status
         and new.notes is not distinct from old.notes
      then
        return new;
      end if;

      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.issue_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.issue_date, tg_table_name);
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
      end if;

    when 'invoice_allocations' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.allocated_on, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.allocated_on, tg_table_name);
      end if;

    when 'checks' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.maturity_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.maturity_date, tg_table_name);
      end if;

    when 'loan_installments' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.due_date, tg_table_name);
        if old.paid_at is not null then
          perform public.assert_date_not_in_locked_period((old.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.due_date, tg_table_name);
        if new.paid_at is not null then
          perform public.assert_date_not_in_locked_period((new.paid_at at time zone 'Europe/Istanbul')::date, tg_table_name);
        end if;
      end if;

    when 'bank_transactions' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.txn_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.txn_date, tg_table_name);
      end if;

    else
      raise exception 'enforce_closed_period_lock: tanımsız tablo %', tg_table_name;
  end case;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

do $attach_period_locks$
declare
  tbl text;
begin
  foreach tbl in array array[
    'payment_instances',
    'payments',
    'cashflow_lines',
    'invoices',
    'invoice_allocations',
    'checks',
    'loan_installments',
    'bank_transactions'
  ] loop
    execute format('drop trigger if exists closed_period_lock_guard on public.%I', tbl);
    execute format(
      'create trigger closed_period_lock_guard before insert or update or delete on public.%I '
      || 'for each row execute function public.enforce_closed_period_lock()',
      tbl
    );
  end loop;
end $attach_period_locks$;

-- ── 4) control_closed_period_mutations görünümü (değiştirilemez cm.locked_at çıpası) ─────────
create or replace view public.control_closed_period_mutations
with (security_invoker = true) as
  select
    v.id                                    as invoice_id,
    v.invoice_no,
    v.issue_date,
    date_trunc('month', v.issue_date)::date as period_start,
    v.updated_at,
    cm.status                               as period_status,
    cm.locked_at
  from public.invoices v
  join public.cashflow_months cm
    on cm.month_start = date_trunc('month', v.issue_date)::date
  where cm.status = 'locked'
    and v.updated_at > coalesce(cm.locked_at, cm.updated_at);

revoke insert, update, delete, truncate on table public.control_closed_period_mutations
  from anon, authenticated, mas_radar_app,
       mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
       mas_radar_finance_manager, mas_radar_admin;

grant select on table public.control_closed_period_mutations
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

create or replace view public.control_registry
with (security_invoker = true) as
  select * from (values
    ('duplicate_invoice',        'Yinelenen fatura',                'critical', 'detection_only',
     'invoices.dedupe_hash benzersiz DEĞİL (bank_transactions''ınkinin aksine) — bunu yalnız bu kontrol yakalar'),
    ('near_duplicate_bank_txn',  'Yinelenene yakın banka hareketi', 'warning',  'enforced_elsewhere',
     'Birebir kopya bank_transactions_dedupe_uq ile zaten imkânsız; bu, hash''in göremediği yakın kopyaları arar'),
    ('allocation_over_invoice',  'Dağıtım faturayı aşıyor',         'critical', 'enforced_elsewhere',
     'Faz 22''nin allocations_enforce_invoice_ceiling() trigger''ı zaten engelliyor; burada yalnız görünürlük'),
    ('payment_without_invoice',  'Faturasız ödeme',                 'warning',  'detection_only',
     'Hiçbir mekanizma engellemiyor'),
    ('unmatched_bank_txn_aged',  'Uzun süredir eşleşmemiş hareket', 'warning',  'detection_only',
     'status=''unmatched'' bir veri durumu; yaşlanması bir bulgu'),
    ('unknown_counterparty',     'Tanınmayan karşı taraf',          'warning',  'enforced_elsewhere',
     'Faz 19: uygulama eşleme sırasında sessizce parties satırı YARATMIYOR; ham etiket kasıtlı'),
    ('iban_changed',             'IBAN değişti/yeni IBAN',          'critical', 'enforced_elsewhere',
     'Faz 19''un iban_change_events''i her değişimi zaten salt-ekleme kaydediyor; burada görünürlük'),
    ('large_payment',            'Büyük/olağandışı ödeme',          'warning',  'detection_only',
     'Eşik settings.critical_payment_threshold_try''den okunuyor — ikinci bir sayı icat edilmedi'),
    ('closed_period_mutation',   'Kapalı dönem mutasyonu',          'critical', 'enforced_elsewhere',
     'Faz 45 (0100) enforce_closed_period_lock() BEFORE trigger''ı kilitli döneme yazmayı zaten engelliyor; görünüm yalnız tarihsel anomali kanıtı'),
    ('approval_bypass',          'Onay atlanmış',                   'critical', 'detection_only',
     'Faz 24A''nın approvals''ı var ama eşiği aşan kaydın onayı olup olmadığını kimse kontrol etmiyordu'),
    ('missing_source_document',  'Kaynak belge eksik',              'info',     'detection_only',
     'Kaynak soyağacı Faz 2''den beri var; eksikliği bir bulgu olarak raporlanmıyordu')
  ) as t(check_code, title, default_severity, enforcement, rationale);

revoke insert, update, delete, truncate on table public.control_registry
  from anon, authenticated, mas_radar_app,
       mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
       mas_radar_finance_manager, mas_radar_admin;

grant select on table public.control_registry
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

-- ── 5) Kendi kendini doğrulayan şema ve güvenlik kapısı ─────────────────────────────────────
do $verify_0100$
declare
  v_missing_cols int;
  v_trig_count int;
  v_invoker boolean;
begin
  select count(*)
    into v_missing_cols
    from unnest(array['locked_at','locked_by','reopened_at','reopened_by','reopen_reason','lock_fingerprint']) as col
   where not exists (
     select 1
       from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'cashflow_months'
        and c.column_name = col
   );

  if v_missing_cols > 0 then
    raise exception '0100 doğrulama hatası: cashflow_months üzerinde % kilit kolonu eksik.', v_missing_cols;
  end if;

  select count(*)
    into v_trig_count
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and t.tgname = 'closed_period_lock_guard'
     and not t.tgisinternal;

  if v_trig_count <> 8 then
    raise exception '0100 doğrulama hatası: closed_period_lock_guard tetikleyici sayısı 8 olmalıydı (bulunan: %).', v_trig_count;
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'control_closed_period_mutations';

  if not v_invoker then
    raise exception '0100 doğrulama hatası: control_closed_period_mutations security_invoker=true taşımıyor.';
  end if;
end $verify_0100$;
