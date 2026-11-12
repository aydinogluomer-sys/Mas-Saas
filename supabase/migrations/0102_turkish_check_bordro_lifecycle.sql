-- 0102 — Faz 49 (D3): Türkiye Çek/Senet Bordrosu Yaşam Döngüsü
-- (Portföy, Tedarikçiye Ciro, Banka Tahsil, Banka Kredi Teminatı, Keşide Çek ve Karşılıksız Rücu Riski).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric); tüm görünümler WITH (security_invoker = true) taşır.
--   * Mevcut CHECK kısıtları ad varsayılmadan conkey üzerinden yapısal hedeflenir.

-- ── 1) public.check_bordros tablosu ────────────────────────────────────────────────────────────
create table if not exists public.check_bordros (
  id uuid primary key default gen_random_uuid(),
  bordro_no text unique not null check (btrim(bordro_no) <> ''),
  bordro_type text not null
    check (bordro_type in (
      'customer_receipt',
      'vendor_endorsement',
      'bank_collection',
      'bank_collateral',
      'own_issue',
      'settlement',
      'bounce_return'
    )),
  bordro_date date not null default current_date,
  target_party_id uuid references public.parties(id) on delete restrict,
  target_bank_account_id uuid references public.bank_accounts(cash_account_id) on delete restrict,
  target_facility_id uuid references public.credit_facilities(id) on delete restrict,
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),

  constraint check_bordros_endorsement_party_required check (
    bordro_type <> 'vendor_endorsement' or target_party_id is not null
  ),
  constraint check_bordros_collection_bank_required check (
    bordro_type <> 'bank_collection' or target_bank_account_id is not null
  ),
  constraint check_bordros_collateral_facility_required check (
    bordro_type <> 'bank_collateral' or target_facility_id is not null
  )
);

create index if not exists idx_check_bordros_type_date
  on public.check_bordros (bordro_type, bordro_date desc);
create index if not exists idx_check_bordros_target_party
  on public.check_bordros (target_party_id)
  where target_party_id is not null;
create index if not exists idx_check_bordros_target_bank
  on public.check_bordros (target_bank_account_id)
  where target_bank_account_id is not null;
create index if not exists idx_check_bordros_target_facility
  on public.check_bordros (target_facility_id)
  where target_facility_id is not null;

-- Kilitli finansal döneme geçmişe dönük bordro yazılmasını engelle (0100 kalkanı ile uyumlu)
create or replace function public.enforce_check_bordros_period_lock()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('DELETE', 'UPDATE') then
    perform public.assert_date_not_in_locked_period(old.bordro_date, 'check_bordros');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.assert_date_not_in_locked_period(new.bordro_date, 'check_bordros');
    return new;
  end if;
  return old;
end $$;

drop trigger if exists check_bordros_closed_period_lock on public.check_bordros;
create trigger check_bordros_closed_period_lock
  before insert or update or delete on public.check_bordros
  for each row execute function public.enforce_check_bordros_period_lock();

-- ── 2) public.checks ve public.check_events bordro genişletmeleri ──────────────────────────────
alter table public.checks
  add column if not exists instrument_type text not null default 'check'
    check (instrument_type in ('check', 'promissory_note')),
  add column if not exists endorsed_to_party_id uuid references public.parties(id) on delete restrict,
  add column if not exists collection_bank_account_id uuid references public.bank_accounts(cash_account_id) on delete restrict,
  add column if not exists collateral_facility_id uuid references public.credit_facilities(id) on delete restrict,
  add column if not exists collateral_record_id uuid references public.collateral_records(id) on delete set null,
  add column if not exists collateral_ltv_ratio numeric(6,4)
    check (collateral_ltv_ratio is null or (collateral_ltv_ratio > 0 and collateral_ltv_ratio <= 1)),
  add column if not exists settled_invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists last_bordro_id uuid references public.check_bordros(id) on delete set null;

create index if not exists idx_checks_endorsed_to_party
  on public.checks (endorsed_to_party_id)
  where endorsed_to_party_id is not null;
create index if not exists idx_checks_collection_bank
  on public.checks (collection_bank_account_id)
  where collection_bank_account_id is not null;
create index if not exists idx_checks_collateral_facility
  on public.checks (collateral_facility_id)
  where collateral_facility_id is not null;
create index if not exists idx_checks_settled_invoice
  on public.checks (settled_invoice_id)
  where settled_invoice_id is not null;
create index if not exists idx_checks_last_bordro
  on public.checks (last_bordro_id)
  where last_bordro_id is not null;
create index if not exists idx_checks_status_direction_currency
  on public.checks (status, direction, currency)
  where archived_at is null;

alter table public.check_events
  add column if not exists bordro_id uuid references public.check_bordros(id) on delete set null;

create index if not exists idx_check_events_bordro_id
  on public.check_events (bordro_id)
  where bordro_id is not null;

-- checks.status CHECK kısıtını conkey ile yapısal olarak genişlet
do $$
declare
  v_attnum smallint;
  r record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.checks'::regclass
     and a.attname = 'status'
     and not a.attisdropped;

  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.checks'::regclass
       and c.contype = 'c'
       and c.conkey = array[v_attnum]
  loop
    execute format('alter table public.checks drop constraint %I', r.conname);
  end loop;

  alter table public.checks
    add constraint checks_status_check
    check (status in (
      'planned',
      'in_portfolio',
      'endorsed_to_vendor',
      'in_bank_collection',
      'in_bank_collateral',
      'issued_to_vendor',
      'cleared',
      'bounced',
      'returned',
      'cancelled',
      'unknown'
    ));
end $$;

-- check_events.event_type CHECK kısıtını conkey ile yapısal olarak genişlet
do $$
declare
  v_attnum smallint;
  r record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.check_events'::regclass
     and a.attname = 'event_type'
     and not a.attisdropped;

  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.check_events'::regclass
       and c.contype = 'c'
       and c.conkey = array[v_attnum]
  loop
    execute format('alter table public.check_events drop constraint %I', r.conname);
  end loop;

  alter table public.check_events
    add constraint check_events_event_type_check
    check (event_type in (
      'created',
      'reminded',
      'received_to_portfolio',
      'endorsed_to_vendor',
      'sent_to_bank_collection',
      'pledged_to_bank_collateral',
      'issued_to_vendor',
      'cleared',
      'bounced',
      'recourse_returned',
      'returned',
      'recalled_to_portfolio',
      'cancelled',
      'note'
    ));
end $$;

-- checks_status_transition_guard(): eski 'planned' uyumluluğu + tam Türk çek/senet bordro geçiş matrisi
create or replace function public.checks_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    -- Geriye uyumlu 'planned' çıkışları (V1/V2 import edilen çeklerin bordroya veya kapanışa geçişi)
    ('planned',            'in_portfolio'),
    ('planned',            'issued_to_vendor'),
    ('planned',            'endorsed_to_vendor'),
    ('planned',            'in_bank_collection'),
    ('planned',            'in_bank_collateral'),
    ('planned',            'cleared'),
    ('planned',            'bounced'),
    ('planned',            'returned'),
    ('planned',            'cancelled'),

    -- Portföydeki müşteri çeki / senedi (in_portfolio)
    ('in_portfolio',       'endorsed_to_vendor'),
    ('in_portfolio',       'in_bank_collection'),
    ('in_portfolio',       'in_bank_collateral'),
    ('in_portfolio',       'cleared'),
    ('in_portfolio',       'bounced'),
    ('in_portfolio',       'returned'),
    ('in_portfolio',       'cancelled'),

    -- Tedarikçiye ciro edilen müşteri çeki (şarta bağlı rücu riski altında)
    ('endorsed_to_vendor', 'cleared'),
    ('endorsed_to_vendor', 'bounced'),
    ('endorsed_to_vendor', 'returned'),
    ('endorsed_to_vendor', 'in_portfolio'),

    -- Bankada tahsildeki müşteri çeki
    ('in_bank_collection', 'cleared'),
    ('in_bank_collection', 'bounced'),
    ('in_bank_collection', 'returned'),
    ('in_bank_collection', 'in_portfolio'),

    -- Bankada kredi teminatındaki müşteri çeki
    ('in_bank_collateral', 'cleared'),
    ('in_bank_collateral', 'bounced'),
    ('in_bank_collateral', 'returned'),
    ('in_bank_collateral', 'in_portfolio'),
    ('in_bank_collateral', 'in_bank_collection'),

    -- Kendi keşide ettiğimiz borç çeki / senedimiz
    ('issued_to_vendor',   'cleared'),
    ('issued_to_vendor',   'bounced'),
    ('issued_to_vendor',   'returned'),
    ('issued_to_vendor',   'cancelled'),

    -- Karşılıksız (bounced) sonrası tahsilat, rücu portföy dönüşü, iade veya terkin
    ('bounced',            'cleared'),
    ('bounced',            'returned'),
    ('bounced',            'in_portfolio'),
    ('bounced',            'cancelled'),

    -- İade edilen çekin kayıttan iptali
    ('returned',           'cancelled')
  ) then
    raise exception 'checks.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;

  return new;
end $$;

-- ── 3) Likidite Çift Sayım Kalkanı & Rücu Risk Görünümleri (security_invoker = true) ───────────

-- counterparty_exposure_items: 'in_bank_collateral' dahil, 'endorsed_to_vendor' hariç (rücu görünümünde ayrı izlenir)
create or replace view public.counterparty_exposure_items
with (security_invoker = true) as
  select
    coalesce(c.payee_party_id, c.payer_party_id) as party_id,
    'check'::text                                as source,
    c.id                                         as source_id,
    c.direction                                  as direction,
    c.amount                                     as amount,
    c.maturity_date                              as due_date,
    c.status                                     as status,
    c.currency                                   as currency
  from public.checks c
  where c.archived_at is null
    and c.status in ('planned', 'unknown', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
    and coalesce(c.payee_party_id, c.payer_party_id) is not null

  union all

  select
    l.lender_party_id,
    'loan_installment'::text,
    li.id,
    'outflow'::text,
    (case
      when li.status = 'partial' then greatest(0, li.amount - coalesce(li.paid_amount, 0))
      else li.amount
    end)::numeric(14,2),
    li.due_date,
    li.status,
    l.currency
  from public.loan_installments li
  join public.loans l on l.id = li.loan_id
  where l.archived_at is null
    and li.status in ('planned', 'unpaid', 'partial', 'late')
    and l.lender_party_id is not null

  union all

  select
    p.provider_party_id,
    'payment_instance'::text,
    i.id,
    coalesce(i.direction, 'outflow'),
    (case
      when i.status = 'partial' and i.amount is not null
        then greatest(0, i.amount - coalesce(i.paid_amount, 0))
      else i.amount
    end)::numeric(14,2),
    i.due_date,
    i.status,
    i.currency
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  where p.archived_at is null
    and p.status = 'active'
    and i.status in ('unpaid', 'partial', 'planned', 'late')
    and p.provider_party_id is not null;

-- liquidity_forecast_daily:
--   * 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor' ve eski 'planned' dahildir.
--   * 'endorsed_to_vendor' DÜŞER (kasaya nakit girmeyecek, ciro edilen tedarikçi faturasını invoice_allocations üzerinden kapattı!).
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
        then (v.gross_amount - coalesce(v.allocated_amount, 0))
      else -(v.gross_amount - coalesce(v.allocated_amount, 0))
    end,
    'contracted'::text
  from public.invoices v
  where v.status in ('open', 'partial')
    and v.due_date is not null
    and v.gross_amount is not null
    and v.gross_amount > coalesce(v.allocated_amount, 0)
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

-- financial_calendar: liquidity_forecast_daily ile birebir aynı çek durum kümesi
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
        then (v.gross_amount - coalesce(v.allocated_amount, 0))
      else -(v.gross_amount - coalesce(v.allocated_amount, 0))
    end,
    v.currency,
    v.status,
    'contracted'::text
  from public.invoices v
  left join public.parties pv on pv.id = v.party_id
  where v.status in ('open', 'partial')
    and v.due_date is not null
    and v.gross_amount is not null
    and v.gross_amount > coalesce(v.allocated_amount, 0)
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

-- check_portfolio_and_recourse_summary:
--   Portföydeki, bankada tahsildeki, teminattaki çekler, keşide borç çeklerimiz ve
--   tedarikçiye ciro edilmiş müşteri çeklerinin şarta bağlı rücu riski (contingent_recourse_amount).
create or replace view public.check_portfolio_and_recourse_summary
with (security_invoker = true) as
  with currencies as (
    select 'TRY'::text as currency
    union
    select distinct c.currency
      from public.checks c
     where c.archived_at is null
       and c.currency is not null
  )
  select
    cur.currency,
    count(c.id) filter (
      where c.direction = 'inflow' and c.status in ('in_portfolio', 'planned')
    )::int                                                                        as portfolio_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'inflow' and c.status in ('in_portfolio', 'planned') and c.amount is not null
    ), 0)::numeric(14,2)                                                          as portfolio_amount,

    count(c.id) filter (
      where c.direction = 'inflow' and c.status = 'in_bank_collection'
    )::int                                                                        as in_collection_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'inflow' and c.status = 'in_bank_collection' and c.amount is not null
    ), 0)::numeric(14,2)                                                          as in_collection_amount,

    count(c.id) filter (
      where c.direction = 'inflow' and c.status = 'in_bank_collateral'
    )::int                                                                        as in_collateral_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'inflow' and c.status = 'in_bank_collateral' and c.amount is not null
    ), 0)::numeric(14,2)                                                          as in_collateral_amount,
    coalesce(sum(round(c.amount * coalesce(c.collateral_ltv_ratio, 1), 2)) filter (
      where c.direction = 'inflow' and c.status = 'in_bank_collateral' and c.amount is not null
    ), 0)::numeric(14,2)                                                          as collateral_borrowing_value,

    count(c.id) filter (
      where c.direction = 'inflow' and c.status = 'endorsed_to_vendor'
    )::int                                                                        as endorsed_recourse_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'inflow' and c.status = 'endorsed_to_vendor' and c.amount is not null
    ), 0)::numeric(14,2)                                                          as contingent_recourse_amount,

    count(c.id) filter (
      where c.direction = 'outflow' and c.status in ('issued_to_vendor', 'planned')
    )::int                                                                        as own_issued_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'outflow' and c.status in ('issued_to_vendor', 'planned') and c.amount is not null
    ), 0)::numeric(14,2)                                                          as own_issued_amount,

    count(c.id) filter (
      where c.direction = 'inflow' and c.status = 'bounced'
    )::int                                                                        as bounced_inflow_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'inflow' and c.status = 'bounced' and c.amount is not null
    ), 0)::numeric(14,2)                                                          as bounced_inflow_amount,

    count(c.id) filter (
      where c.direction = 'inflow' and c.status = 'bounced' and c.endorsed_to_party_id is not null
    )::int                                                                        as bounced_recourse_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'inflow' and c.status = 'bounced' and c.endorsed_to_party_id is not null and c.amount is not null
    ), 0)::numeric(14,2)                                                          as bounced_recourse_amount,

    count(c.id) filter (
      where c.direction = 'outflow' and c.status = 'bounced'
    )::int                                                                        as bounced_outflow_count,
    coalesce(sum(c.amount) filter (
      where c.direction = 'outflow' and c.status = 'bounced' and c.amount is not null
    ), 0)::numeric(14,2)                                                          as bounced_outflow_amount,

    count(c.id) filter (
      where c.amount is null and c.status not in ('cleared', 'cancelled', 'returned')
    )::int                                                                        as unknown_amount_count
  from currencies cur
  left join public.checks c
    on c.currency = cur.currency
   and c.archived_at is null
  group by cur.currency
  order by (cur.currency = 'TRY') desc, cur.currency asc;

-- ── 4) 5-katmanlı RLS ve açık tablo/görünüm yetkileri ──────────────────────────────────────────
alter table public.check_bordros enable row level security;

revoke all on table public.check_bordros from public, anon, authenticated, mas_radar_app;

grant select on table public.check_bordros
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
grant insert, update on table public.check_bordros
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
grant delete on table public.check_bordros
  to mas_radar_finance_manager, mas_radar_admin;

drop policy if exists check_bordros_select_all_tiers on public.check_bordros;
create policy check_bordros_select_all_tiers on public.check_bordros
  for select
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin
  using (true);

drop policy if exists check_bordros_insert_operational on public.check_bordros;
create policy check_bordros_insert_operational on public.check_bordros
  for insert
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (
    created_by is not distinct from public.current_app_user()
    or public.current_app_user() is null
  );

drop policy if exists check_bordros_update_operational on public.check_bordros;
create policy check_bordros_update_operational on public.check_bordros
  for update
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true)
  with check (true);

drop policy if exists check_bordros_delete_managers on public.check_bordros;
create policy check_bordros_delete_managers on public.check_bordros
  for delete
  to mas_radar_finance_manager, mas_radar_admin
  using (true);

revoke insert, update, delete, truncate on
  public.counterparty_exposure_items,
  public.liquidity_forecast_daily,
  public.financial_calendar,
  public.check_portfolio_and_recourse_summary
from public, anon, authenticated, mas_radar_app,
     mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

grant select on
  public.counterparty_exposure_items,
  public.liquidity_forecast_daily,
  public.financial_calendar,
  public.check_portfolio_and_recourse_summary
to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
   mas_radar_finance_manager, mas_radar_admin;

