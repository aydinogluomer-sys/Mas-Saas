-- 0104 — Faz 51 (E1): Paraşüt API v4 kaynak soykütüğü (integration_sync_runs,
-- integration_raw_payloads, integration_entity_links, integration_account_mappings,
-- integration_staged_parties), fatura tevkifat/stopaj/ödenecek net ve satırsız gider fişi
-- (BLANK ≠ ZERO) genişletmeleri, invoices_external_key_uq benzersiz indeksi (S-1) ve
-- banka own_transfer / çapraz-kanal tekilleştirme (cross_channel_dedupe_hash) alanları.
--
-- Kurallar:
--   * Üst-seviye işlem komutu ve eşzamanlı indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric); tüm görünümler WITH (security_invoker = true) taşır.
--   * Kanıt (evidence) sınıfındaki integration_raw_payloads tablosu append-only tetikleyiciyle korunur.

-- ── 1) API Senkronizasyon Koşuları: public.integration_sync_runs (operational) ─────────────────
create table if not exists public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.integration_connections(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  watermark_from timestamptz,
  watermark_to timestamptz,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  fetched_count integer not null default 0 check (fetched_count >= 0),
  upserted_count integer not null default 0 check (upserted_count >= 0),
  staged_party_count integer not null default 0 check (staged_party_count >= 0),
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_integration_sync_runs_integration
  on public.integration_sync_runs (integration_id, started_at desc);

drop trigger if exists integration_sync_runs_updated_at on public.integration_sync_runs;
create trigger integration_sync_runs_updated_at
  before update on public.integration_sync_runs
  for each row execute function public.set_updated_at();

-- ── 2) Ham API JSON Kanıt Kasası: public.integration_raw_payloads (evidence — append-only) ─────
create table if not exists public.integration_raw_payloads (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid not null references public.integration_sync_runs(id) on delete restrict,
  resource_type text not null check (btrim(resource_type) <> ''),
  external_id text not null check (btrim(external_id) <> ''),
  external_updated_at timestamptz,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_json jsonb not null,
  fetched_at timestamptz not null default now(),

  unique (resource_type, external_id, payload_sha256)
);

create index if not exists idx_integration_raw_payloads_sync_run
  on public.integration_raw_payloads (sync_run_id);
create index if not exists idx_integration_raw_payloads_lookup
  on public.integration_raw_payloads (resource_type, external_id, fetched_at desc);

create or replace function public.integration_raw_payloads_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'integration_raw_payloads append-only: ham entegrasyon JSON kanıtı değiştirilemez veya silinemez'
    using errcode = 'check_violation';
end $$;

drop trigger if exists integration_raw_payloads_no_update on public.integration_raw_payloads;
create trigger integration_raw_payloads_no_update
  before update on public.integration_raw_payloads
  for each row execute function public.integration_raw_payloads_append_only();

drop trigger if exists integration_raw_payloads_no_delete on public.integration_raw_payloads;
create trigger integration_raw_payloads_no_delete
  before delete on public.integration_raw_payloads
  for each row execute function public.integration_raw_payloads_append_only();

-- ── 3) Harici Kaynak ↔ Kanonik Varlık Bağları: public.integration_entity_links (operational) ───
create table if not exists public.integration_entity_links (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'parasut' check (btrim(provider) <> ''),
  resource_type text not null check (btrim(resource_type) <> ''),
  external_id text not null check (btrim(external_id) <> ''),
  entity_table text not null check (btrim(entity_table) <> ''),
  entity_id uuid not null,
  last_payload_id uuid references public.integration_raw_payloads(id) on delete restrict,
  last_synced_at timestamptz not null default now(),

  unique (provider, resource_type, external_id)
);

create index if not exists idx_integration_entity_links_entity
  on public.integration_entity_links (entity_table, entity_id);
create index if not exists idx_integration_entity_links_last_payload
  on public.integration_entity_links (last_payload_id)
  where last_payload_id is not null;

-- ── 4) Harici Hesap ↔ MAS Kasa/Banka Eşleme: public.integration_account_mappings (operational) ─
create table if not exists public.integration_account_mappings (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'parasut' check (btrim(provider) <> ''),
  external_account_id text not null check (btrim(external_account_id) <> ''),
  external_account_name text,
  external_iban text,
  external_currency text not null default 'TRY' check (external_currency ~ '^[A-Z]{3}$'),
  cash_account_id uuid references public.cash_accounts(id) on delete set null,
  bank_account_id uuid references public.bank_accounts(cash_account_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (provider, external_account_id)
);

create index if not exists idx_integration_account_mappings_cash
  on public.integration_account_mappings (cash_account_id)
  where cash_account_id is not null;
create index if not exists idx_integration_account_mappings_bank
  on public.integration_account_mappings (bank_account_id)
  where bank_account_id is not null;

drop trigger if exists integration_account_mappings_updated_at on public.integration_account_mappings;
create trigger integration_account_mappings_updated_at
  before update on public.integration_account_mappings
  for each row execute function public.set_updated_at();

-- ── 5) Yeni Cari Aday İnceleme Kuyruğu: public.integration_staged_parties (operational) ────────
create table if not exists public.integration_staged_parties (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'parasut' check (btrim(provider) <> ''),
  external_contact_id text not null check (btrim(external_contact_id) <> ''),
  raw_name text not null check (btrim(raw_name) <> ''),
  tax_id text,
  iban text,
  account_type text,
  suggested_party_id uuid references public.parties(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'linked', 'created', 'ignored')),
  resolved_party_id uuid references public.parties(id) on delete set null,
  reviewed_by uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (provider, external_contact_id)
);

create index if not exists idx_integration_staged_parties_status
  on public.integration_staged_parties (status, created_at desc);
create index if not exists idx_integration_staged_parties_suggested
  on public.integration_staged_parties (suggested_party_id)
  where suggested_party_id is not null;
create index if not exists idx_integration_staged_parties_resolved
  on public.integration_staged_parties (resolved_party_id)
  where resolved_party_id is not null;
create index if not exists idx_integration_staged_parties_reviewed_by
  on public.integration_staged_parties (reviewed_by)
  where reviewed_by is not null;

drop trigger if exists integration_staged_parties_updated_at on public.integration_staged_parties;
create trigger integration_staged_parties_updated_at
  before update on public.integration_staged_parties
  for each row execute function public.set_updated_at();

-- ── 6) public.invoices genişletmesi (S-1, S-4, S-5, S-6, S-7) ──────────────────────────────────
-- Satırsız basit gider fişlerinde net_amount ve tax_amount bilinmeyebilir (BLANK ≠ ZERO).
-- Kısıt: ya ikisi de NULL'dır (yalnız gross_amount bilinir) ya da ikisi de dolu olup gross = net + tax'tır.
alter table public.invoices
  alter column net_amount drop not null,
  alter column tax_amount drop not null;

alter table public.invoices
  drop constraint if exists invoices_gross_is_net_plus_tax;

alter table public.invoices
  add constraint invoices_gross_is_net_plus_tax
  check (
    (net_amount is null and tax_amount is null)
    or (net_amount is not null and tax_amount is not null and gross_amount = net_amount + tax_amount)
  );

alter table public.invoices
  add column if not exists withholding_amount numeric(14,2)
    check (withholding_amount is null or withholding_amount >= 0),
  add column if not exists vat_withholding_amount numeric(14,2)
    check (vat_withholding_amount is null or vat_withholding_amount >= 0),
  add column if not exists payable_amount numeric(14,2)
    check (payable_amount is null or (payable_amount >= 0 and payable_amount <= gross_amount)),
  add column if not exists external_status text,
  add column if not exists external_key text,
  add column if not exists spender_employee_name text;

create unique index if not exists invoices_external_key_uq
  on public.invoices (external_key)
  where external_key is not null;

-- Düzenlenmiş fatura içerik değişmezlik muhafızını yeni ticari tutar kolonlarıyla güncelle
create or replace function public.invoices_content_immutability_guard() returns trigger
language plpgsql as $$
begin
  if old.status = 'draft' then
    return new;
  end if;
  if new.direction              is distinct from old.direction
     or new.invoice_no             is distinct from old.invoice_no
     or new.party_id               is distinct from old.party_id
     or new.issue_date             is distinct from old.issue_date
     or new.due_date               is distinct from old.due_date
     or new.currency               is distinct from old.currency
     or new.net_amount             is distinct from old.net_amount
     or new.tax_amount             is distinct from old.tax_amount
     or new.gross_amount           is distinct from old.gross_amount
     or new.withholding_amount     is distinct from old.withholding_amount
     or new.vat_withholding_amount is distinct from old.vat_withholding_amount
     or new.payable_amount         is distinct from old.payable_amount then
    raise exception
      'invoices.%: düzenlenmiş fatura içeriği değiştirilemez (durum=%). Düzeltme iptal+yeniden düzenleme ya da iade faturasıyla yapılır.',
      old.id, old.status;
  end if;
  return new;
end $$;

-- ── 7) public.bank_transactions genişletmesi (own_transfer & çapraz-kanal tekilleştirme) ────────
alter table public.bank_transactions
  add column if not exists transaction_kind text not null default 'standard'
    check (transaction_kind in ('standard', 'own_transfer', 'bank_fee', 'tax_payment', 'payroll')),
  add column if not exists cross_channel_dedupe_hash text;

create index if not exists idx_bank_transactions_cross_channel
  on public.bank_transactions (bank_account_id, cross_channel_dedupe_hash)
  where cross_channel_dedupe_hash is not null;

-- ── 8) Görünüm Güncellemeleri (payable_amount tevkifat uyumu & own_transfer konsolide filtresi) ─

-- daily_cash_movement: kendi hesaplarımız arası virmanlar (own_transfer) konsolide giriş/çıkışı şişirmez
create or replace view public.daily_cash_movement
with (security_invoker = true) as
  select
    bt.txn_date,
    ca.currency,
    coalesce(
      sum(bt.amount) filter (
        where bt.amount > 0
          and bt.currency = ca.currency
          and coalesce(bt.transaction_kind, 'standard') <> 'own_transfer'
      ),
      0
    )                                                                          as inflow,
    coalesce(
      sum(bt.amount) filter (
        where bt.amount < 0
          and bt.currency = ca.currency
          and coalesce(bt.transaction_kind, 'standard') <> 'own_transfer'
      ),
      0
    )                                                                          as outflow,
    sum(bt.amount) filter (where bt.currency = ca.currency)                    as net_movement,
    count(*)                                                                   as movement_count,
    sum(sum(bt.amount) filter (where bt.currency = ca.currency))
      over (partition by ca.currency order by bt.txn_date)                     as running_net,
    count(*) filter (where bt.currency <> ca.currency)                         as foreign_txn_count
  from public.bank_transactions bt
  join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
  join public.cash_accounts ca on ca.id = ba.cash_account_id
  where bt.status <> 'ignored'
  group by bt.txn_date, ca.currency;

-- working_capital_monthly_v: own_transfer konsolide aylık nakit giriş/çıkış toplamından düşülür
create or replace view public.working_capital_monthly_v
with (security_invoker = true) as
  with cash_months as (
    select
      date_trunc('month', t.txn_date)::date                                               as period_start,
      coalesce(
        sum(t.amount) filter (
          where t.direction = 'inflow'
            and t.currency = 'TRY'
            and coalesce(t.transaction_kind, 'standard') <> 'own_transfer'
        ),
        0
      )::numeric(14,2)                                                                    as cash_inflow_try,
      coalesce(
        sum(abs(t.amount)) filter (
          where t.direction = 'outflow'
            and t.currency = 'TRY'
            and coalesce(t.transaction_kind, 'standard') <> 'own_transfer'
        ),
        0
      )::numeric(14,2)                                                                    as cash_outflow_try,
      coalesce(
        sum(case when t.direction = 'inflow' then t.amount else -abs(t.amount) end)
          filter (where t.currency = 'TRY' and coalesce(t.transaction_kind, 'standard') <> 'own_transfer'),
        0
      )::numeric(14,2)                                                                    as cash_net_try,
      count(t.id) filter (where t.currency <> 'TRY')::int                                 as foreign_cash_tx_count
    from public.bank_transactions t
    where t.status <> 'ignored'
    group by 1
  ),
  all_periods as (
    select w.period_start from public.working_capital_trend w
    union
    select c.period_start from cash_months c
  )
  select
    p.period_start,
    coalesce(w.receivables_open, 0)::numeric(14,2)                                        as receivables_open,
    coalesce(w.payables_open, 0)::numeric(14,2)                                           as payables_open,
    (coalesce(w.receivables_open, 0) - coalesce(w.payables_open, 0))::numeric(14,2)       as net_working_capital_ex_inventory,
    w.dso_days,
    w.dpo_days,
    w.dio_days,
    w.cash_cycle_excluding_inventory,
    coalesce(c.cash_inflow_try, 0)::numeric(14,2)                                         as cash_inflow_try,
    coalesce(c.cash_outflow_try, 0)::numeric(14,2)                                        as cash_outflow_try,
    coalesce(c.cash_net_try, 0)::numeric(14,2)                                            as cash_net_try,
    coalesce(w.foreign_currency_count, 0)::int                                            as foreign_invoice_count,
    coalesce(c.foreign_cash_tx_count, 0)::int                                             as foreign_cash_tx_count
  from all_periods p
  left join public.working_capital_trend w on w.period_start = p.period_start
  left join cash_months c on c.period_start = p.period_start
  order by p.period_start desc;

-- liquidity_forecast_daily: fatura ayağında tevkifatlı payable_amount ve paid_amount/allocated_amount desteği
create or replace view public.liquidity_forecast_daily
with (security_invoker = true) as
  select
    pi.due_date                                   as flow_date,
    pi.currency                                   as currency,
    'payment_instance'::text                      as source_kind,
    pi.id                                         as source_id,
    case
      when pi.direction = 'inflow' then
        greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)
      else
        -greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)
    end                                           as amount_signed,
    'contracted'::text                            as certainty
  from public.payment_instances pi
  left join public.payments p on p.id = pi.payment_id
  where pi.status in ('planned', 'unpaid', 'partial', 'late')
    and (p.id is null or (p.status = 'active' and p.archived_at is null))
    and coalesce(pi.direction, 'outflow') <> 'transfer'
    and pi.currency is not null
    and pi.due_date is not null
    and pi.amount is not null

  union all

  select
    li.due_date,
    l.currency,
    'loan_installment'::text,
    li.id,
    -greatest(0, case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end),
    'contracted'::text
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  where l.archived_at is null
    and li.status in ('planned', 'unpaid', 'partial', 'late')
    and li.due_date is not null
    and li.amount is not null

  union all

  select
    c.maturity_date,
    c.currency,
    'check'::text,
    c.id,
    c.signed_amount,
    'contracted'::text
  from public.checks c
  where c.archived_at is null
    and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
    and c.maturity_date is not null
    and c.signed_amount is not null

  union all

  select
    v.due_date,
    v.currency,
    'invoice'::text,
    v.id,
    case
      when v.direction = 'sales'
        then (coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
      else -(coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
    end,
    'contracted'::text
  from public.invoices v
  where v.status in ('open', 'partial')
    and v.due_date is not null
    and v.gross_amount is not null
    and coalesce(v.payable_amount, v.gross_amount) > greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))
    and not (
      v.settled_by_check_id is not null
      and exists (
        select 1 from public.checks c0
        where c0.id = v.settled_by_check_id
          and c0.archived_at is null
          and c0.status <> 'cancelled'
      )
    )
    and not exists (
      select 1
      from public.payment_instances pi2
      left join public.payments p2 on p2.id = pi2.payment_id
      where pi2.linked_invoice_id = v.id
        and pi2.status <> 'cancelled'
        and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
    )
    and not exists (
      select 1
      from public.checks c2
      where c2.linked_invoice_id = v.id
        and c2.archived_at is null
        and c2.status <> 'cancelled'
    )

  union all

  select
    pr.promised_date,
    pr.currency,
    'promise_to_pay'::text,
    pr.id,
    pr.promised_amount,
    'expected'::text
  from public.promise_to_pay pr
  where pr.status = 'pending'
    and pr.promised_amount is not null
    and pr.currency is not null;

-- financial_calendar: liquidity_forecast_daily ile birebir aynı tevkifatlı payable_amount kuralı
create or replace view public.financial_calendar
with (security_invoker = true) as
  select
    'payment_instance'::text            as source_kind,
    i.id                                as source_id,
    i.due_date                          as event_date,
    coalesce(p.name, '(kalem)')         as label,
    c.name                              as category_name,
    pa.name                             as counterparty_name,
    case
      when i.direction = 'inflow' then
        greatest(0, case when i.status = 'partial' then i.amount - coalesce(i.paid_amount, 0) else i.amount end)
      else
        -greatest(0, case when i.status = 'partial' then i.amount - coalesce(i.paid_amount, 0) else i.amount end)
    end                                 as amount_signed,
    i.currency                          as currency,
    i.status                            as status,
    'contracted'::text                  as certainty
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  left join public.categories c on c.id = p.category_id
  left join public.parties pa on pa.id = p.provider_party_id
  where i.status in ('planned', 'unpaid', 'partial', 'late')
    and (p.id is null or (p.status = 'active' and p.archived_at is null))
    and coalesce(i.direction, 'outflow') <> 'transfer'
    and i.currency is not null
    and i.due_date is not null
    and i.amount is not null

  union all

  select
    'loan_installment'::text,
    li.id,
    li.due_date,
    coalesce(l.name, '(kredi)'),
    null::text,
    pl.name,
    -greatest(0, case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end),
    l.currency,
    li.status,
    'contracted'::text
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  left join public.parties pl on pl.id = l.lender_party_id
  where l.archived_at is null
    and li.status in ('planned', 'unpaid', 'partial', 'late')
    and li.due_date is not null
    and li.amount is not null

  union all

  select
    'check'::text,
    ch.id,
    ch.maturity_date,
    coalesce(ch.counterparty_label, '(çek)'),
    null::text,
    coalesce(pe.name, py.name),
    ch.signed_amount,
    ch.currency,
    ch.status,
    'contracted'::text
  from public.checks ch
  left join public.parties pe on pe.id = ch.payee_party_id
  left join public.parties py on py.id = ch.payer_party_id
  where ch.archived_at is null
    and ch.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
    and ch.maturity_date is not null
    and ch.signed_amount is not null

  union all

  select
    'invoice'::text,
    v.id,
    v.due_date,
    coalesce(v.invoice_no, '(fatura)'),
    null::text,
    pv.name,
    case
      when v.direction = 'sales'
        then (coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
      else -(coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))
    end,
    v.currency,
    v.status,
    'contracted'::text
  from public.invoices v
  left join public.parties pv on pv.id = v.party_id
  where v.status in ('open', 'partial')
    and v.due_date is not null
    and v.gross_amount is not null
    and coalesce(v.payable_amount, v.gross_amount) > greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))
    and not (
      v.settled_by_check_id is not null
      and exists (
        select 1 from public.checks c0
        where c0.id = v.settled_by_check_id
          and c0.archived_at is null
          and c0.status <> 'cancelled'
      )
    )
    and not exists (
      select 1
      from public.payment_instances pi2
      left join public.payments p2 on p2.id = pi2.payment_id
      where pi2.linked_invoice_id = v.id
        and pi2.status <> 'cancelled'
        and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
    )
    and not exists (
      select 1
      from public.checks c2
      where c2.linked_invoice_id = v.id
        and c2.archived_at is null
        and c2.status <> 'cancelled'
    )

  union all

  select
    'promise_to_pay'::text,
    pr.id,
    pr.promised_date,
    pp.name,
    null::text,
    pp.name,
    pr.promised_amount,
    pr.currency,
    pr.status,
    'expected'::text
  from public.promise_to_pay pr
  join public.parties pp on pp.id = pr.party_id
  where pr.status = 'pending'
    and pr.promised_amount is not null
    and pr.currency is not null

  union all

  select
    'facility_expiry'::text,
    f.id,
    f.expiry_date,
    f.name,
    null::text,
    pf.name,
    null::numeric,
    f.currency,
    f.status,
    'renewal'::text
  from public.credit_facilities f
  left join public.parties pf on pf.id = f.lender_party_id
  where f.status in ('active', 'suspended')
    and f.expiry_date is not null;

-- ── 9) 5-Katmanlı RLS ve Açık Tablo/Görünüm Yetkileri ──────────────────────────────────────────
alter table public.integration_sync_runs enable row level security;
alter table public.integration_raw_payloads enable row level security;
alter table public.integration_entity_links enable row level security;
alter table public.integration_account_mappings enable row level security;
alter table public.integration_staged_parties enable row level security;

revoke all on table
  public.integration_sync_runs,
  public.integration_raw_payloads,
  public.integration_entity_links,
  public.integration_account_mappings,
  public.integration_staged_parties
from public, anon, authenticated, mas_radar_app;

-- operational: integration_sync_runs, integration_entity_links, integration_account_mappings, integration_staged_parties
grant select on table
  public.integration_sync_runs,
  public.integration_entity_links,
  public.integration_account_mappings,
  public.integration_staged_parties
to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
   mas_radar_finance_manager, mas_radar_admin;

grant insert, update on table
  public.integration_sync_runs,
  public.integration_entity_links,
  public.integration_account_mappings,
  public.integration_staged_parties
to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;

grant delete on table
  public.integration_sync_runs,
  public.integration_entity_links,
  public.integration_account_mappings,
  public.integration_staged_parties
to mas_radar_finance_manager, mas_radar_admin;

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'integration_sync_runs',
    'integration_entity_links',
    'integration_account_mappings',
    'integration_staged_parties'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', tbl || '_select_all_tiers', tbl);
    execute format(
      'create policy %I on public.%I for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_select_all_tiers',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_insert_operational', tbl);
    execute format(
      'create policy %I on public.%I for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true)',
      tbl || '_insert_operational',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_update_operational', tbl);
    execute format(
      'create policy %I on public.%I for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin using (true) with check (true)',
      tbl || '_update_operational',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_delete_managers', tbl);
    execute format(
      'create policy %I on public.%I for delete to mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_delete_managers',
      tbl
    );
  end loop;
end $$;

-- evidence: integration_raw_payloads
grant select on table public.integration_raw_payloads
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
grant insert on table public.integration_raw_payloads
  to mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

drop policy if exists integration_raw_payloads_select_all_tiers on public.integration_raw_payloads;
create policy integration_raw_payloads_select_all_tiers on public.integration_raw_payloads
  for select
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists integration_raw_payloads_insert_record on public.integration_raw_payloads;
create policy integration_raw_payloads_insert_record on public.integration_raw_payloads
  for insert
  to mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  with check (true);

revoke insert, update, delete, truncate on
  public.daily_cash_movement,
  public.working_capital_monthly_v,
  public.liquidity_forecast_daily,
  public.financial_calendar
from public, anon, authenticated, mas_radar_app,
     mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

grant select on
  public.daily_cash_movement,
  public.working_capital_monthly_v,
  public.liquidity_forecast_daily,
  public.financial_calendar
to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
   mas_radar_finance_manager, mas_radar_admin;
