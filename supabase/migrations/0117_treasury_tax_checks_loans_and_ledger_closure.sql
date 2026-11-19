-- 0117 — Faz 60 (M-23..M-43): Hazine POS/Kart/Vadeli/Virman, Vergi & SGK Tahakkuku,
-- Türk Çek/Senet (121/321 & Faktoring), Tam Kredi Amortisman/TLREF/Leasing/Adat, Teminat Mektubu,
-- Canlı Döviz Pozisyonu (live_fx_exposure_v) ve KDV Hariç (net_amount) Bütçe/Kârlılık Kapanışı.
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Sıfır kayan nokta (yalnız numeric); tüm yeni FK kolonları B-tree indeks taşır.

-- ── 1) TDHP Eksik Hesap Planı Tohumları (108, 102.05, 102.99, 121, 128, 129, 301, 302, 321, 654, 910, 911) ─
insert into public.management_accounts
  (code, name, parent_code, account_class, normal_side, ebitda_bucket, tdhp_root_code)
values
  ('102.05', 'Vadeli Banka Mevduatları',                 '102', 'asset',                'debit',  'balance_sheet', '102'),
  ('102.99', 'Banka Geçici Mutabakat Hesabı',            '102', 'asset',                'debit',  'balance_sheet', '102'),
  ('108',    'Diğer Hazır Değerler (POS Blokaj)',        null,  'asset',                'debit',  'balance_sheet', '108'),
  ('121',    'Alacak Senetleri',                         null,  'asset',                'debit',  'balance_sheet', '121'),
  ('128',    'Şüpheli Ticari Alacaklar',                 null,  'asset',                'debit',  'balance_sheet', '128'),
  ('129',    'Şüpheli Ticari Alacaklar Karşılığı (-)',   null,  'asset',                'credit', 'balance_sheet', '129'),
  ('150',    'İlk Madde ve Malzeme Stokları',            null,  'asset',                'debit',  'balance_sheet', '150'),
  ('151',    'Yarı Mamuller - Üretim',                   null,  'asset',                'debit',  'balance_sheet', '151'),
  ('152',    'Mamuller',                                 null,  'asset',                'debit',  'balance_sheet', '152'),
  ('253',    'Tesis, Makine ve Cihazlar',                null,  'asset',                'debit',  'balance_sheet', '253'),
  ('257',    'Birikmiş Amortismanlar (-)',               null,  'asset',                'credit', 'balance_sheet', '257'),
  ('301',    'Finansal Kiralama İşlemlerinden Borçlar',  null,  'liability',            'credit', 'balance_sheet', '301'),
  ('302',    'Ertelenmiş Finansal Kiralama Maliyetleri', null,  'liability',            'debit',  'balance_sheet', '302'),
  ('309',    'Diğer Mali Borçlar (Kurumsal Kartlar)',    null,  'liability',            'credit', 'balance_sheet', '309'),
  ('321',    'Borç Senetleri',                           null,  'liability',            'credit', 'balance_sheet', '321'),
  ('620',    'Satılan Mamuller Maliyeti (-)',            null,  'cogs',                 'debit',  'cogs',          '620'),
  ('631',    'Pazarlama Satış ve Dağıtım Giderleri (-)', null,  'opex',                 'debit',  'opex',          '631'),
  ('632',    'Genel Yönetim Giderleri (-)',              null,  'opex',                 'debit',  'opex',          '632'),
  ('654',    'Karşılık Giderleri (-)',                   null,  'other_income_expense', 'debit',  'non_operating', '654'),
  ('710',    'Direkt İlk Madde ve Malzeme Giderleri',    null,  'cogs',                 'debit',  'cogs',          '710'),
  ('711',    'Direkt İlk Madde ve Malzeme Yansıtma',     null,  'cogs',                 'credit', 'cogs',          '711'),
  ('720',    'Direkt İşçilik Giderleri',                 null,  'cogs',                 'debit',  'cogs',          '720'),
  ('721',    'Direkt İşçilik Giderleri Yansıtma',        null,  'cogs',                 'credit', 'cogs',          '721'),
  ('731',    'Genel Üretim Giderleri Yansıtma',          null,  'cogs',                 'credit', 'cogs',          '731'),
  ('760',    'Pazarlama Satış ve Dağıtım Giderleri',     null,  'opex',                 'debit',  'opex',          '760'),
  ('761',    'Pazarlama Satış ve Dağıtım Yansıtma',      null,  'opex',                 'credit', 'opex',          '761'),
  ('771',    'Genel Yönetim Giderleri Yansıtma',         null,  'opex',                 'credit', 'opex',          '771'),
  ('781',    'Finansman Giderleri Yansıtma',             null,  'finance_expense',      'credit', 'financing',     '781'),
  ('910',    'Verilen Teminat Mektupları Nazım Hesabı',  null,  'off_balance',          'debit',  'balance_sheet', '910'),
  ('911',    'Verilen Teminat Mektupları Alacaklıları',  null,  'off_balance',          'credit', 'balance_sheet', '911')
on conflict (code) do update
  set name           = excluded.name,
      parent_code    = excluded.parent_code,
      account_class  = excluded.account_class,
      normal_side    = excluded.normal_side,
      ebitda_bucket  = excluded.ebitda_bucket,
      tdhp_root_code = excluded.tdhp_root_code;

-- management_journal_entries.source_type genişletmesi
do $$
declare
  v_attnum smallint;
  r record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.management_journal_entries'::regclass
     and a.attname = 'source_type'
     and not a.attisdropped;

  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.management_journal_entries'::regclass
       and c.contype = 'c'
       and c.conkey = array[v_attnum]
  loop
    execute format('alter table public.management_journal_entries drop constraint %I', r.conname);
  end loop;

  alter table public.management_journal_entries
    add constraint management_journal_entries_source_type_check
    check (source_type in (
      'invoice',
      'bank_transaction',
      'check_bordro',
      'loan_installment',
      'loan_disbursement',
      'facility_movement',
      'interbank_transfer',
      'counterparty_offset',
      'doubtful_provision',
      'period_closing',
      'payroll_tax_accrual',
      'production_movement',
      'payment_instance',
      'manual_adjustment',
      'fx_revaluation',
      'reversal',
      'opening_balance'
    ));
end $$;

-- ── 2) POS Valör, Kurumsal Kart, Bordro/Vergi, Vadeli Mevduat ve Virman Tabloları ─────────────
create table if not exists public.pos_settlement_batches (
  id uuid primary key default gen_random_uuid(),
  cash_account_id uuid not null references public.cash_accounts(id) on delete cascade,
  pos_terminal_label text not null check (btrim(pos_terminal_label) <> ''),
  sale_date date not null,
  expected_value_date date not null,
  gross_amount numeric(14,2) not null check (gross_amount >= 0),
  commission_rate numeric(6,4) not null default 0 check (commission_rate >= 0 and commission_rate <= 1),
  commission_amount numeric(14,2) not null default 0 check (commission_amount >= 0),
  net_settlement_amount numeric(14,2) not null check (net_settlement_amount >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  is_settled boolean not null default false,
  settled_at timestamptz,
  settled_bank_txn_id uuid references public.bank_transactions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pos_batches_cash_account_id on public.pos_settlement_batches (cash_account_id);
create index if not exists idx_pos_batches_settled_txn on public.pos_settlement_batches (settled_bank_txn_id) where settled_bank_txn_id is not null;
create index if not exists idx_pos_batches_value_date on public.pos_settlement_batches (expected_value_date) where is_settled = false;

create table if not exists public.corporate_card_statements (
  id uuid primary key default gen_random_uuid(),
  card_account_id uuid not null references public.cash_accounts(id) on delete cascade,
  pay_from_account_id uuid references public.cash_accounts(id) on delete set null,
  statement_month date not null check (statement_month = date_trunc('month', statement_month)::date),
  cutoff_date date not null,
  due_date date not null,
  statement_amount numeric(14,2) not null check (statement_amount >= 0),
  minimum_payment_amount numeric(14,2) check (minimum_payment_amount is null or minimum_payment_amount >= 0),
  paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  is_settled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (card_account_id, statement_month)
);

create index if not exists idx_corp_card_pay_from on public.corporate_card_statements (pay_from_account_id) where pay_from_account_id is not null;
create index if not exists idx_corp_card_due_date on public.corporate_card_statements (due_date) where is_settled = false;

create table if not exists public.payroll_tax_accruals (
  id uuid primary key default gen_random_uuid(),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  obligation_kind text not null check (obligation_kind in ('NET_MAAS', 'MPHB_STOPAJ', 'SGK_4A', 'DAMGA_VERGISI', 'KURUMLAR_GECICI_VERGI')),
  due_date date not null,
  accrued_amount numeric(14,2) not null check (accrued_amount >= 0),
  paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  department_id uuid references public.departments(id) on delete set null,
  cost_center_id uuid references public.cost_centers(id) on delete set null,
  journal_entry_id uuid references public.management_journal_entries(id) on delete set null,
  is_paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_month, obligation_kind)
);

create index if not exists idx_payroll_tax_dept on public.payroll_tax_accruals (department_id) where department_id is not null;
create index if not exists idx_payroll_tax_cc on public.payroll_tax_accruals (cost_center_id) where cost_center_id is not null;
create index if not exists idx_payroll_tax_je on public.payroll_tax_accruals (journal_entry_id) where journal_entry_id is not null;

create table if not exists public.term_deposits (
  id uuid primary key default gen_random_uuid(),
  cash_account_id uuid not null references public.cash_accounts(id) on delete cascade,
  deposit_name text not null check (btrim(deposit_name) <> ''),
  principal_amount numeric(14,2) not null check (principal_amount > 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  annual_interest_rate numeric(7,4) not null check (annual_interest_rate >= 0),
  withholding_tax_rate numeric(6,4) not null default 0.0750 check (withholding_tax_rate >= 0 and withholding_tax_rate <= 1),
  start_date date not null,
  maturity_date date not null check (maturity_date >= start_date),
  expected_net_interest numeric(14,2) not null default 0 check (expected_net_interest >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_term_deposits_account on public.term_deposits (cash_account_id);

create table if not exists public.interbank_transfers (
  id uuid primary key default gen_random_uuid(),
  from_account_id uuid not null references public.cash_accounts(id) on delete restrict,
  to_account_id uuid not null references public.cash_accounts(id) on delete restrict,
  transfer_date date not null default current_date,
  from_amount numeric(14,2) not null check (from_amount > 0),
  from_currency text not null default 'TRY' check (from_currency ~ '^[A-Z]{3}$'),
  to_amount numeric(14,2) not null check (to_amount > 0),
  to_currency text not null default 'TRY' check (to_currency ~ '^[A-Z]{3}$'),
  fx_rate numeric(14,6) not null default 1 check (fx_rate > 0),
  fee_amount numeric(14,2) not null default 0 check (fee_amount >= 0),
  outflow_bank_txn_id uuid references public.bank_transactions(id) on delete set null,
  inflow_bank_txn_id uuid references public.bank_transactions(id) on delete set null,
  journal_entry_id uuid references public.management_journal_entries(id) on delete set null,
  description text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);

create index if not exists idx_interbank_from_acct on public.interbank_transfers (from_account_id);
create index if not exists idx_interbank_to_acct on public.interbank_transfers (to_account_id);
create index if not exists idx_interbank_out_txn on public.interbank_transfers (outflow_bank_txn_id) where outflow_bank_txn_id is not null;
create index if not exists idx_interbank_in_txn on public.interbank_transfers (inflow_bank_txn_id) where inflow_bank_txn_id is not null;
create index if not exists idx_interbank_je on public.interbank_transfers (journal_entry_id) where journal_entry_id is not null;
create index if not exists idx_interbank_created_by on public.interbank_transfers (created_by) where created_by is not null;

-- ── 3) Çek/Senet Kanunu, Faktoring, Kredi Amortisman/TLREF/Leasing & Teminat Mektubu ──────────
alter table public.checks
  add column if not exists issue_date date,
  add column if not exists issue_place text,
  add column if not exists drawer_tax_no text,
  add column if not exists discount_fee_amount numeric(14,2) check (discount_fee_amount is null or discount_fee_amount >= 0),
  add column if not exists factored_at timestamptz,
  add column if not exists settled_bank_txn_id uuid references public.bank_transactions(id) on delete set null;

create index if not exists idx_checks_settled_bank_txn_id
  on public.checks (settled_bank_txn_id) where settled_bank_txn_id is not null;

alter table public.loans
  add column if not exists loan_kind text not null default 'installment'
    check (loan_kind in ('spot', 'installment', 'revolving', 'leasing')),
  add column if not exists interest_type text not null default 'fixed'
    check (interest_type in ('fixed', 'floating_tlref', 'floating_sofr', 'floating_euribor')),
  add column if not exists reference_rate_pct numeric(7,4) check (reference_rate_pct is null or reference_rate_pct >= 0),
  add column if not exists spread_bps int check (spread_bps is null or spread_bps >= 0),
  add column if not exists bsmv_rate numeric(6,4) not null default 0.0500 check (bsmv_rate >= 0 and bsmv_rate <= 1),
  add column if not exists kkdf_rate numeric(6,4) not null default 0.0000 check (kkdf_rate >= 0 and kkdf_rate <= 1),
  add column if not exists disbursement_account_id uuid references public.cash_accounts(id) on delete set null,
  add column if not exists opening_journal_entry_id uuid references public.management_journal_entries(id) on delete set null;

create index if not exists idx_loans_disbursement_account_id
  on public.loans (disbursement_account_id) where disbursement_account_id is not null;
create index if not exists idx_loans_opening_journal_entry_id
  on public.loans (opening_journal_entry_id) where opening_journal_entry_id is not null;

alter table public.loan_installments
  add column if not exists bsmv_component numeric(14,2) check (bsmv_component is null or bsmv_component >= 0),
  add column if not exists kkdf_component numeric(14,2) check (kkdf_component is null or kkdf_component >= 0);

create table if not exists public.letter_of_guarantees (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid references public.credit_facilities(id) on delete set null,
  beneficiary_party_id uuid references public.parties(id) on delete set null,
  beneficiary_name text not null check (btrim(beneficiary_name) <> ''),
  guarantee_type text not null default 'kesin'
    check (guarantee_type in ('gecici', 'kesin', 'avans', 'gumruk', 'mahkeme', 'diger')),
  reference_no text not null check (btrim(reference_no) <> ''),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  commission_rate_annual numeric(6,4) not null default 0.0150 check (commission_rate_annual >= 0 and commission_rate_annual <= 1),
  quarterly_commission_amount numeric(14,2) not null default 0 check (quarterly_commission_amount >= 0),
  issue_date date not null default current_date,
  expiry_date date,
  is_active boolean not null default true,
  returned_at date,
  journal_entry_id uuid references public.management_journal_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_lg_facility_id on public.letter_of_guarantees (facility_id) where facility_id is not null;
create index if not exists idx_lg_beneficiary_party_id on public.letter_of_guarantees (beneficiary_party_id) where beneficiary_party_id is not null;
create index if not exists idx_lg_journal_entry_id on public.letter_of_guarantees (journal_entry_id) where journal_entry_id is not null;

create table if not exists public.facility_interest_accruals (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.credit_facilities(id) on delete cascade,
  accrual_month date not null check (accrual_month = date_trunc('month', accrual_month)::date),
  average_utilized_balance numeric(14,2) not null check (average_utilized_balance >= 0),
  days_in_period int not null check (days_in_period between 1 and 31),
  annual_rate_pct numeric(7,4) not null check (annual_rate_pct >= 0),
  interest_amount numeric(14,2) not null check (interest_amount >= 0),
  bsmv_amount numeric(14,2) not null default 0 check (bsmv_amount >= 0),
  kkdf_amount numeric(14,2) not null default 0 check (kkdf_amount >= 0),
  total_charge numeric(14,2) not null check (total_charge >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  journal_entry_id uuid references public.management_journal_entries(id) on delete set null,
  is_settled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (facility_id, accrual_month)
);

create index if not exists idx_facility_accruals_je on public.facility_interest_accruals (journal_entry_id) where journal_entry_id is not null;

-- ── 4) Canlı Döviz Pozisyonu Görünümü (live_fx_exposure_v — security_invoker = true) ──────────
create or replace view public.live_fx_exposure_v
with (security_invoker = true) as
with fx_items as (
  -- 1. Yabancı para kasa ve banka bakiyeleri
  select
    ca.currency,
    'cash_bank'::text as bucket,
    'asset'::text as side,
    coalesce(ca.opening_balance, 0) + coalesce((
      select sum(bt.amount)
      from public.bank_transactions bt
      where bt.bank_account_id = ca.id
        and bt.status <> 'ignored'
    ), 0) as native_amount
  from public.cash_accounts ca
  where ca.currency <> 'TRY'
    and ca.is_active = true

  union all

  -- 2. Açık yabancı para satış ve alış faturaları
  select
    v.currency,
    case when v.direction = 'sales' then 'open_receivables' else 'open_payables' end as bucket,
    case when v.direction = 'sales' then 'asset' else 'liability' end as side,
    greatest(0, coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.paid_amount, 0), coalesce(v.allocated_amount, 0))) as native_amount
  from public.invoices v
  where v.currency <> 'TRY'
    and v.status in ('open', 'partial')

  union all

  -- 3. Açık yabancı para çek ve senetler
  select
    c.currency,
    case when c.direction = 'inflow' then 'checks_receivable' else 'checks_payable' end as bucket,
    case when c.direction = 'inflow' then 'asset' else 'liability' end as side,
    coalesce(c.amount, 0) as native_amount
  from public.checks c
  where c.currency <> 'TRY'
    and c.archived_at is null
    and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')

  union all

  -- 4. Açık yabancı para kredi taksitleri
  select
    l.currency,
    'loan_debt'::text as bucket,
    'liability'::text as side,
    coalesce(li.principal_component, li.amount, 0) as native_amount
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  where l.currency <> 'TRY'
    and l.archived_at is null
    and li.status in ('planned', 'late', 'partial')

  union all

  -- 5. Manuel / türev forward ve hedge kayıtları (fx_positions)
  select
    fp.currency,
    'hedge_or_manual'::text as bucket,
    case when fp.amount >= 0 then 'asset' else 'liability' end as side,
    abs(fp.amount) as native_amount
  from public.fx_positions fp
  where fp.currency <> 'TRY'
    and fp.is_active = true
),
latest_rates as (
  select distinct on (r.base_currency)
    r.base_currency as currency,
    r.rate as spot_rate_to_try,
    r.rate_date
  from public.fx_rate_snapshots r
  where r.quote_currency = 'TRY'
  order by r.base_currency, r.rate_date desc, r.fetched_at desc
)
select
  i.currency,
  coalesce(sum(i.native_amount) filter (where i.side = 'asset'), 0)::numeric(14,2) as total_assets_native,
  coalesce(sum(i.native_amount) filter (where i.side = 'liability'), 0)::numeric(14,2) as total_liabilities_native,
  (
    coalesce(sum(i.native_amount) filter (where i.side = 'asset'), 0)
    - coalesce(sum(i.native_amount) filter (where i.side = 'liability'), 0)
  )::numeric(14,2) as net_position_native,
  coalesce(sum(i.native_amount) filter (where i.bucket = 'cash_bank'), 0)::numeric(14,2) as cash_bank_native,
  coalesce(sum(i.native_amount) filter (where i.bucket = 'open_receivables'), 0)::numeric(14,2) as receivables_native,
  coalesce(sum(i.native_amount) filter (where i.bucket = 'open_payables'), 0)::numeric(14,2) as payables_native,
  coalesce(sum(i.native_amount) filter (where i.bucket in ('checks_receivable', 'checks_payable') and i.side = 'liability'), 0)::numeric(14,2) as checks_payable_native,
  coalesce(sum(i.native_amount) filter (where i.bucket = 'loan_debt'), 0)::numeric(14,2) as loan_debt_native,
  coalesce(sum(i.native_amount) filter (where i.bucket = 'hedge_or_manual'), 0)::numeric(14,2) as hedge_native,
  lr.spot_rate_to_try,
  lr.rate_date,
  case
    when lr.spot_rate_to_try is null then null::numeric
    else round((
      coalesce(sum(i.native_amount) filter (where i.side = 'asset'), 0)
      - coalesce(sum(i.native_amount) filter (where i.side = 'liability'), 0)
    ) * lr.spot_rate_to_try, 2)
  end as net_position_try
from fx_items i
left join latest_rates lr on lr.currency = i.currency
group by i.currency, lr.spot_rate_to_try, lr.rate_date;

revoke insert, update, delete, truncate on table public.live_fx_exposure_v
  from public, anon, authenticated, mas_radar_app,
       mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
       mas_radar_finance_manager, mas_radar_admin;
grant select on table public.live_fx_exposure_v
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

-- ── 5) KDV Hariç (net_amount) Bütçe ve Kârlılık Görünümleri (M-24, M-43) ──────────────────────
-- Not: Faturada net_amount varsa KDV hariç net tutar kullanılır; yalnız eski kayıtlarda net_amount
-- NULL ise gross_amount - coalesce(tax_amount, 0) geri-düşüşü çalışır (phase30 net=gross ile tam uyumlu).
create or replace view public.costing_invoice_facts
with (security_invoker = true) as
  select
    v.id                                                                 as invoice_id,
    v.party_id,
    v.direction,
    date_trunc('month', v.issue_date)::date                              as period_start,
    v.currency,
    v.cost_center_id,
    v.project_id,
    coalesce(v.net_amount, v.gross_amount - coalesce(v.tax_amount, 0))::numeric(14,2) as gross_amount,
    v.status,
    v.department_id
  from public.invoices v
  where v.status <> 'cancelled'
    and v.issue_date is not null
    and coalesce(v.net_amount, v.gross_amount) is not null;

create or replace view public.budget_actuals_monthly
with (security_invoker = true) as
  select
    date_trunc('month', v.issue_date)::date                              as period_start,
    case when v.direction = 'sales' then 'income' else 'expense' end     as direction,
    v.cost_center_id,
    v.project_id,
    v.currency,
    sum(coalesce(v.net_amount, v.gross_amount - coalesce(v.tax_amount, 0))) as actual_amount,
    count(*)                                                             as document_count,
    v.department_id
  from public.invoices v
  where v.status <> 'cancelled'
    and v.issue_date is not null
    and coalesce(v.net_amount, v.gross_amount) is not null
  group by 1, 2, v.cost_center_id, v.project_id, v.currency, v.department_id;

create or replace view public.budget_vs_actual
with (security_invoker = true) as
  with expanded_lines as (
    select
      b.id                                    as budget_id,
      b.name                                  as budget_name,
      b.fiscal_year,
      b.period_kind,
      l.id                                    as budget_line_id,
      case
        when b.period_kind = 'annual' then make_date(b.fiscal_year, gs.m, 1)
        else l.period_start
      end                                     as period_start,
      l.direction,
      l.cost_center_id,
      l.department_id,
      l.project_id,
      l.category_id,
      l.currency,
      (case
        when b.period_kind = 'annual' and gs.m < 12 then round(l.amount / 12.0, 2)
        when b.period_kind = 'annual' and gs.m = 12 then l.amount - (round(l.amount / 12.0, 2) * 11)
        else l.amount
      end)::numeric(14,2)                     as budget_amount
    from public.budget_lines l
    join public.budgets b on b.id = l.budget_id
    cross join lateral (
      select m
      from generate_series(1, case when b.period_kind = 'annual' then 12 else 1 end) as m
    ) gs
    where l.version_status = 'approved'
  )
  select
    el.budget_id,
    el.budget_name,
    el.fiscal_year,
    el.budget_line_id,
    el.period_start,
    el.direction,
    el.cost_center_id,
    cc.name                                   as cost_center_name,
    el.department_id,
    d.name                                    as department_name,
    el.project_id,
    p.name                                    as project_name,
    el.category_id,
    el.currency,
    el.budget_amount,
    act.actual_amount,
    case
      when act.actual_amount is null then null::numeric
      else act.actual_amount - el.budget_amount
    end                                       as variance_amount,
    case
      when act.actual_amount is null or el.budget_amount = 0 then null::numeric
      else round((act.actual_amount - el.budget_amount) / el.budget_amount, 4)
    end                                       as variance_ratio,
    case
      when act.actual_amount is null then 'not_measured'
      when el.direction = 'expense' and act.actual_amount > el.budget_amount then 'over_budget'
      when el.direction = 'expense' then 'within_budget'
      when act.actual_amount < el.budget_amount then 'under_target'
      else 'on_or_above_target'
    end                                       as variance_verdict,
    (el.department_id is not null)            as department_scoped,
    el.period_kind
  from expanded_lines el
  left join public.cost_centers cc on cc.id = el.cost_center_id
  left join public.departments d on d.id = el.department_id
  left join public.projects p on p.id = el.project_id
  left join lateral (
    select
      case
        when el.category_id is not null then (
          select sum(coalesce(pi.paid_amount, pi.amount))
          from public.payment_instances pi
          join public.payments pay on pay.id = pi.payment_id
          where pi.status in ('paid', 'partial')
            and coalesce(pi.paid_amount, pi.amount) is not null
            and date_trunc('month', pi.due_date)::date = el.period_start
            and (case when coalesce(pi.direction, 'outflow') = 'inflow' then 'income' else 'expense' end) = el.direction
            and pi.currency = el.currency
            and pay.category_id = el.category_id
            and (el.cost_center_id is null or pay.cost_center_id = el.cost_center_id)
            and (el.project_id is null or pay.project_id = el.project_id)
            and (el.department_id is null or pay.department_id = el.department_id)
        )
        else (
          select
            case
              when inv_part.s is null and pta_part.s is null then null::numeric
              else coalesce(inv_part.s, 0) + coalesce(pta_part.s, 0)
            end
          from (
            select sum(coalesce(v.net_amount, v.gross_amount - coalesce(v.tax_amount, 0))) as s
            from public.invoices v
            where v.status <> 'cancelled'
              and v.issue_date is not null
              and coalesce(v.net_amount, v.gross_amount) is not null
              and date_trunc('month', v.issue_date)::date = el.period_start
              and (case when v.direction = 'sales' then 'income' else 'expense' end) = el.direction
              and v.currency = el.currency
              and (el.cost_center_id is null or v.cost_center_id = el.cost_center_id)
              and (el.project_id is null or v.project_id = el.project_id)
              and (el.department_id is null or v.department_id = el.department_id)
          ) inv_part
          cross join (
            select
              case
                when el.direction = 'expense' then (
                  select sum(pta.accrued_amount)
                  from public.payroll_tax_accruals pta
                  where pta.period_month = el.period_start
                    and pta.currency = el.currency
                    and (el.cost_center_id is null or pta.cost_center_id = el.cost_center_id)
                    and (el.department_id is null or pta.department_id = el.department_id)
                )
                else null::numeric
              end as s
          ) pta_part
        )
      end as actual_amount
  ) act on true;

do $$
declare
  vw text;
begin
  foreach vw in array array['costing_invoice_facts', 'budget_actuals_monthly', 'budget_vs_actual'] loop
    execute format(
      'revoke insert, update, delete, truncate on table public.%I from public, anon, authenticated, mas_radar_app, '
      || 'mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      vw
    );
    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      vw
    );
  end loop;
end $$;

-- ── 6) 5-Katman RLS & GRANT Kalkanı (operational tablolar) ────────────────────────────────────
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'pos_settlement_batches',
    'corporate_card_statements',
    'payroll_tax_accruals',
    'term_deposits',
    'interbank_transfers',
    'letter_of_guarantees',
    'facility_interest_accruals'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from public, anon, authenticated, mas_radar_app', tbl);
    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant insert, update on table public.%I to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant delete on table public.%I to mas_radar_finance_manager, mas_radar_admin',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_select_all_tiers', tbl);
    execute format(
      'create policy %I on public.%I for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_select_all_tiers', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_insert_enter', tbl);
    execute format(
      'create policy %I on public.%I for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true)',
      tbl || '_insert_enter', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_update_enter', tbl);
    execute format(
      'create policy %I on public.%I for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin using (true) with check (true)',
      tbl || '_update_enter', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_delete_manage', tbl);
    execute format(
      'create policy %I on public.%I for delete to mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_delete_manage', tbl
    );
  end loop;
end $$;
