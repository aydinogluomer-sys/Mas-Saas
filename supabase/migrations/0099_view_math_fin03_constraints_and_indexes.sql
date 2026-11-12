-- 0099 — Faz 44 (C1): Görünüm matematiği (0094/0080/0078/0073/0070/0063/0050), FIN-03 bilinmeyen
-- açılış bakiyesi yayılımı, çapraz-döviz fatura tahsisi kilidi, durum makinesi geçiş düzeltmeleri,
-- 0083 doküman FK onarımı, 8 NOT VALID kısıt doğrulaması, serbest currency ISO-4217 kontrolü ve
-- eksik sıcak B-tree FK indeksleri.
--
-- Kurallar:
--   * Üst-seviye işlem komutu ve eşzamanlı indeks kullanılmaz (scripts/db/migration-lib.ts).
--   * Sıfır kayan nokta (yalnız numeric); tüm görünümler WITH (security_invoker = true) taşır.
--   * Mevcut kolon adları, tipleri ve sıraları korunur; yeni kolonlar sona eklenir.

-- ── 0) Kısmi taksit kalan tutarı ve çift-sayım engeli bağlantı kolonları ────────────────────
alter table public.loan_installments
  add column if not exists paid_amount numeric(14,2)
  check (paid_amount is null or (paid_amount >= 0 and paid_amount <= amount));

alter table public.payment_instances
  add column if not exists linked_invoice_id uuid references public.invoices(id) on delete set null;

alter table public.checks
  add column if not exists linked_invoice_id uuid references public.invoices(id) on delete set null;

alter table public.invoices
  add column if not exists settled_by_check_id uuid references public.checks(id) on delete set null;

create index if not exists payment_instances_linked_invoice_idx
  on public.payment_instances (linked_invoice_id)
  where linked_invoice_id is not null;

create index if not exists checks_linked_invoice_idx
  on public.checks (linked_invoice_id)
  where linked_invoice_id is not null;

create index if not exists invoices_settled_by_check_idx
  on public.invoices (settled_by_check_id)
  where settled_by_check_id is not null;

-- ── 1) Kredi taksiti, ödeme ve çek statü / döviz / kalan tutar onarımı ──────────────────────

-- counterparty_exposure_items: çeklerde yeni aktif durumlar + gerçek döviz ve kısmi kalan tutar
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
    and c.status in ('planned', 'unknown', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
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

-- debt_maturity_ladder: 'planned'/'late' taksitler dahil, l.currency = 'TRY' filtresi, kalan tutar
create or replace view public.debt_maturity_ladder
with (security_invoker = true) as
  with buckets(bucket_days, bucket_label, sort_order) as (
    values (30, '0-30 gün', 1), (90, '31-90 gün', 2), (180, '91-180 gün', 3), (365, '181-365 gün', 4)
  ),
  bounds as (
    select bucket_days, bucket_label, sort_order,
           case sort_order when 1 then 0 when 2 then 30 when 3 then 90 else 180 end as from_days
    from buckets
  ),
  open_installments as (
    select
      li.id,
      li.due_date,
      l.currency,
      case
        when li.status = 'partial' then greatest(0, li.amount - coalesce(li.paid_amount, 0))
        else li.amount
      end as remaining_amount
    from public.loan_installments li
    join public.loans l on l.id = li.loan_id
    where l.archived_at is null
      and li.status in ('planned', 'unpaid', 'partial', 'late')
  ),
  installments as (
    select b.sort_order,
           coalesce(sum(oi.remaining_amount) filter (where oi.currency = 'TRY'), 0) as installment_due,
           count(oi.id) filter (where oi.currency = 'TRY')                          as installment_count,
           count(oi.id) filter (where oi.currency <> 'TRY')                         as foreign_installment_count
    from bounds b
    left join open_installments oi
      on oi.due_date >= current_date + b.from_days
     and oi.due_date <  current_date + b.bucket_days
    group by b.sort_order
  ),
  expiries as (
    select b.sort_order,
           coalesce(sum(u.drawn_amount) filter (where u.currency = 'TRY'), 0) as facility_drawn_expiring,
           coalesce(sum(u.limit_amount) filter (where u.currency = 'TRY'), 0) as facility_limit_expiring,
           count(u.facility_id) filter (where u.currency = 'TRY')             as facility_count,
           count(u.facility_id) filter (where u.currency <> 'TRY')            as foreign_facility_count
    from bounds b
    left join public.credit_facility_utilization u
      on u.status in ('active', 'suspended')
     and u.expiry_date is not null
     and u.expiry_date >= current_date + b.from_days
     and u.expiry_date <  current_date + b.bucket_days
    group by b.sort_order
  )
  select
    b.sort_order,
    b.bucket_label,
    b.bucket_days,
    i.installment_due,
    i.installment_count,
    e.facility_drawn_expiring,
    e.facility_limit_expiring,
    e.facility_count,
    (i.installment_due + e.facility_drawn_expiring) as total_cash_exposure,
    e.foreign_facility_count,
    'TRY'::text                                     as currency,
    i.foreign_installment_count
  from bounds b
  join installments i on i.sort_order = b.sort_order
  join expiries e on e.sort_order = b.sort_order;

-- debt_maturity_ladder_by_currency: tüm aktif para birimleri için ayrı vade merdiveni
create or replace view public.debt_maturity_ladder_by_currency
with (security_invoker = true) as
  with buckets(bucket_days, bucket_label, sort_order) as (
    values (30, '0-30 gün', 1), (90, '31-90 gün', 2), (180, '91-180 gün', 3), (365, '181-365 gün', 4)
  ),
  bounds as (
    select bucket_days, bucket_label, sort_order,
           case sort_order when 1 then 0 when 2 then 30 when 3 then 90 else 180 end as from_days
    from buckets
  ),
  currencies as (
    select 'TRY'::text as currency
    union
    select distinct l.currency from public.loans l where l.archived_at is null and l.currency is not null
    union
    select distinct u.currency from public.credit_facility_utilization u where u.currency is not null
  ),
  open_installments as (
    select
      li.id,
      li.due_date,
      l.currency,
      case
        when li.status = 'partial' then greatest(0, li.amount - coalesce(li.paid_amount, 0))
        else li.amount
      end as remaining_amount
    from public.loan_installments li
    join public.loans l on l.id = li.loan_id
    where l.archived_at is null
      and li.status in ('planned', 'unpaid', 'partial', 'late')
  )
  select
    cur.currency,
    b.sort_order,
    b.bucket_label,
    b.bucket_days,
    coalesce(inst.installment_due, 0)         as installment_due,
    coalesce(inst.installment_count, 0)       as installment_count,
    coalesce(exp.facility_drawn_expiring, 0)  as facility_drawn_expiring,
    coalesce(exp.facility_limit_expiring, 0)  as facility_limit_expiring,
    coalesce(exp.facility_count, 0)           as facility_count,
    coalesce(inst.installment_due, 0) + coalesce(exp.facility_drawn_expiring, 0) as total_cash_exposure
  from currencies cur
  cross join bounds b
  left join lateral (
    select
      coalesce(sum(oi.remaining_amount), 0) as installment_due,
      count(oi.id)                          as installment_count
    from open_installments oi
    where oi.currency = cur.currency
      and oi.due_date >= current_date + b.from_days
      and oi.due_date <  current_date + b.bucket_days
  ) inst on true
  left join lateral (
    select
      coalesce(sum(u.drawn_amount), 0) as facility_drawn_expiring,
      coalesce(sum(u.limit_amount), 0) as facility_limit_expiring,
      count(u.facility_id)             as facility_count
    from public.credit_facility_utilization u
    where u.currency = cur.currency
      and u.status in ('active', 'suspended')
      and u.expiry_date is not null
      and u.expiry_date >= current_date + b.from_days
      and u.expiry_date <  current_date + b.bucket_days
  ) exp on true;

-- liquidity_forecast_daily: statüler, gerçek döviz, kalan tutar ve fatura-çek/ödeme çift sayım engeli
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
    and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
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

-- financial_calendar & financial_calendar_daily: aynı statü, gerçek döviz, kalan tutar ve çift sayım engeli
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
    and ch.status in ('planned', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
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

create or replace view public.financial_calendar_daily
with (security_invoker = true) as
  select
    fc.event_date,
    fc.currency,
    count(*)                                                                        as event_count,
    coalesce(sum(fc.amount_signed) filter (where fc.certainty = 'contracted'), 0)   as net_contracted,
    coalesce(sum(fc.amount_signed) filter (where fc.certainty = 'expected'), 0)     as net_expected,
    coalesce(sum(fc.amount_signed) filter (where fc.certainty = 'contracted' and fc.amount_signed > 0), 0) as inflow_contracted,
    coalesce(sum(fc.amount_signed) filter (where fc.certainty = 'contracted' and fc.amount_signed < 0), 0) as outflow_contracted,
    count(*) filter (where fc.certainty = 'renewal')                                as renewal_count,
    (
      select count(*)
      from public.payment_instances pi
      left join public.payments pay on pay.id = pi.payment_id
      where pi.due_date = fc.event_date
        and pi.status in ('planned', 'unpaid', 'partial', 'late')
        and (pay.id is null or (pay.status = 'active' and pay.archived_at is null))
        and pi.currency is null
    )                                                                               as unknown_currency_count
  from public.financial_calendar fc
  group by fc.event_date, fc.currency;

-- ── 2) FIN-03 bilinmeyen açılış bakiyesi ve hazine mutabakatı ───────────────────────────────

-- bank_cash_position: opening_balance IS NULL iken doğal SQL NULL yayılımı (0 varsayılmaz!)
create or replace view public.bank_cash_position
with (security_invoker = true) as
  select
    ca.id                                       as cash_account_id,
    ca.name                                     as account_name,
    ca.currency,
    ca.is_active,
    ba.bank_name,
    ba.iban,
    ba.available_balance                        as stated_balance,
    ba.blocked_balance,
    ba.overdraft_limit,
    ba.balance_as_of,
    ca.opening_balance,
    ca.opening_balance
      + coalesce(sum(bt.amount) filter (where bt.status <> 'ignored' and bt.currency = ca.currency), 0)
                                                as derived_balance,
    count(bt.id) filter (where bt.status <> 'ignored')                    as movement_count,
    max(bt.txn_date)                                                      as last_movement_date,
    case
      when ba.available_balance is null or ca.opening_balance is null then null::numeric
      else ba.available_balance
           - (ca.opening_balance
              + coalesce(sum(bt.amount) filter (where bt.status <> 'ignored' and bt.currency = ca.currency), 0))
    end                                                                   as stated_minus_derived,
    count(bt.id) filter (where bt.status <> 'ignored' and bt.currency <> ca.currency) as foreign_txn_count,
    (ca.opening_balance is not null)                                      as opening_known,
    coalesce(sum(bt.amount) filter (where bt.status <> 'ignored' and bt.currency = ca.currency), 0)
                                                                          as movement_net
  from public.cash_accounts ca
  left join public.bank_accounts ba on ba.cash_account_id = ca.id
  left join public.bank_transactions bt on bt.bank_account_id = ba.cash_account_id
  group by ca.id, ca.name, ca.currency, ca.is_active, ba.bank_name, ba.iban,
           ba.available_balance, ba.blocked_balance, ba.overdraft_limit, ba.balance_as_of,
           ca.opening_balance;

-- treasury_position_summary: unknown_opening_count > 0 iken available_now = NULL, movements_only_total ayrı
create or replace view public.treasury_position_summary
with (security_invoker = true) as
  select
    p.currency,
    count(*)                                        as account_count,
    case
      when count(*) filter (where not p.opening_known) > 0 then null::numeric
      else coalesce(sum(p.derived_balance), 0)
    end                                             as total_derived_balance,
    sum(p.stated_balance)                           as total_stated_balance,
    sum(coalesce(p.blocked_balance, 0))             as total_blocked,
    sum(coalesce(p.overdraft_limit, 0))             as total_overdraft_limit,
    case
      when count(*) filter (where not p.opening_known) > 0 then null::numeric
      else coalesce(sum(p.derived_balance), 0) - sum(coalesce(p.blocked_balance, 0))
    end                                             as available_now,
    case
      when count(*) filter (where not p.opening_known) > 0 then null::numeric
      else coalesce(sum(p.derived_balance), 0)
           - sum(coalesce(p.blocked_balance, 0))
           + sum(coalesce(p.overdraft_limit, 0))
    end                                             as available_with_overdraft,
    count(*) filter (where p.stated_minus_derived is not null
                       and abs(p.stated_minus_derived) > 0.01)              as accounts_with_gap,
    count(*) filter (where not p.opening_known)     as unknown_opening_count,
    coalesce(sum(p.movement_net), 0)                as movements_only_total
  from public.bank_cash_position p
  where p.is_active
  group by p.currency;

-- treasury_liquidity_gap: available_now IS NULL iken projected_*, financing_need ve breaches_floor NULL;
-- ayrıca henüz kasa/banka hesabı açılmamış bir dövizde (veya boş şemada TRY için) 90 günlük akış/taban varsa
-- ufuk satırı gizlenmez (hesap yoksa bakiye 0; hesap var ama opening_balance IS NULL ise bakiye NULL kalır!).
create or replace view public.treasury_liquidity_gap
with (security_invoker = true) as
  with horizons(days) as (values (7), (30), (90)),
  pos as (
    select currency, available_now, available_with_overdraft,
           unknown_opening_count, movements_only_total
    from public.treasury_position_summary
  ),
  floors as (
    select currency, threshold_amount
    from public.treasury_policies
    where policy_kind = 'min_cash' and is_active and cash_account_id is null
  ),
  flows as (
    select h.days, f.currency,
           sum(f.amount_signed) filter (where f.certainty = 'contracted') as contracted_net,
           sum(f.amount_signed)                                            as all_net
    from horizons h
    join public.liquidity_forecast_daily f
      on f.flow_date >= current_date and f.flow_date < current_date + h.days
    where f.currency is not null
    group by h.days, f.currency
  ),
  all_currencies as (
    select 'TRY'::text as currency
    union
    select currency from pos where currency is not null
    union
    select currency from floors where currency is not null
    union
    select distinct currency from flows where currency is not null
  ),
  effective_pos as (
    select
      c.currency,
      case when p.currency is null then 0::numeric else p.available_now end              as available_now,
      case when p.currency is null then 0::numeric else p.available_with_overdraft end   as available_with_overdraft,
      coalesce(p.unknown_opening_count, 0)                                               as unknown_opening_count,
      coalesce(p.movements_only_total, 0)                                                as movements_only_total
    from all_currencies c
    left join pos p on p.currency = c.currency
  ),
  unknown_cur as (
    select h.days,
           count(pi.id) as unknown_currency_count
    from horizons h
    left join public.payment_instances pi
      on pi.due_date >= current_date
     and pi.due_date < current_date + h.days
     and pi.status in ('planned', 'unpaid', 'partial', 'late')
     and pi.currency is null
    left join public.payments pay on pay.id = pi.payment_id
    where pi.id is null or pay.id is null or (pay.status = 'active' and pay.archived_at is null)
    group by h.days
  )
  select
    h.days                                                as horizon_days,
    p.currency,
    p.available_now,
    p.available_with_overdraft,
    coalesce(fl.contracted_net, 0)                        as contracted_net_flow,
    coalesce(fl.all_net, 0)                               as expected_net_flow,
    case
      when p.available_now is null then null::numeric
      else p.available_now + coalesce(fl.contracted_net, 0)
    end                                                   as projected_contracted,
    case
      when p.available_now is null then null::numeric
      else p.available_now + coalesce(fl.all_net, 0)
    end                                                   as projected_expected,
    coalesce(fx.threshold_amount, 0)                      as min_cash_floor,
    case
      when p.available_now is null then null::numeric
      else greatest(0, coalesce(fx.threshold_amount, 0)
                       - (p.available_now + coalesce(fl.contracted_net, 0)))
    end                                                   as financing_need,
    case
      when p.available_now is null then null::boolean
      else (p.available_now + coalesce(fl.contracted_net, 0)) < coalesce(fx.threshold_amount, 0)
    end                                                   as breaches_floor,
    case
      when p.available_now is null then 'unknown_opening_balance'::text
      when (p.available_now + coalesce(fl.contracted_net, 0)) < coalesce(fx.threshold_amount, 0)
        then 'floor_breached'::text
      else 'ok'::text
    end                                                   as status,
    p.unknown_opening_count,
    p.movements_only_total,
    coalesce(uc.unknown_currency_count, 0)                as unknown_currency_count
  from horizons h
  cross join effective_pos p
  left join flows fl on fl.days = h.days and fl.currency = p.currency
  left join floors fx on fx.currency = p.currency
  left join unknown_cur uc on uc.days = h.days;

-- treasury_cashflow_reconciliation: aktif TRY banka hesaplarının açılış bakiyesi toplamını içerir;
-- herhangi birinin opening_balance değeri NULL ise sahte 'divergent' yerine 'incomplete_opening_balance' döner.
create or replace view public.treasury_cashflow_reconciliation
with (security_invoker = true) as
  with try_opening as (
    select
      count(*) filter (where ca.opening_balance is null) as unknown_opening_count,
      coalesce(sum(ca.opening_balance), 0)               as opening_total
    from public.cash_accounts ca
    join public.bank_accounts ba on ba.cash_account_id = ca.id
    where ca.is_active
      and ca.currency = 'TRY'
  ),
  month_end as (
    select
      date_trunc('month', bt.txn_date)::date          as month_start,
      ca.currency,
      sum(bt.amount)                                   as month_net
    from public.bank_transactions bt
    join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
    join public.cash_accounts ca on ca.id = ba.cash_account_id
    where bt.status <> 'ignored'
      and bt.currency = ca.currency
      and ca.is_active
    group by 1, 2
  ),
  running as (
    select
      m.month_start,
      m.currency,
      m.month_net,
      sum(m.month_net) over (partition by m.currency order by m.month_start) as treasury_running_net
    from month_end m
  )
  select
    cm.month_start,
    coalesce(r.currency, 'TRY')                        as currency,
    cm.closing_balance                                 as cashflow_closing,
    case
      when o.unknown_opening_count > 0 then null::numeric
      when r.treasury_running_net is null then null::numeric
      else o.opening_total + r.treasury_running_net
    end                                                as treasury_closing,
    case
      when cm.closing_balance is null then null::numeric
      when o.unknown_opening_count > 0 then null::numeric
      when r.treasury_running_net is null then null::numeric
      else (o.opening_total + r.treasury_running_net) - cm.closing_balance
    end                                                as difference,
    case
      when cm.closing_balance is null                                             then 'cashflow_missing'
      when o.unknown_opening_count > 0                                            then 'incomplete_opening_balance'
      when r.treasury_running_net is null                                         then 'no_bank_movement'
      when abs((o.opening_total + r.treasury_running_net) - cm.closing_balance) <= 1 then 'aligned'
      else 'divergent'
    end                                                as reconciliation_status,
    o.unknown_opening_count
  from public.cashflow_months cm
  cross join try_opening o
  left join running r
    on r.month_start = cm.month_start
   and r.currency = 'TRY'
  order by cm.month_start;

-- ── 3) Diğer 7 görünüm ve çapraz-döviz fatura tahsisi kilidi ────────────────────────────────

-- current_account_ledger: satış (+borç / tahsilat -alacak) ve alış (-alacak / ödeme +borç) muhasebe işareti + currency
create or replace view public.current_account_ledger
with (security_invoker = true) as
  with entries as (
    select
      i.party_id,
      i.issue_date                                    as movement_date,
      case when i.direction = 'sales' then 'fatura (satış)' else 'fatura (alış)' end as movement_type,
      i.invoice_no                                    as reference,
      i.direction,
      case when i.direction = 'sales' then i.gross_amount else 0::numeric(14,2) end as debit_amount,
      case when i.direction = 'purchase' then i.gross_amount else 0::numeric(14,2) end as credit_amount,
      i.id                                            as invoice_id,
      null::uuid                                      as allocation_id,
      i.currency,
      0                                               as entry_order
    from public.invoices i
    where i.status <> 'cancelled'

    union all

    select
      i.party_id,
      a.allocated_on                                  as movement_date,
      case when i.direction = 'sales' then 'tahsilat' else 'ödeme' end as movement_type,
      coalesce(a.source_table, 'manual')              as reference,
      i.direction,
      case when i.direction = 'purchase' then a.allocated_amount else 0::numeric(14,2) end as debit_amount,
      case when i.direction = 'sales' then a.allocated_amount else 0::numeric(14,2) end as credit_amount,
      i.id                                            as invoice_id,
      a.id                                            as allocation_id,
      i.currency,
      1                                               as entry_order
    from public.invoice_allocations a
    join public.invoices i on i.id = a.invoice_id
    where a.reversed_at is null
  )
  select
    e.party_id,
    e.movement_date,
    e.movement_type,
    e.reference,
    e.direction,
    e.debit_amount,
    e.credit_amount,
    e.invoice_id,
    e.allocation_id,
    e.currency,
    sum(e.debit_amount - e.credit_amount)
      over (
        partition by e.party_id, e.currency
        order by e.movement_date, e.entry_order, coalesce(e.allocation_id, e.invoice_id)
      )                                               as running_balance
  from entries e;

-- enforce_invoice_allocation_currency(): çapraz-döviz kur çevrimsiz tahsis yasağı (ERRCODE 23514)
create or replace function public.enforce_invoice_allocation_currency()
returns trigger
language plpgsql
as $$
declare
  v_invoice_currency text;
  v_source_currency  text;
begin
  if new.reversed_at is not null then
    return new;
  end if;

  if new.source_table = 'manual' or new.source_id is null then
    return new;
  end if;

  select i.currency
    into v_invoice_currency
    from public.invoices i
   where i.id = new.invoice_id;

  if v_invoice_currency is null then
    return new;
  end if;

  if new.source_table = 'bank_transactions' then
    select bt.currency
      into v_source_currency
      from public.bank_transactions bt
     where bt.id = new.source_id;
  elsif new.source_table = 'payment_instances' then
    select pi.currency
      into v_source_currency
      from public.payment_instances pi
     where pi.id = new.source_id;
  elsif new.source_table = 'checks' then
    select c.currency
      into v_source_currency
      from public.checks c
     where c.id = new.source_id;
  end if;

  if v_source_currency is not null and v_source_currency <> v_invoice_currency then
    raise exception 'cross_currency_allocation_forbidden: kaynak (%) ile fatura (%) para birimi uyuşmuyor.',
      v_source_currency, v_invoice_currency
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists invoice_allocations_currency_guard on public.invoice_allocations;
create trigger invoice_allocations_currency_guard
  before insert or update on public.invoice_allocations
  for each row execute function public.enforce_invoice_allocation_currency();

-- control_large_payments: yabancı parada fx_rate_snapshots <= due_date ile try_equivalent veya needs_fx_review
create or replace view public.control_large_payments
with (security_invoker = true) as
  with threshold as (
    select coalesce((select (value #>> '{}')::numeric from public.settings
                     where key = 'critical_payment_threshold_try'), 100000) as amount
  )
  select
    i.id                       as payment_instance_id,
    coalesce(p.name, '(kalem)') as payment_name,
    i.due_date,
    i.amount,
    i.currency,
    t.amount                   as threshold_amount,
    case
      when i.currency = 'TRY' then 1::numeric(18,10)
      else fx.rate
    end                        as fx_rate,
    case
      when i.currency = 'TRY' then round(i.amount, 2)
      when fx.rate is not null then round(i.amount * fx.rate, 2)
      else null::numeric
    end                        as try_equivalent,
    (i.currency <> 'TRY' and fx.rate is null) as needs_fx_review
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  cross join threshold t
  left join lateral (
    select s.rate
    from public.fx_rate_snapshots s
    where i.currency <> 'TRY'
      and s.base_currency = i.currency
      and s.quote_currency = 'TRY'
      and s.rate_date <= coalesce(i.due_date, current_date)
    order by s.rate_date desc, s.created_at desc
    limit 1
  ) fx on true
  where i.amount is not null
    and i.status <> 'cancelled'
    and (
      (i.currency = 'TRY' and i.amount >= t.amount)
      or (i.currency <> 'TRY' and fx.rate is not null and round(i.amount * fx.rate, 2) >= t.amount)
      or (i.currency <> 'TRY' and fx.rate is null)
    );

-- control_approval_bypass: aynı FX çevrimi / needs_fx_review + onaylanmış approvals kontrolü
create or replace view public.control_approval_bypass
with (security_invoker = true) as
  with threshold as (
    select coalesce((select (value #>> '{}')::numeric from public.settings
                     where key = 'critical_payment_threshold_try'), 100000) as amount
  )
  select
    i.id                       as payment_instance_id,
    coalesce(p.name, '(kalem)') as payment_name,
    i.amount,
    i.due_date,
    t.amount                   as threshold_amount,
    i.currency,
    case
      when i.currency = 'TRY' then 1::numeric(18,10)
      else fx.rate
    end                        as fx_rate,
    case
      when i.currency = 'TRY' then round(i.amount, 2)
      when fx.rate is not null then round(i.amount * fx.rate, 2)
      else null::numeric
    end                        as try_equivalent,
    (i.currency <> 'TRY' and fx.rate is null) as needs_fx_review
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  cross join threshold t
  left join lateral (
    select s.rate
    from public.fx_rate_snapshots s
    where i.currency <> 'TRY'
      and s.base_currency = i.currency
      and s.quote_currency = 'TRY'
      and s.rate_date <= coalesce(i.due_date, current_date)
    order by s.rate_date desc, s.created_at desc
    limit 1
  ) fx on true
  where i.amount is not null
    and i.status in ('paid', 'partial')
    and (
      (i.currency = 'TRY' and i.amount >= t.amount)
      or (i.currency <> 'TRY' and fx.rate is not null and round(i.amount * fx.rate, 2) >= t.amount)
      or (i.currency <> 'TRY' and fx.rate is null)
    )
    and not exists (
      select 1
      from public.approvals a
      where a.subject_table = 'payment_instances'
        and a.subject_id = i.id
        and a.status = 'approved'
    );

-- cash_forecast_13w: satır para birimini (l.currency) GROUP BY anahtarıyla eşleştir (döviz karışımı yok)
create or replace view public.cash_forecast_13w
with (security_invoker = true) as
  with anchors as (
    select f.id as forecast_id, f.name, f.anchor_date, f.currency
    from public.forecasts f
    where f.is_active and f.horizon_kind = 'weekly_13'
    union
    select f.id as forecast_id, f.name, f.anchor_date, l.currency
    from public.forecasts f
    join public.forecast_lines l on l.forecast_id = f.id
    where f.is_active
      and f.horizon_kind = 'weekly_13'
      and l.version_status = 'approved'
  ),
  weeks as (
    select a.forecast_id, a.name, a.currency, a.anchor_date,
           gs.week_no,
           (a.anchor_date + ((gs.week_no - 1) * 7))::date as week_start,
           (a.anchor_date + (gs.week_no * 7) - 1)::date   as week_end
    from anchors a
    cross join generate_series(1, 13) as gs(week_no)
  )
  select
    w.forecast_id,
    w.name                                     as forecast_name,
    w.week_no,
    w.week_start,
    w.week_end,
    w.currency,
    coalesce(sum(l.amount) filter (where l.direction = 'inflow'), 0)   as inflow,
    coalesce(sum(l.amount) filter (where l.direction = 'outflow'), 0)  as outflow,
    coalesce(sum(case when l.direction = 'inflow' then l.amount else -l.amount end), 0) as net_flow,
    coalesce(sum(case when l.direction = 'inflow' then l.amount else -l.amount end)
             filter (where l.source_kind = 'contracted'), 0)           as net_flow_contracted,
    count(l.id)                                                        as line_count,
    count(l.id) filter (where l.source_kind = 'estimated')             as estimated_line_count,
    coalesce(sum(case when l.direction = 'inflow' then l.amount else -l.amount end
                 * coalesce(l.confidence, 1)), 0)                      as net_flow_confidence_weighted
  from weeks w
  left join public.forecast_lines l
    on l.forecast_id = w.forecast_id
   and l.currency = w.currency
   and l.version_status = 'approved'
   and l.period_start >= w.week_start
   and l.period_start <= w.week_end
  group by w.forecast_id, w.name, w.week_no, w.week_start, w.week_end, w.currency;

-- optimization_run_summary: öneri para birimini (rec.currency) GROUP BY anahtarına dahil et
create or replace view public.optimization_run_summary
with (security_invoker = true) as
  with run_currencies as (
    select o.id as run_id, o.currency
    from public.optimization_runs o
    union
    select rec.run_id, rec.currency
    from public.optimization_recommendations rec
  )
  select
    o.id                                            as run_id,
    o.name,
    o.objective,
    o.anchor_date,
    o.horizon_days,
    rc.currency                                     as currency,
    o.scenario_run_id,
    o.result_digest,
    o.created_at,
    count(rec.id)                                   as recommendation_count,
    coalesce(sum(rec.expected_effect), 0)           as total_expected_effect,
    count(rec.id) filter (where rec.action_kind in ('defer_payment', 'advance_payment'))
                                                    as timing_actions,
    count(rec.id) filter (where rec.action_kind in ('draw_facility', 'repay_facility'))
                                                    as financing_actions,
    a.status                                        as approval_status,
    a.round_no                                      as approval_round,
    a.decided_at                                    as approval_decided_at
  from public.optimization_runs o
  join run_currencies rc on rc.run_id = o.id
  left join public.optimization_recommendations rec
    on rec.run_id = o.id
   and rec.currency = rc.currency
  left join lateral (
    select ap.status, ap.round_no, ap.decided_at
    from public.approvals ap
    where ap.subject_table = 'optimization_runs' and ap.subject_id = o.id
    order by ap.round_no desc
    limit 1
  ) a on true
  group by o.id, o.name, o.objective, o.anchor_date, o.horizon_days, rc.currency,
           o.scenario_run_id, o.result_digest, o.created_at,
           a.status, a.round_no, a.decided_at;

-- budget_vs_actual & budget_variance_summary: yıllık (period_kind = 'annual') 12-ay dağılımı ve
-- önceden toplanmış actuals ile sıfır fan-out garantisi
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
        when el.department_id is not null then null::numeric
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
            and el.cost_center_id is null
            and el.project_id is null
        )
        else (
          select sum(v.gross_amount)
          from public.invoices v
          where v.status <> 'cancelled'
            and v.issue_date is not null
            and v.gross_amount is not null
            and date_trunc('month', v.issue_date)::date = el.period_start
            and (case when v.direction = 'sales' then 'income' else 'expense' end) = el.direction
            and v.currency = el.currency
            and v.cost_center_id is not distinct from el.cost_center_id
            and v.project_id is not distinct from el.project_id
        )
      end as actual_amount
  ) act on true;

create or replace view public.budget_variance_summary
with (security_invoker = true) as
  select
    v.budget_id,
    v.budget_name,
    v.fiscal_year,
    v.direction,
    v.currency,
    count(*)                                                    as line_count,
    sum(v.budget_amount)                                        as budget_total,
    sum(v.actual_amount)                                        as actual_total,
    sum(v.variance_amount)                                      as variance_total,
    count(*) filter (where v.variance_verdict = 'over_budget')  as over_budget_lines,
    count(*) filter (where v.variance_verdict = 'not_measured') as not_measured_lines,
    count(*) filter (where v.department_scoped and v.actual_amount is null)
                                                                as department_lines_unmeasurable
  from public.budget_vs_actual v
  group by v.budget_id, v.budget_name, v.fiscal_year, v.direction, v.currency;

-- payment_priority_queue & payment_calendar_extended: aktif ödeme + outflow zorlaması, döviz, çift sayım engeli
create or replace view public.payment_priority_queue
with (security_invoker = true) as
  select
    src.kind,
    src.entity_id,
    src.due_date,
    src.label,
    src.amount,
    src.party_name,
    src.flexibility_class,
    src.priority,
    (src.due_date < current_date)                       as overdue,
    greatest(current_date - src.due_date, 0)            as days_overdue,
    (
      case src.flexibility_class
        when 'critical' then 0 when 'flexible' then 100 when 'optional' then 200 else 150 end
      + case src.priority
        when 'critical' then 0 when 'high' then 10 when 'normal' then 20 when 'low' then 30 else 20 end
      + least(greatest((src.due_date - current_date), -30), 60)
    )                                                   as priority_rank,
    src.currency
  from (
    select
      'payment_instance'::text                          as kind,
      i.id                                              as entity_id,
      i.due_date,
      coalesce(p.name, '(silinmiş kalem)')              as label,
      case
        when i.status = 'partial' and i.amount is not null
          then greatest(0, i.amount - coalesce(i.paid_amount, 0))
        else i.amount
      end                                               as amount,
      coalesce(pr.name, '')                             as party_name,
      coalesce(p.flexibility_class, 'flexible')         as flexibility_class,
      coalesce(p.priority, 'normal')                    as priority,
      i.currency
    from public.payment_instances i
    left join public.payments p on p.id = i.payment_id
    left join public.parties pr on pr.id = p.provider_party_id
    where i.status in ('unpaid', 'partial', 'planned', 'late')
      and coalesce(i.direction, 'outflow') = 'outflow'
      and (p.id is null or (p.status = 'active' and p.archived_at is null))

    union all

    select
      'invoice'::text,
      inv.id,
      coalesce(inv.due_date, inv.issue_date),
      inv.invoice_no,
      (inv.gross_amount - inv.allocated_amount),
      pa.name,
      'flexible'::text,
      'normal'::text,
      inv.currency
    from public.invoices inv
    join public.parties pa on pa.id = inv.party_id
    where inv.direction = 'purchase'
      and inv.status in ('open', 'partial')
      and inv.gross_amount > inv.allocated_amount
      and not (
        inv.settled_by_check_id is not null
        and exists (
          select 1 from public.checks c0
          where c0.id = inv.settled_by_check_id
            and c0.archived_at is null
            and c0.status <> 'cancelled'
        )
      )
      and not exists (
        select 1
        from public.payment_instances pi2
        left join public.payments p2 on p2.id = pi2.payment_id
        where pi2.linked_invoice_id = inv.id
          and pi2.status <> 'cancelled'
          and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
      )
      and not exists (
        select 1
        from public.checks c2
        where c2.linked_invoice_id = inv.id
          and c2.archived_at is null
          and c2.status <> 'cancelled'
      )

    union all

    select
      'loan_installment'::text,
      li.id,
      li.due_date,
      l.name,
      case
        when li.status = 'partial' then greatest(0, li.amount - coalesce(li.paid_amount, 0))
        else li.amount
      end,
      '',
      'critical'::text,
      'critical'::text,
      l.currency
    from public.loan_installments li
    join public.loans l on l.id = li.loan_id
    where li.status in ('planned', 'unpaid', 'partial', 'late')
      and l.archived_at is null

    union all

    select
      'check'::text,
      c.id,
      c.maturity_date,
      coalesce(c.counterparty_label, 'çek'),
      c.amount,
      coalesce(pe.name, ''),
      'critical'::text,
      'critical'::text,
      c.currency
    from public.checks c
    left join public.parties pe on pe.id = c.payee_party_id
    where c.status in ('planned', 'unknown', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
      and c.archived_at is null
      and c.direction = 'outflow'
  ) src
  where src.due_date is not null;

create or replace view public.payment_calendar_extended
with (security_invoker = true) as
  select
    q.due_date,
    count(*)                                                as item_count,
    count(*) filter (where q.amount is null)                as unknown_amount_count,
    coalesce(sum(q.amount) filter (where q.currency = 'TRY'), 0)                                        as known_total,
    coalesce(sum(q.amount) filter (where q.flexibility_class = 'critical' and q.currency = 'TRY'), 0)   as critical_total,
    count(*) filter (where q.kind = 'payment_instance')     as payment_instance_count,
    count(*) filter (where q.kind = 'invoice')              as invoice_count,
    count(*) filter (where q.kind = 'loan_installment')     as loan_installment_count,
    count(*) filter (where q.kind = 'check')                as check_count,
    bool_or(q.overdue)                                      as has_overdue,
    count(*) filter (where q.currency is not null and q.currency <> 'TRY') as foreign_currency_count,
    count(*) filter (where q.currency is null)              as unknown_currency_count
  from public.payment_priority_queue q
  group by q.due_date;

-- control_dashboard: korelasyonlu LATERAL alt sorgular yerine tek taramalı CTE UNION ALL toplamı
create or replace view public.control_dashboard
with (security_invoker = true) as
  with counts(check_code, finding_count) as (
    select 'duplicate_invoice'::text,       count(*)::bigint from public.control_duplicate_invoices
    union all
    select 'near_duplicate_bank_txn'::text, count(*)::bigint from public.control_near_duplicate_bank_txns
    union all
    select 'allocation_over_invoice'::text, count(*)::bigint from public.control_allocation_over_invoice
    union all
    select 'payment_without_invoice'::text, count(*)::bigint from public.control_payment_without_invoice
    union all
    select 'unmatched_bank_txn_aged'::text, count(*)::bigint from public.control_unmatched_bank_aged
    union all
    select 'unknown_counterparty'::text,    count(*)::bigint from public.checks
     where counterparty_label is not null and payee_party_id is null
    union all
    select 'iban_changed'::text,            count(*)::bigint from public.control_iban_changes where is_recent
    union all
    select 'large_payment'::text,           count(*)::bigint from public.control_large_payments
    union all
    select 'closed_period_mutation'::text,  count(*)::bigint from public.control_closed_period_mutations
    union all
    select 'approval_bypass'::text,         count(*)::bigint from public.control_approval_bypass
    union all
    select 'missing_source_document'::text, count(*)::bigint from public.control_missing_source_document
  )
  select
    r.check_code,
    r.title,
    r.default_severity,
    r.enforcement,
    r.rationale,
    coalesce(c.finding_count, 0) as finding_count,
    case
      when coalesce(c.finding_count, 0) = 0 then 'PASS'
      when r.default_severity = 'critical' then 'CRITICAL'
      when r.default_severity = 'warning' then 'WARNING'
      else 'INFO'
    end                          as state
  from public.control_registry r
  left join counts c on c.check_code = r.check_code;

-- ── 4) Şema tutarlılığı, durum makinesi, 8 kısıt doğrulama ve sıcak FK indeksleri ───────────

-- 4a) 0083 çatışması: public.attachments.document_id FK kuralını ON DELETE CASCADE -> ON DELETE RESTRICT yap
do $att_fk$
declare
  r record;
begin
  for r in
    select c.conname, c.confdeltype
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = 'public.attachments'::regclass
      and c.confrelid = 'public.documents'::regclass
      and c.contype = 'f'
      and a.attname = 'document_id'
  loop
    if r.confdeltype <> 'r' then
      execute format('alter table public.attachments drop constraint %I', r.conname);
    end if;
  end loop;

  if not exists (
    select 1
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = 'public.attachments'::regclass
      and c.confrelid = 'public.documents'::regclass
      and c.contype = 'f'
      and a.attname = 'document_id'
      and c.confdeltype = 'r'
  ) then
    alter table public.attachments
      add constraint attachments_document_id_fkey
      foreign key (document_id) references public.documents(id) on delete restrict;
  end if;
end $att_fk$;

-- 4b) 0034 geçiş bekçileri: payment_instances (unpaid->late, planned->late) ve checks (bounced->cleared, bounced->cancelled)
create or replace function public.payment_instances_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('unpaid', 'paid'), ('planned', 'paid'), ('late', 'paid'), ('partial', 'paid'),
    ('unpaid', 'partial'), ('planned', 'partial'), ('late', 'partial'),
    ('unpaid', 'late'), ('planned', 'late'),
    ('paid', 'unpaid'),
    ('unpaid', 'cancelled'), ('planned', 'cancelled'), ('late', 'cancelled')
  ) then
    raise exception 'payment_instances.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

create or replace function public.checks_status_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (
    ('planned', 'cleared'), ('planned', 'bounced'),
    ('planned', 'cancelled'),
    ('bounced', 'cleared'), ('bounced', 'cancelled')
  ) then
    raise exception 'checks.% status geçişi %→% izinli değil', old.id, old.status, new.status;
  end if;
  return new;
end $$;

-- 4c) 0023 ve 0025 içindeki 8 NOT VALID kısıtın doğrulanması (VALIDATE CONSTRAINT)
alter table public.payments            validate constraint payments_archive_consistency;
alter table public.checks              validate constraint checks_archive_triplet_consistency;
alter table public.loans               validate constraint loans_archive_triplet_consistency;
alter table public.scenario_runs       validate constraint scenario_runs_archive_triplet_consistency;
alter table public.external_assumptions validate constraint external_assumptions_archive_triplet_consistency;
alter table public.action_items        validate constraint action_items_archive_triplet_consistency;
alter table public.payment_instances   validate constraint payment_instances_paid_fields_scoped;
alter table public.loan_installments   validate constraint loan_installments_paid_fields_scoped;

-- 4d) Serbest currency kolonu taşıyan tüm tablolarda ISO-4217 3 büyük harf CHECK kısıtı
do $cur_chk$
declare
  r record;
  v_conname text;
begin
  for r in
    select col.table_name, col.column_name
    from information_schema.columns col
    join information_schema.tables tbl
      on tbl.table_schema = col.table_schema
     and tbl.table_name = col.table_name
    where col.table_schema = 'public'
      and tbl.table_type = 'BASE TABLE'
      and col.column_name in ('currency', 'base_currency', 'quote_currency', 'credit_limit_currency')
      and col.data_type in ('text', 'character varying')
    order by col.table_name, col.column_name
  loop
    v_conname := r.table_name || '_' || r.column_name || '_iso4217_chk';
    if not exists (
      select 1
      from pg_constraint c
      where c.conrelid = format('public.%I', r.table_name)::regclass
        and c.conname = v_conname
    ) then
      execute format(
        'alter table public.%I add constraint %I check (%I is null or %I ~ ''^[A-Z]{3}$'')',
        r.table_name, v_conname, r.column_name, r.column_name
      );
    end if;
  end loop;
end $cur_chk$;

-- 4e) Eksik sıcak FK ve bileşik B-tree indeksleri
create index if not exists invoices_party_id_idx
  on public.invoices (party_id);

create index if not exists payment_instances_payment_status_due_idx
  on public.payment_instances (payment_id, status, due_date);

create index if not exists bank_transactions_account_status_txn_date_idx
  on public.bank_transactions (bank_account_id, status, txn_date);

create index if not exists invoice_allocations_invoice_all_idx
  on public.invoice_allocations (invoice_id);

create index if not exists loan_installments_loan_status_due_idx
  on public.loan_installments (loan_id, status, due_date);

create index if not exists checks_status_maturity_idx
  on public.checks (status, maturity_date);

create index if not exists approvals_subject_status_idx
  on public.approvals (subject_table, subject_id, status);

-- ── 5) Görünüm yetkileri ve security_invoker = true / kısıt kendi-kendini doğrulama ─────────
do $grants$
declare
  v_name text;
  v_views constant text[] := array[
    'counterparty_exposure_items',
    'debt_maturity_ladder',
    'debt_maturity_ladder_by_currency',
    'liquidity_forecast_daily',
    'financial_calendar',
    'financial_calendar_daily',
    'bank_cash_position',
    'treasury_position_summary',
    'treasury_liquidity_gap',
    'treasury_cashflow_reconciliation',
    'current_account_ledger',
    'control_large_payments',
    'control_approval_bypass',
    'cash_forecast_13w',
    'optimization_run_summary',
    'budget_vs_actual',
    'budget_variance_summary',
    'payment_priority_queue',
    'payment_calendar_extended',
    'control_dashboard'
  ];
begin
  foreach v_name in array v_views loop
    execute format('alter view public.%I set (security_invoker = true)', v_name);
    execute format(
      'revoke insert, update, delete, truncate on table public.%I from public, anon, authenticated, '
      'mas_radar_app, mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, '
      'mas_radar_finance_manager, mas_radar_admin',
      v_name
    );
    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, '
      'mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      v_name
    );
  end loop;
end $grants$;

do $verify$
declare
  v_unprotected_views text;
  v_unvalidated text;
  v_att_deltype "char";
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_unprotected_views
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'v'
     and not ('security_invoker=true' = any(coalesce(c.reloptions, array[]::text[])));

  if v_unprotected_views is not null then
    raise exception '0099: security_invoker=true eksik görünümler: %', v_unprotected_views;
  end if;

  select string_agg(c.conname, ', ' order by c.conname)
    into v_unvalidated
    from pg_constraint c
   where c.conname in (
     'payments_archive_consistency',
     'checks_archive_triplet_consistency',
     'loans_archive_triplet_consistency',
     'scenario_runs_archive_triplet_consistency',
     'external_assumptions_archive_triplet_consistency',
     'action_items_archive_triplet_consistency',
     'payment_instances_paid_fields_scoped',
     'loan_installments_paid_fields_scoped'
   )
     and not c.convalidated;

  if v_unvalidated is not null then
    raise exception '0099: doğrulanmamış kısıtlar kaldı: %', v_unvalidated;
  end if;

  select c.confdeltype
    into v_att_deltype
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.conrelid = 'public.attachments'::regclass
     and c.confrelid = 'public.documents'::regclass
     and c.contype = 'f'
     and a.attname = 'document_id';

  if v_att_deltype is distinct from 'r' then
    raise exception '0099: attachments.document_id FK ON DELETE RESTRICT değil (confdeltype=%)', v_att_deltype;
  end if;
end $verify$;
