-- 0105 — Faz 52 (E2): Çift Taraflı Yönetim Defteri (TDHP Uyumlu Hesap Planı,
-- DEFERRABLE Denge Bekçisi, Değişmezlik + Ters Kayıt Kalkanı, Yönetim Mizanı,
-- Gelir Tablosu & Yönetim EBITDA Şelalesi ve Dinamik Yönetim Bilançosu).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric); tüm görünümler WITH (security_invoker = true) taşır.
--   * Her yabancı anahtar (FK) kolonu için B-tree indeks tanımlanır (unindexedForeignKeys = 0).
--   * BLANK ≠ ZERO: döviz kuru eksikse 1.0 yazılmaz; fiş status='provisional_fx' ve debit_try/credit_try=NULL kalır.

-- ── 1) TDHP Uyumlu Yönetim Hesap Planı: public.management_accounts (reference sınıfı) ─────────
create table if not exists public.management_accounts (
  id uuid primary key default gen_random_uuid(),
  code text unique not null check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  parent_code text,
  account_class text not null
    check (account_class in (
      'asset',
      'liability',
      'equity',
      'revenue',
      'contra_revenue',
      'cogs',
      'opex',
      'finance_expense',
      'other_income_expense',
      'off_balance'
    )),
  normal_side text not null
    check (normal_side in ('debit', 'credit')),
  ebitda_bucket text not null
    check (ebitda_bucket in (
      'revenue',
      'cogs',
      'opex',
      'da_addback',
      'financing',
      'tax',
      'non_operating',
      'balance_sheet'
    )),
  tdhp_root_code text not null check (btrim(tdhp_root_code) <> ''),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_management_accounts_root
  on public.management_accounts (tdhp_root_code, code);
create index if not exists idx_management_accounts_class
  on public.management_accounts (account_class, ebitda_bucket);

-- TDHP çekirdek hesap planı tohumu (idempotent upsert)
insert into public.management_accounts
  (code, name, parent_code, account_class, normal_side, ebitda_bucket, tdhp_root_code)
values
  ('100',    'Kasa',                                                       null,  'asset',                'debit',  'balance_sheet', '100'),
  ('101',    'Alınan Çekler',                                              null,  'asset',                'debit',  'balance_sheet', '101'),
  ('101.01', 'Portföydeki Çekler',                                         '101', 'asset',                'debit',  'balance_sheet', '101'),
  ('101.02', 'Tahsildeki Çekler',                                          '101', 'asset',                'debit',  'balance_sheet', '101'),
  ('101.03', 'Teminattaki Çekler',                                         '101', 'asset',                'debit',  'balance_sheet', '101'),
  ('102',    'Bankalar',                                                   null,  'asset',                'debit',  'balance_sheet', '102'),
  ('103',    'Verilen Çekler ve Ödeme Emirleri (-)',                       null,  'asset',                'credit', 'balance_sheet', '103'),
  ('120',    'Alıcılar',                                                   null,  'asset',                'debit',  'balance_sheet', '120'),
  ('121',    'Alacak Senetleri',                                           null,  'asset',                'debit',  'balance_sheet', '121'),
  ('131',    'Ortaklardan Alacaklar',                                      null,  'asset',                'debit',  'balance_sheet', '131'),
  ('153',    'Ticari Mallar',                                              null,  'asset',                'debit',  'balance_sheet', '153'),
  ('190',    'Devreden KDV',                                               null,  'asset',                'debit',  'balance_sheet', '190'),
  ('191',    'İndirilecek KDV',                                            null,  'asset',                'debit',  'balance_sheet', '191'),
  ('193',    'Peşin Ödenen Vergiler ve Fonlar',                            null,  'asset',                'debit',  'balance_sheet', '193'),
  ('195',    'İş Avansları',                                               null,  'asset',                'debit',  'balance_sheet', '195'),
  ('253',    'Tesis, Makine ve Cihazlar',                                  null,  'asset',                'debit',  'balance_sheet', '253'),
  ('257',    'Birikmiş Amortismanlar (-)',                                 null,  'asset',                'credit', 'balance_sheet', '257'),
  ('300',    'Banka Kredileri',                                            null,  'liability',            'credit', 'balance_sheet', '300'),
  ('320',    'Satıcılar',                                                  null,  'liability',            'credit', 'balance_sheet', '320'),
  ('321',    'Borç Senetleri',                                             null,  'liability',            'credit', 'balance_sheet', '321'),
  ('331',    'Ortaklara Borçlar',                                          null,  'liability',            'credit', 'balance_sheet', '331'),
  ('335',    'Personele Borçlar',                                          null,  'liability',            'credit', 'balance_sheet', '335'),
  ('360',    'Ödenecek Vergi ve Fonlar',                                   null,  'liability',            'credit', 'balance_sheet', '360'),
  ('361',    'Ödenecek Sosyal Güvenlik Kesintileri',                       null,  'liability',            'credit', 'balance_sheet', '361'),
  ('370',    'Dönem Kârı Vergi ve Diğer Yasal Yükümlülük Karşılıkları',    null,  'liability',            'credit', 'balance_sheet', '370'),
  ('391',    'Hesaplanan KDV',                                             null,  'liability',            'credit', 'balance_sheet', '391'),
  ('400',    'Uzun Vadeli Banka Kredileri',                                null,  'liability',            'credit', 'balance_sheet', '400'),
  ('500',    'Sermaye',                                                    null,  'equity',               'credit', 'balance_sheet', '500'),
  ('590',    'Dönem Net Kârı',                                             null,  'equity',               'credit', 'balance_sheet', '590'),
  ('591',    'Dönem Net Zararı (-)',                                       null,  'equity',               'debit',  'balance_sheet', '591'),
  ('600',    'Yurtiçi Satışlar',                                           null,  'revenue',              'credit', 'revenue',       '600'),
  ('601',    'Yurtdışı Satışlar',                                          null,  'revenue',              'credit', 'revenue',       '601'),
  ('610',    'Satıştan İadeler (-)',                                       null,  'contra_revenue',       'debit',  'revenue',       '610'),
  ('611',    'Satış İskontoları (-)',                                      null,  'contra_revenue',       'debit',  'revenue',       '611'),
  ('620',    'Satılan Mamuller Maliyeti (-)',                              null,  'cogs',                 'debit',  'cogs',          '620'),
  ('621',    'Satılan Ticari Mallar Maliyeti (-)',                         null,  'cogs',                 'debit',  'cogs',          '621'),
  ('622',    'Satılan Hizmet Maliyeti (-)',                                null,  'cogs',                 'debit',  'cogs',          '622'),
  ('630',    'Araştırma ve Geliştirme Giderleri (-)',                      null,  'opex',                 'debit',  'opex',          '630'),
  ('631',    'Pazarlama, Satış ve Dağıtım Giderleri (-)',                  null,  'opex',                 'debit',  'opex',          '631'),
  ('632',    'Genel Yönetim Giderleri (-)',                                null,  'opex',                 'debit',  'opex',          '632'),
  ('642',    'Faiz Gelirleri',                                             null,  'other_income_expense', 'credit', 'non_operating', '642'),
  ('646',    'Kambiyo Kârları',                                            null,  'other_income_expense', 'credit', 'non_operating', '646'),
  ('653',    'Komisyon Giderleri (-)',                                     null,  'other_income_expense', 'debit',  'non_operating', '653'),
  ('656',    'Kambiyo Zararları (-)',                                      null,  'other_income_expense', 'debit',  'non_operating', '656'),
  ('660',    'Kısa Vadeli Borçlanma Giderleri (-)',                        null,  'finance_expense',      'debit',  'financing',     '660'),
  ('690',    'Dönem Kârı veya Zararı',                                     null,  'other_income_expense', 'credit', 'non_operating', '690'),
  ('691',    'Dönem Kârı Vergi ve Diğer Yasal Yükümlülük Karşılıkları (-)',null,  'other_income_expense', 'debit',  'tax',           '691'),
  ('730',    'Genel Üretim Giderleri',                                     null,  'cogs',                 'debit',  'cogs',          '730'),
  ('770',    'Genel Yönetim Giderleri (7/A)',                              null,  'opex',                 'debit',  'opex',          '770'),
  ('770.99', 'Amortisman ve İtfa Payları (D&A)',                           '770', 'opex',                 'debit',  'da_addback',    '770'),
  ('780',    'Finansman Giderleri (Faiz, BSMV, KKDF, Banka Komisyonu)',    null,  'finance_expense',      'debit',  'financing',     '780'),
  ('900',    'Ciro Edilen Çekler Rücu Riski (Nazım Borç)',                 null,  'off_balance',          'debit',  'balance_sheet', '900'),
  ('901',    'Ciro Edilen Çekler Rücu Alacaklıları (Nazım Alacak)',        null,  'off_balance',          'credit', 'balance_sheet', '901')
on conflict (code) do update
  set name           = excluded.name,
      parent_code    = excluded.parent_code,
      account_class  = excluded.account_class,
      normal_side    = excluded.normal_side,
      ebitda_bucket  = excluded.ebitda_bucket,
      tdhp_root_code = excluded.tdhp_root_code;

-- ── 2) Yönetim Yevmiye Fişleri ve Satırları (operational sınıfı) ──────────────────────────────
create table if not exists public.management_journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_no bigint generated always as identity unique,
  entry_date date not null,
  period_month date generated always as ((date_trunc('month', entry_date::timestamp))::date) stored,
  source_type text not null
    check (source_type in (
      'invoice',
      'bank_transaction',
      'check_bordro',
      'loan_installment',
      'payment_instance',
      'manual_adjustment',
      'fx_revaluation',
      'reversal'
    )),
  source_id uuid,
  idempotency_key text unique not null check (btrim(idempotency_key) <> ''),
  status text not null default 'posted'
    check (status in ('draft', 'provisional_fx', 'posted', 'reversed')),
  needs_tax_split_review boolean not null default false,
  description text not null check (btrim(description) <> ''),
  reversal_of_entry_id uuid references public.management_journal_entries(id) on delete restrict,
  reversed_by_entry_id uuid references public.management_journal_entries(id) on delete restrict,
  approved_by uuid references public.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_mgmt_je_date_status
  on public.management_journal_entries (entry_date desc, status);
create index if not exists idx_mgmt_je_period_status
  on public.management_journal_entries (period_month desc, status);
create index if not exists idx_mgmt_je_source
  on public.management_journal_entries (source_type, source_id)
  where source_id is not null;
create index if not exists idx_mgmt_je_reversal_of
  on public.management_journal_entries (reversal_of_entry_id)
  where reversal_of_entry_id is not null;
create index if not exists idx_mgmt_je_reversed_by
  on public.management_journal_entries (reversed_by_entry_id)
  where reversed_by_entry_id is not null;
create index if not exists idx_mgmt_je_approved_by
  on public.management_journal_entries (approved_by)
  where approved_by is not null;
create index if not exists idx_mgmt_je_created_by
  on public.management_journal_entries (created_by)
  where created_by is not null;

create table if not exists public.management_journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.management_journal_entries(id) on delete cascade,
  line_no int not null check (line_no >= 1),
  account_id uuid not null references public.management_accounts(id) on delete restrict,
  party_id uuid references public.parties(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  cost_center_id uuid references public.cost_centers(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  native_currency text not null default 'TRY' check (native_currency ~ '^[A-Z]{3}$'),
  debit_native numeric(14,2) not null default 0 check (debit_native >= 0),
  credit_native numeric(14,2) not null default 0 check (credit_native >= 0),
  fx_rate numeric(14,6) check (fx_rate is null or fx_rate > 0),
  debit_try numeric(14,2) check (debit_try is null or debit_try >= 0),
  credit_try numeric(14,2) check (credit_try is null or credit_try >= 0),
  line_memo text,
  constraint management_journal_lines_single_sided
    check ((debit_native > 0 and credit_native = 0) or (credit_native > 0 and debit_native = 0)),
  constraint management_journal_lines_try_single_sided
    check (
      (debit_try is null and credit_try is null)
      or (debit_try > 0 and credit_try = 0)
      or (credit_try > 0 and debit_try = 0)
    ),
  constraint management_journal_lines_entry_line_uq unique (entry_id, line_no)
);

create index if not exists idx_mgmt_jl_entry
  on public.management_journal_lines (entry_id, line_no);
create index if not exists idx_mgmt_jl_account
  on public.management_journal_lines (account_id);
create index if not exists idx_mgmt_jl_party
  on public.management_journal_lines (party_id)
  where party_id is not null;
create index if not exists idx_mgmt_jl_project
  on public.management_journal_lines (project_id)
  where project_id is not null;
create index if not exists idx_mgmt_jl_cost_center
  on public.management_journal_lines (cost_center_id)
  where cost_center_id is not null;
create index if not exists idx_mgmt_jl_department
  on public.management_journal_lines (department_id)
  where department_id is not null;

-- ── 3) DEFERRABLE Denge Bekçisi: assert_management_journal_balanced() ─────────────────────────
create or replace function public.assert_management_journal_balanced()
returns trigger
language plpgsql
as $$
declare
  v_entry_id uuid;
  v_status text;
  v_line_count int;
  v_null_try_count int;
  v_debit_sum numeric(16,2);
  v_credit_sum numeric(16,2);
begin
  if tg_table_name = 'management_journal_entries' then
    v_entry_id := coalesce(new.id, old.id);
  else
    v_entry_id := coalesce(new.entry_id, old.entry_id);
  end if;

  if v_entry_id is null then
    return null;
  end if;

  select je.status
    into v_status
    from public.management_journal_entries je
   where je.id = v_entry_id;

  -- Fiş silinmişse (draft iken) kontrol gerekmez
  if not found then
    return null;
  end if;

  select
    count(*)::int,
    count(*) filter (where jl.debit_try is null or jl.credit_try is null)::int,
    coalesce(sum(jl.debit_try), 0)::numeric(16,2),
    coalesce(sum(jl.credit_try), 0)::numeric(16,2)
  into
    v_line_count,
    v_null_try_count,
    v_debit_sum,
    v_credit_sum
  from public.management_journal_lines jl
  where jl.entry_id = v_entry_id;

  if v_status in ('posted', 'reversed') then
    if v_line_count < 2 then
      raise exception 'unbalanced_management_journal_entry: fiş (%) en az 2 satır içermelidir (mevcut: %).',
        v_entry_id, v_line_count
        using errcode = '23514';
    end if;

    if v_null_try_count > 0 then
      raise exception 'unbalanced_management_journal_entry: posted fişte (%) TRY karşılığı eksik (%) satır olamaz (provisional_fx kullanılmalıdır).',
        v_entry_id, v_null_try_count
        using errcode = '23514';
    end if;

    if v_debit_sum <= 0 or v_debit_sum <> v_credit_sum then
      raise exception 'unbalanced_management_journal_entry: fiş (%) borç toplamı (%) alacak toplamına (%) eşit değil.',
        v_entry_id, v_debit_sum, v_credit_sum
        using errcode = '23514';
    end if;
  elsif v_status = 'provisional_fx' then
    if v_line_count < 2 then
      raise exception 'unbalanced_management_journal_entry: provisional_fx fiş (%) en az 2 satır içermelidir.',
        v_entry_id
        using errcode = '23514';
    end if;
  end if;

  return null;
end $$;

drop trigger if exists management_journal_balance_guard on public.management_journal_lines;
create constraint trigger management_journal_balance_guard
  after insert or update or delete on public.management_journal_lines
  deferrable initially deferred
  for each row execute function public.assert_management_journal_balanced();

drop trigger if exists management_journal_entry_balance_guard on public.management_journal_entries;
create constraint trigger management_journal_entry_balance_guard
  after insert or update on public.management_journal_entries
  deferrable initially deferred
  for each row execute function public.assert_management_journal_balanced();

-- ── 4) Değişmezlik (Immutability) + Ters Kayıt Kalkanı ────────────────────────────────────────
create or replace function public.enforce_management_journal_entry_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted', 'reversed') then
      raise exception 'immutable_management_journal_entry: kesinleşmiş (%) yevmiye fişi silinemez; ters kayıt (reversal) açılmalıdır.',
        old.id
        using errcode = '23514';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.status = 'reversed' then
    raise exception 'immutable_management_journal_entry: ters kayıtla kapatılmış (%) yevmiye fişi değiştirilemez.',
      old.id
      using errcode = '23514';
  end if;

  if old.status = 'posted' then
    -- Kesinleşmiş fişte yalnız status='reversed' ve reversed_by_entry_id bağlamasına izin verilir
    if new.status = 'reversed'
       and new.reversed_by_entry_id is not null
       and old.reversed_by_entry_id is null
       and new.entry_date is not distinct from old.entry_date
       and new.source_type is not distinct from old.source_type
       and new.source_id is not distinct from old.source_id
       and new.idempotency_key is not distinct from old.idempotency_key
       and new.description is not distinct from old.description
       and new.reversal_of_entry_id is not distinct from old.reversal_of_entry_id
    then
      return new;
    end if;

    raise exception 'immutable_management_journal_entry: kesinleşmiş (%) yevmiye fişi doğrudan güncellenemez; ters kayıt (reversal) kullanılmalıdır.',
      old.id
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists management_journal_entries_immutability_guard on public.management_journal_entries;
create trigger management_journal_entries_immutability_guard
  before update or delete on public.management_journal_entries
  for each row execute function public.enforce_management_journal_entry_immutability();

create or replace function public.enforce_management_journal_line_immutability()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  select je.status
    into v_status
    from public.management_journal_entries je
   where je.id = old.entry_id;

  if v_status in ('posted', 'reversed') then
    raise exception 'immutable_management_journal_line: kesinleşmiş yevmiye fişinin (%) satırları değiştirilemez veya silinemez.',
      old.entry_id
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists management_journal_lines_immutability_guard on public.management_journal_lines;
create trigger management_journal_lines_immutability_guard
  before update or delete on public.management_journal_lines
  for each row execute function public.enforce_management_journal_line_immutability();

-- ── 5) Faz 45 (0100) Sert Dönem Kilidinin management_journal_entries.entry_date Üzerine Bağlanması ──
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
         and new.notes is not distinct from old.notes
         and new.cancelled_at is not distinct from old.cancelled_at
         and new.closed_at is not distinct from old.closed_at
         and new.status in ('open', 'partial', 'paid')
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

    when 'management_journal_entries' then
      if tg_op <> 'INSERT' then
        perform public.assert_date_not_in_locked_period(old.entry_date, tg_table_name);
      end if;
      if tg_op <> 'DELETE' then
        perform public.assert_date_not_in_locked_period(new.entry_date, tg_table_name);
      end if;

    else
      raise exception 'enforce_closed_period_lock: tanımsız tablo %', tg_table_name;
  end case;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists closed_period_lock_guard on public.management_journal_entries;
create trigger closed_period_lock_guard
  before insert or update or delete on public.management_journal_entries
  for each row execute function public.enforce_closed_period_lock();

-- ── 6) Yönetim Mizanı, Gelir Tablosu / EBITDA ve Dinamik Yönetim Bilançosu Görünümleri ─────────
create or replace view public.management_trial_balance_v
with (security_invoker = true) as
  select
    ma.id                                                                            as account_id,
    ma.code                                                                          as account_code,
    ma.name                                                                          as account_name,
    ma.parent_code,
    ma.tdhp_root_code,
    ma.account_class,
    ma.normal_side,
    ma.ebitda_bucket,
    count(distinct je.id)::int                                                       as entry_count,
    coalesce(sum(jl.debit_try), 0)::numeric(16,2)                                    as debit_total_try,
    coalesce(sum(jl.credit_try), 0)::numeric(16,2)                                   as credit_total_try,
    greatest(coalesce(sum(jl.debit_try), 0) - coalesce(sum(jl.credit_try), 0), 0)::numeric(16,2)
                                                                                     as debit_balance_try,
    greatest(coalesce(sum(jl.credit_try), 0) - coalesce(sum(jl.debit_try), 0), 0)::numeric(16,2)
                                                                                     as credit_balance_try,
    (coalesce(sum(jl.debit_try), 0) - coalesce(sum(jl.credit_try), 0))::numeric(16,2)
                                                                                     as net_balance_try
  from public.management_accounts ma
  left join (
    public.management_journal_lines jl
    join public.management_journal_entries je
      on je.id = jl.entry_id
     and je.status in ('posted', 'reversed')
  ) on jl.account_id = ma.id
  where ma.is_active = true
  group by
    ma.id, ma.code, ma.name, ma.parent_code, ma.tdhp_root_code,
    ma.account_class, ma.normal_side, ma.ebitda_bucket
  order by ma.code asc;

create or replace view public.management_income_statement_v
with (security_invoker = true) as
  with pl_lines as (
    select
      coalesce(sum(case when ma.account_class = 'revenue' then jl.credit_try - jl.debit_try else 0 end), 0)::numeric(16,2)
        as gross_sales_try,
      coalesce(sum(case when ma.account_class = 'contra_revenue' then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)
        as sales_discounts_try,
      coalesce(sum(case when ma.account_class = 'cogs' then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)
        as cogs_try,
      coalesce(sum(case when ma.account_class = 'opex' then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)
        as opex_total_try,
      coalesce(sum(case when ma.ebitda_bucket = 'da_addback' then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)
        as da_addback_try,
      coalesce(sum(case when ma.account_class = 'other_income_expense' and ma.ebitda_bucket <> 'tax' then jl.credit_try - jl.debit_try else 0 end), 0)::numeric(16,2)
        as other_net_income_try,
      coalesce(sum(case when ma.account_class = 'finance_expense' then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)
        as financing_expense_try,
      coalesce(sum(case when ma.ebitda_bucket = 'tax' then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)
        as tax_expense_try
    from public.management_journal_lines jl
    join public.management_journal_entries je
      on je.id = jl.entry_id
     and je.status in ('posted', 'reversed')
    join public.management_accounts ma
      on ma.id = jl.account_id
  )
  select
    p.gross_sales_try,
    p.sales_discounts_try,
    (p.gross_sales_try - p.sales_discounts_try)::numeric(16,2)
      as net_sales_try,
    p.cogs_try,
    ((p.gross_sales_try - p.sales_discounts_try) - p.cogs_try)::numeric(16,2)
      as gross_profit_try,
    p.opex_total_try,
    p.da_addback_try,
    (p.opex_total_try - p.da_addback_try)::numeric(16,2)
      as opex_cash_try,
    (((p.gross_sales_try - p.sales_discounts_try) - p.cogs_try) - p.opex_total_try)::numeric(16,2)
      as ebit_try,
    ((((p.gross_sales_try - p.sales_discounts_try) - p.cogs_try) - p.opex_total_try) + p.da_addback_try)::numeric(16,2)
      as management_ebitda_try,
    p.other_net_income_try,
    p.financing_expense_try,
    ((((p.gross_sales_try - p.sales_discounts_try) - p.cogs_try) - p.opex_total_try) + p.other_net_income_try - p.financing_expense_try)::numeric(16,2)
      as ebt_try,
    p.tax_expense_try,
    (((((p.gross_sales_try - p.sales_discounts_try) - p.cogs_try) - p.opex_total_try) + p.other_net_income_try - p.financing_expense_try) - p.tax_expense_try)::numeric(16,2)
      as net_income_try
  from pl_lines p;

create or replace view public.management_balance_sheet_v
with (security_invoker = true) as
  with bs_accounts as (
    select
      ma.code                                                           as account_code,
      ma.name                                                           as account_name,
      ma.tdhp_root_code,
      ma.account_class                                                  as section,
      case
        when ma.account_class = 'asset' then
          (coalesce(sum(jl.debit_try), 0) - coalesce(sum(jl.credit_try), 0))::numeric(16,2)
        else
          (coalesce(sum(jl.credit_try), 0) - coalesce(sum(jl.debit_try), 0))::numeric(16,2)
      end                                                               as amount_try,
      false                                                             as is_dynamic_net_income
    from public.management_accounts ma
    left join (
      public.management_journal_lines jl
      join public.management_journal_entries je
        on je.id = jl.entry_id
       and je.status in ('posted', 'reversed')
    ) on jl.account_id = ma.id
    where ma.account_class in ('asset', 'liability', 'equity')
      and ma.is_active = true
    group by ma.code, ma.name, ma.tdhp_root_code, ma.account_class
  ),
  pl_net as (
    select
      coalesce(sum(jl.credit_try - jl.debit_try), 0)::numeric(16,2) as current_period_net_income_try
    from public.management_journal_lines jl
    join public.management_journal_entries je
      on je.id = jl.entry_id
     and je.status in ('posted', 'reversed')
    join public.management_accounts ma
      on ma.id = jl.account_id
    where ma.account_class in (
      'revenue',
      'contra_revenue',
      'cogs',
      'opex',
      'finance_expense',
      'other_income_expense'
    )
  )
  select
    b.account_code,
    b.account_name,
    b.tdhp_root_code,
    b.section,
    b.amount_try,
    b.is_dynamic_net_income
  from bs_accounts b
  where b.amount_try <> 0 or b.account_code in ('100', '102', '120', '300', '320', '500')
  union all
  select
    case when p.current_period_net_income_try >= 0 then '590.DYN' else '591.DYN' end as account_code,
    'Cari Dönem Net Kârı / (Zararı) (Otomatik Özkaynak Yansıması)'                   as account_name,
    case when p.current_period_net_income_try >= 0 then '590' else '591' end         as tdhp_root_code,
    'equity'                                                                         as section,
    p.current_period_net_income_try                                                  as amount_try,
    true                                                                             as is_dynamic_net_income
  from pl_net p;

-- Görünüm yetki sertleştirmesi (0098 standardı)
do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'management_trial_balance_v',
    'management_income_statement_v',
    'management_balance_sheet_v'
  ] loop
    execute format('alter view public.%I set (security_invoker = true)', v_name);
    execute format(
      'revoke insert, update, delete, truncate on public.%I from public, anon, authenticated, mas_radar_app, '
      || 'mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      v_name
    );
    execute format(
      'grant select on public.%I to mas_radar_app, mas_radar_viewer, mas_radar_finance_operator, '
      || 'mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      v_name
    );
  end loop;
end $$;

-- ── 7) 5-Katmanlı RLS Politikaları ve GRANT Tanımları ────────────────────────────────────────
-- 7a) management_accounts -> reference sınıfı (SELECT: 5 katman; INSERT/UPDATE/DELETE: manager, admin)
alter table public.management_accounts enable row level security;

revoke all on public.management_accounts from public, anon, authenticated, mas_radar_app;
grant select on table public.management_accounts to
  mas_radar_viewer,
  mas_radar_finance_operator,
  mas_radar_finance_approver,
  mas_radar_finance_manager,
  mas_radar_admin;
grant insert, update, delete on table public.management_accounts to
  mas_radar_finance_manager,
  mas_radar_admin;

drop policy if exists management_accounts_tier_select on public.management_accounts;
create policy management_accounts_tier_select on public.management_accounts
  for select to
    mas_radar_viewer,
    mas_radar_finance_operator,
    mas_radar_finance_approver,
    mas_radar_finance_manager,
    mas_radar_admin
  using (true);

drop policy if exists management_accounts_tier_insert on public.management_accounts;
create policy management_accounts_tier_insert on public.management_accounts
  for insert to
    mas_radar_finance_manager,
    mas_radar_admin
  with check (true);

drop policy if exists management_accounts_tier_update on public.management_accounts;
create policy management_accounts_tier_update on public.management_accounts
  for update to
    mas_radar_finance_manager,
    mas_radar_admin
  using (true)
  with check (true);

drop policy if exists management_accounts_tier_delete on public.management_accounts;
create policy management_accounts_tier_delete on public.management_accounts
  for delete to
    mas_radar_finance_manager,
    mas_radar_admin
  using (true);

-- 7b) management_journal_entries & management_journal_lines -> operational sınıfı
grant usage, select on sequence public.management_journal_entries_entry_no_seq to
  mas_radar_finance_operator,
  mas_radar_finance_approver,
  mas_radar_finance_manager,
  mas_radar_admin;

do $$
declare
  t text;
begin
  foreach t in array array[
    'management_journal_entries',
    'management_journal_lines'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, mas_radar_app', t);

    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, '
      || 'mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      t
    );
    execute format(
      'grant insert, update on table public.%I to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin',
      t
    );
    execute format(
      'grant delete on table public.%I to mas_radar_finance_manager, mas_radar_admin',
      t
    );

    execute format('drop policy if exists %I on public.%I', t || '_tier_select', t);
    execute format(
      'create policy %I on public.%I for select to '
      || 'mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin '
      || 'using (true)',
      t || '_tier_select', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_tier_insert', t);
    execute format(
      'create policy %I on public.%I for insert to '
      || 'mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin '
      || 'with check (true)',
      t || '_tier_insert', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_tier_update', t);
    execute format(
      'create policy %I on public.%I for update to '
      || 'mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin '
      || 'using (true) with check (true)',
      t || '_tier_update', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_tier_delete', t);
    execute format(
      'create policy %I on public.%I for delete to '
      || 'mas_radar_finance_manager, mas_radar_admin '
      || 'using (true)',
      t || '_tier_delete', t
    );
  end loop;
end $$;

-- finance_approver için taslak (draft) manuel tahakkuk fişlerini onaylama (posted) dar politikası
grant update on table public.management_journal_entries to mas_radar_finance_approver;

drop policy if exists management_journal_entries_approver_post on public.management_journal_entries;
create policy management_journal_entries_approver_post on public.management_journal_entries
  for update to mas_radar_finance_approver
  using (status = 'draft')
  with check (status = 'posted');
