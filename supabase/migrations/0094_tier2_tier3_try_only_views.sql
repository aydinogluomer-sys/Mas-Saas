-- PHASE 2.2 — Tier 3 (SQL view'ları) + Tier 2'nin SQL tarafı: her para toplamı YALNIZ TRY.
--
-- ═══ UYGULANMADI — DİKKAT ═══
-- Yazıldığı anda hiçbir gerçek veritabanına uygulanmadı; taşınabilir PostgreSQL'de fresh DB ve
-- gerçek yedeğin klonu üzerinde doğrulandı (phase2-tier2-tier3-closure.md). Numaralandırma 0093'ün
-- ardına (0088–0091 import-v2 dalında; birleşme notu 0092'de).
--
-- ═══ POLİTİKA ═══
-- Plan §2.1: controlled use için TRY-only; `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED`.
-- Kur çevirimi YOK. Her toplam yalnız `currency = 'TRY'` (ya da hesabın/facility'nin kendi para
-- birimi) satırlarından; dışarıda kalan satırlar SESSİZCE DÜŞMEZ — her view'a `*_count` kolonu
-- eklenir ve ekran "n kalem TRY-dışı — toplamda yok" der (plan §2.3). Para birimi kolonu olmayan
-- tablolar (checks, loans, loan_installments, cashflow_*) yapısal TRY'dir ve süzülmez.
--
-- ═══ create or replace view KURALI ═══
-- Mevcut kolonların adı/tipi/sırası korunur; yeni kolonlar SONA eklenir. Bağımlı view'lar
-- (treasury_position_summary → bank_cash_position, working_capital_metrics → dso_dpo_components,
-- payment_calendar_extended → payment_priority_queue, counterparty_collection_profile →
-- receivable_collection_signals, debt_maturity_ladder → credit_facility_utilization) bu yüzden
-- kırılmaz. Yayımlanmış migration'lar (0043/0047/0050/0052/0061/0063/0067/0070/0075/0078/0082)
-- yeniden yazılmadı — forward-only.
--
-- Kapsam (phase2-currency-scan.md): #16 #30 #31 #35 #36 #37 #38 #40 #43 #45 #46 #47 #48 #55 #56 #58 #62.

-- ── #30 credit_facility_utilization: çekiş ancak facility'nin para birimindeyse toplanır ─────
create or replace view public.credit_facility_utilization as
  select
    f.id                                            as facility_id,
    f.name                                          as facility_name,
    f.facility_type,
    f.currency,
    f.status,
    p.name                                          as lender_name,
    f.limit_amount,
    f.interest_rate,
    f.start_date,
    f.expiry_date,
    f.review_date,
    coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0)               as drawn_amount,
    greatest(0, f.limit_amount - coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0)) as available_amount,
    case
      when f.limit_amount = 0 then null
      else round(coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0) / f.limit_amount, 4)
    end                                             as utilization_ratio,
    (coalesce(sum(d.signed_amount) filter (where d.currency = f.currency), 0) > f.limit_amount) as over_limit,
    count(d.id)                                     as movement_count,
    max(d.movement_date)                            as last_movement_date,
    case
      when f.expiry_date is null then null
      else (f.expiry_date - current_date)
    end                                             as days_to_expiry,
    -- PHASE 2.2: facility para biriminden farklı çekişler — kullanım oranına girmedi.
    count(d.id) filter (where d.currency <> f.currency) as foreign_drawdown_count
  from public.credit_facilities f
  left join public.parties p on p.id = f.lender_party_id
  left join public.facility_drawdowns d on d.facility_id = f.id
  group by f.id, f.name, f.facility_type, f.currency, f.status, p.name,
           f.limit_amount, f.interest_rate, f.start_date, f.expiry_date, f.review_date;

-- ── #31 debt_maturity_ladder: TRY taksit + yalnız TRY facility ─────────────────────────────
create or replace view public.debt_maturity_ladder as
  with buckets(bucket_days, bucket_label, sort_order) as (
    values (30, '0-30 gün', 1), (90, '31-90 gün', 2), (180, '91-180 gün', 3), (365, '181-365 gün', 4)
  ),
  bounds as (
    select bucket_days, bucket_label, sort_order,
           case sort_order when 1 then 0 when 2 then 30 when 3 then 90 else 180 end as from_days
    from buckets
  ),
  installments as (
    select b.sort_order,
           coalesce(sum(li.amount), 0) as installment_due,
           count(li.id)                as installment_count
    from bounds b
    left join public.loan_installments li
      on li.status in ('unpaid', 'partial')
     and li.due_date >= current_date + b.from_days
     and li.due_date <  current_date + b.bucket_days
    group by b.sort_order
  ),
  expiries as (
    select b.sort_order,
           coalesce(sum(u.drawn_amount) filter (where u.currency = 'TRY'), 0) as facility_drawn_expiring,
           coalesce(sum(u.limit_amount) filter (where u.currency = 'TRY'), 0) as facility_limit_expiring,
           count(u.facility_id)                                              as facility_count,
           count(u.facility_id) filter (where u.currency <> 'TRY')           as foreign_facility_count
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
    -- PHASE 2.2: TRY-dışı facility'ler toplama girmedi.
    e.foreign_facility_count
  from bounds b
  join installments i on i.sort_order = b.sort_order
  join expiries e on e.sort_order = b.sort_order;

-- ── #35 bank_reconciliation_summary: yalnız hesabın para birimindeki hareketler toplanır ───
create or replace view public.bank_reconciliation_summary as
  select
    ba.cash_account_id                                                    as bank_account_id,
    ca.name                                                               as account_name,
    ba.iban_normalized,
    count(t.id)                                                           as transaction_count,
    count(t.id) filter (where t.status = 'unmatched')                     as unmatched_count,
    count(t.id) filter (where t.status = 'suggested')                     as suggested_count,
    count(t.id) filter (where t.status = 'matched')                       as matched_count,
    count(t.id) filter (where t.status = 'reconciled')                    as reconciled_count,
    count(t.id) filter (where t.status = 'ignored')                       as ignored_count,
    coalesce(sum(t.amount) filter (where t.direction = 'inflow'  and t.currency = ca.currency), 0) as inflow_total,
    coalesce(sum(t.amount) filter (where t.direction = 'outflow' and t.currency = ca.currency), 0) as outflow_total,
    coalesce(sum(t.amount) filter (where t.currency = ca.currency), 0)   as net_total,
    min(t.txn_date)                                                       as first_txn_date,
    max(t.txn_date)                                                       as last_txn_date,
    ba.available_balance,
    ba.last_statement_date,
    ca.currency                                                           as account_currency,
    count(t.id) filter (where t.currency <> ca.currency)                  as foreign_currency_count
  from public.bank_accounts ba
  join public.cash_accounts ca on ca.id = ba.cash_account_id
  left join public.bank_transactions t on t.bank_account_id = ba.cash_account_id
  group by ba.cash_account_id, ca.name, ba.iban_normalized, ba.available_balance, ba.last_statement_date, ca.currency;

-- ── #36 bank_match_conflicts ────────────────────────────────────────────────────────────────
create or replace view public.bank_match_conflicts as
  select
    t.matched_entity_table,
    t.matched_entity_id,
    count(*)                        as claim_count,
    array_agg(t.id order by t.txn_date) as bank_transaction_ids,
    sum(t.amount) filter (where t.currency = 'TRY') as claimed_total,
    count(*) filter (where t.currency <> 'TRY')     as foreign_currency_count
  from public.bank_transactions t
  where t.matched_entity_id is not null
  group by t.matched_entity_table, t.matched_entity_id
  having count(*) > 1;

-- ── #37 bank_cash_position: türetilmiş bakiye yalnız hesabın para birimindeki hareketlerle ──
create or replace view public.bank_cash_position as
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
    coalesce(ca.opening_balance, 0)
      + coalesce(sum(bt.amount) filter (where bt.status <> 'ignored' and bt.currency = ca.currency), 0) as derived_balance,
    count(bt.id) filter (where bt.status <> 'ignored')                    as movement_count,
    max(bt.txn_date)                                                      as last_movement_date,
    case
      when ba.available_balance is null then null
      else ba.available_balance
           - (coalesce(ca.opening_balance, 0)
              + coalesce(sum(bt.amount) filter (where bt.status <> 'ignored' and bt.currency = ca.currency), 0))
    end                                                                   as stated_minus_derived,
    -- PHASE 2.2: hesabın para biriminden farklı hareketler — bakiyeye girmedi (veri hatası işareti).
    count(bt.id) filter (where bt.status <> 'ignored' and bt.currency <> ca.currency) as foreign_txn_count
  from public.cash_accounts ca
  left join public.bank_accounts ba on ba.cash_account_id = ca.id
  left join public.bank_transactions bt on bt.bank_account_id = ba.cash_account_id
  group by ca.id, ca.name, ca.currency, ca.is_active, ba.bank_name, ba.iban,
           ba.available_balance, ba.blocked_balance, ba.overdraft_limit, ba.balance_as_of,
           ca.opening_balance;

-- ── #38 daily_cash_movement: aynı süzgeç ──────────────────────────────────────────────────
create or replace view public.daily_cash_movement as
  select
    bt.txn_date,
    ca.currency,
    sum(bt.amount) filter (where bt.amount > 0 and bt.currency = ca.currency)  as inflow,
    sum(bt.amount) filter (where bt.amount < 0 and bt.currency = ca.currency)  as outflow,
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

-- ── #40 liquidity_forecast_daily: fatura ayağı GERÇEK para birimini taşır ──────────────────
-- 0063 `'TRY'` literal yazıyordu; 0080 financial_calendar `v.currency` kullanıyordu — iki "aynı
-- yükümlülük" view'ı TRY-dışı faturada çelişiyordu. Artık ikisi de gerçek kolonu okur;
-- treasury_liquidity_gap `group by currency` ile TRY-dışı faturayı TRY açığına katmaz.
create or replace view public.liquidity_forecast_daily as
  select
    pi.due_date                                   as flow_date,
    coalesce(pi.currency, 'TRY')                  as currency,
    'payment_instance'::text                      as source_kind,
    pi.id                                         as source_id,
    -case when pi.direction = 'inflow' then -pi.amount else pi.amount end as amount_signed,
    'contracted'::text                            as certainty
  from public.payment_instances pi
  where pi.status in ('unpaid', 'partial') and pi.due_date is not null and pi.amount is not null
  union all
  select li.due_date, 'TRY', 'loan_installment', li.id, -li.amount, 'contracted'
  from public.loan_installments li
  where li.status in ('unpaid', 'partial') and li.due_date is not null and li.amount is not null
  union all
  select c.maturity_date, 'TRY', 'check', c.id, c.signed_amount, 'contracted'
  from public.checks c
  where c.status in ('unpaid', 'partial', 'planned')
    and c.maturity_date is not null and c.signed_amount is not null
  union all
  select v.due_date, v.currency, 'invoice', v.id,
         case when v.direction = 'sales'
              then (v.gross_amount - coalesce(v.allocated_amount, 0))
              else -(v.gross_amount - coalesce(v.allocated_amount, 0)) end,
         'contracted'
  from public.invoices v
  where v.status in ('open', 'partial') and v.due_date is not null and v.gross_amount is not null
  union all
  select p.promised_date, p.currency, 'promise_to_pay', p.id, p.promised_amount, 'expected'
  from public.promise_to_pay p
  where p.status = 'pending' and p.promised_amount is not null;

-- ── #43 treasury_cashflow_reconciliation: cashflow_months yapısal TRY → yalnız TRY koşusu ──
create or replace view public.treasury_cashflow_reconciliation as
  with month_end as (
    select
      date_trunc('month', bt.txn_date)::date          as month_start,
      ca.currency,
      sum(bt.amount)                                   as month_net
    from public.bank_transactions bt
    join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
    join public.cash_accounts ca on ca.id = ba.cash_account_id
    where bt.status <> 'ignored' and bt.currency = ca.currency
    group by 1, 2
  ),
  running as (
    select
      m.month_start,
      m.currency,
      m.month_net,
      sum(m.month_net) over (partition by m.currency order by m.month_start) as treasury_running_close
    from month_end m
  )
  select
    cm.month_start,
    coalesce(r.currency, 'TRY')                        as currency,
    cm.closing_balance                                 as cashflow_closing,
    r.treasury_running_close                           as treasury_closing,
    case
      when cm.closing_balance is null or r.treasury_running_close is null then null
      else r.treasury_running_close - cm.closing_balance
    end                                                as difference,
    case
      when cm.closing_balance is null                then 'cashflow_missing'
      when r.treasury_running_close is null          then 'no_bank_movement'
      when abs(r.treasury_running_close - cm.closing_balance) <= 1 then 'aligned'
      else 'divergent'
    end                                                as reconciliation_status
  from public.cashflow_months cm
  left join running r
    on r.month_start = cm.month_start
   and r.currency = 'TRY'
  order by cm.month_start;

-- ── #45 invoice_party_summary ───────────────────────────────────────────────────────────────
create or replace view public.invoice_party_summary as
  select
    pa.id                                                                    as party_id,
    pa.name                                                                  as party_name,
    count(i.id) filter (where i.direction = 'sales')                         as sales_count,
    count(i.id) filter (where i.direction = 'purchase')                      as purchase_count,
    coalesce(sum(i.gross_amount) filter (where i.direction = 'sales' and i.status in ('open','partial') and i.currency = 'TRY'), 0)    as receivable_open,
    coalesce(sum(i.paid_amount)  filter (where i.direction = 'sales' and i.status in ('open','partial') and i.currency = 'TRY'), 0)    as receivable_paid,
    coalesce(sum(i.gross_amount) filter (where i.direction = 'purchase' and i.status in ('open','partial') and i.currency = 'TRY'), 0) as payable_open,
    coalesce(sum(i.paid_amount)  filter (where i.direction = 'purchase' and i.status in ('open','partial') and i.currency = 'TRY'), 0) as payable_paid,
    count(i.id) filter (where i.status = 'cancelled')                        as cancelled_count,
    min(i.due_date) filter (where i.status in ('open','partial'))            as earliest_due_date,
    count(i.id) filter (where i.status in ('open','partial') and i.currency <> 'TRY') as foreign_currency_count
  from public.parties pa
  left join public.invoices i on i.party_id = pa.id
  group by pa.id, pa.name;

-- ── #46 current_account_summary ─────────────────────────────────────────────────────────────
create or replace view public.current_account_summary as
  select
    pa.id                                                                  as party_id,
    pa.name                                                                as party_name,
    pa.party_type,
    coalesce(sum(i.gross_amount) filter (where i.direction='sales'    and i.status in ('open','partial') and i.currency = 'TRY'), 0)
      - coalesce(sum(i.allocated_amount) filter (where i.direction='sales'    and i.status in ('open','partial') and i.currency = 'TRY'), 0)
                                                                           as receivable_open,
    coalesce(sum(i.gross_amount) filter (where i.direction='purchase' and i.status in ('open','partial') and i.currency = 'TRY'), 0)
      - coalesce(sum(i.allocated_amount) filter (where i.direction='purchase' and i.status in ('open','partial') and i.currency = 'TRY'), 0)
                                                                           as payable_open,
    count(i.id) filter (where i.direction='sales'    and i.status in ('open','partial'))  as receivable_count,
    count(i.id) filter (where i.direction='purchase' and i.status in ('open','partial'))  as payable_count,
    count(i.id) filter (where i.status in ('open','partial') and i.due_date < current_date) as overdue_count,
    min(i.due_date) filter (where i.status in ('open','partial'))          as earliest_due_date,
    coalesce(sum(i.gross_amount) filter (where i.direction='sales' and i.currency = 'TRY'), 0)    as sales_total_all_time,
    coalesce(sum(i.gross_amount) filter (where i.direction='purchase' and i.currency = 'TRY'), 0) as purchase_total_all_time,
    max(i.issue_date)                                                      as last_invoice_date,
    count(i.id) filter (where i.currency <> 'TRY')                         as foreign_currency_count
  from public.parties pa
  left join public.invoices i on i.party_id = pa.id and i.status <> 'cancelled'
  group by pa.id, pa.name, pa.party_type;

-- ── #47 dso_dpo_components (working_capital_metrics bunu okur → otomatik TRY-only) ─────────
create or replace view public.dso_dpo_components as
  select
    (select coalesce(sum(gross_amount - allocated_amount), 0)
       from public.invoices
      where direction='sales' and status in ('open','partial') and currency = 'TRY')             as receivables_open,
    (select coalesce(sum(gross_amount - allocated_amount), 0)
       from public.invoices
      where direction='purchase' and status in ('open','partial') and currency = 'TRY')          as payables_open,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='sales' and status <> 'cancelled' and currency = 'TRY'
        and issue_date >= current_date - 365)                                                   as sales_365,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='purchase' and status <> 'cancelled' and currency = 'TRY'
        and issue_date >= current_date - 365)                                                   as purchases_365,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='sales' and status <> 'cancelled' and currency = 'TRY'
        and issue_date >= current_date - 90)                                                    as sales_90,
    (select coalesce(sum(gross_amount), 0) from public.invoices
      where direction='purchase' and status <> 'cancelled' and currency = 'TRY'
        and issue_date >= current_date - 90)                                                    as purchases_90,
    (select count(*) from public.invoices
      where status <> 'cancelled' and currency <> 'TRY')                                        as foreign_currency_count;

-- ── #48 working_capital_trend (0082 tanımı + TRY süzgeci) ───────────────────────────────────
create or replace view public.working_capital_trend as
  with months as (
    select distinct date_trunc('month', issue_date)::date as period_start
    from public.invoices
    where issue_date is not null and status <> 'cancelled'
  ),
  agg as (
    select
      m.period_start,
      coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0))
        filter (where v.direction = 'sales' and v.status in ('open', 'partial') and v.currency = 'TRY'), 0)
        as receivables_open,
      coalesce(sum(v.gross_amount - coalesce(v.allocated_amount, 0))
        filter (where v.direction = 'purchase' and v.status in ('open', 'partial') and v.currency = 'TRY'), 0)
        as payables_open,
      coalesce(sum(v.gross_amount)
        filter (where v.direction = 'sales' and v.status <> 'cancelled' and v.currency = 'TRY'
                  and v.issue_date > (m.period_start - interval '365 days')), 0)
        as sales_365,
      coalesce(sum(v.gross_amount)
        filter (where v.direction = 'purchase' and v.status <> 'cancelled' and v.currency = 'TRY'
                  and v.issue_date > (m.period_start - interval '365 days')), 0)
        as purchases_365,
      count(v.id) filter (where v.status <> 'cancelled' and v.currency <> 'TRY') as foreign_currency_count
    from months m
    left join public.invoices v
      on v.issue_date is not null
     and v.issue_date <= (m.period_start + interval '1 month' - interval '1 day')
    group by m.period_start
  )
  select
    period_start,
    receivables_open,
    payables_open,
    case when sales_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0), 1) end as dso_days,
    case when purchases_365 = 0 then null
         else round(payables_open / (purchases_365 / 365.0), 1) end as dpo_days,
    null::numeric                                                   as dio_days,
    case when sales_365 = 0 or purchases_365 = 0 then null
         else round(receivables_open / (sales_365 / 365.0)
                  - payables_open / (purchases_365 / 365.0), 1) end as cash_cycle_excluding_inventory,
    foreign_currency_count
  from agg
  order by period_start;

-- ── #55 payment_priority_queue: currency kolonu sona eklenir; takvim toplamı yalnız TRY ─────
create or replace view public.payment_priority_queue as
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
      i.amount,
      coalesce(pr.name, '')                             as party_name,
      coalesce(p.flexibility_class, 'flexible')         as flexibility_class,
      coalesce(p.priority, 'normal')                    as priority,
      i.currency
    from public.payment_instances i
    left join public.payments p on p.id = i.payment_id
    left join public.parties pr on pr.id = p.provider_party_id
    where i.status in ('unpaid', 'partial', 'planned', 'late')
    union all
    select
      'invoice', inv.id, coalesce(inv.due_date, inv.issue_date),
      inv.invoice_no, (inv.gross_amount - inv.allocated_amount), pa.name,
      'flexible', 'normal', inv.currency
    from public.invoices inv
    join public.parties pa on pa.id = inv.party_id
    where inv.direction = 'purchase' and inv.status in ('open', 'partial')
      and inv.gross_amount > inv.allocated_amount
    union all
    select
      'loan_installment', li.id, li.due_date, l.name, li.amount, '',
      'critical', 'critical', 'TRY'
    from public.loan_installments li
    join public.loans l on l.id = li.loan_id
    where li.status in ('planned', 'unpaid', 'partial', 'late') and l.archived_at is null
    union all
    select
      'check', c.id, c.maturity_date,
      coalesce(c.counterparty_label, 'çek'), c.amount, coalesce(pe.name, ''),
      'critical', 'critical', 'TRY'
    from public.checks c
    left join public.parties pe on pe.id = c.payee_party_id
    where c.status in ('planned', 'unknown') and c.archived_at is null
      and c.direction = 'outflow'
  ) src
  where src.due_date is not null;

create or replace view public.payment_calendar_extended as
  select
    q.due_date,
    count(*)                                                as item_count,
    count(*) filter (where q.amount is null)                as unknown_amount_count,
    coalesce(sum(q.amount) filter (where q.currency = 'TRY'), 0)                              as known_total,
    coalesce(sum(q.amount) filter (where q.flexibility_class = 'critical' and q.currency = 'TRY'), 0) as critical_total,
    count(*) filter (where q.kind = 'payment_instance')     as payment_instance_count,
    count(*) filter (where q.kind = 'invoice')              as invoice_count,
    count(*) filter (where q.kind = 'loan_installment')     as loan_installment_count,
    count(*) filter (where q.kind = 'check')                as check_count,
    bool_or(q.overdue)                                      as has_overdue,
    count(*) filter (where q.currency <> 'TRY')             as foreign_currency_count
  from public.payment_priority_queue q
  group by q.due_date;

-- ── #56 receivable_collection_signals + counterparty_collection_profile ─────────────────────
-- Sinyal view'ına `currency` sona eklenir (0052'deki gövde aynen; yalnız son kolon yeni).
create or replace view public.receivable_collection_signals as
  select
    i.id                                            as invoice_id,
    i.party_id,
    pa.name                                         as party_name,
    i.invoice_no,
    i.issue_date,
    i.due_date,
    i.gross_amount,
    i.allocated_amount,
    (i.gross_amount - i.allocated_amount)           as open_amount,
    i.status,
    (i.bad_debt_at is not null)                     as bad_debt_flagged,
    i.bad_debt_reason,
    case when i.due_date is null then null else (current_date - i.due_date) end as days_overdue,
    spd.avg_days_to_settle                          as party_avg_days_to_settle,
    spd.settled_invoice_count                       as party_settled_count,
    hist.late_ratio                                 as party_late_ratio,
    hist.invoice_count                              as party_invoice_count,
    (i.allocated_amount > 0)                        as partially_settled,
    i.currency
  from public.invoices i
  join public.parties pa on pa.id = i.party_id
  left join public.counterparty_settlement_speed spd
    on spd.party_id = i.party_id and spd.direction = 'sales'
  left join (
    select
      h.party_id,
      count(*)                                                              as invoice_count,
      round(
        count(*) filter (where h.settled_late)::numeric
        / nullif(count(*), 0), 4)                                           as late_ratio
    from (
      select
        inv.party_id,
        inv.id,
        (max(a.allocated_on) > inv.due_date) as settled_late
      from public.invoices inv
      join public.invoice_allocations a on a.invoice_id = inv.id and a.reversed_at is null
      where inv.direction = 'sales' and inv.status <> 'cancelled' and inv.due_date is not null
      group by inv.party_id, inv.id, inv.due_date
    ) h
    group by h.party_id
  ) hist on hist.party_id = i.party_id
  where i.direction = 'sales'
    and i.status in ('open', 'partial')
    and i.gross_amount > i.allocated_amount;

create or replace view public.counterparty_collection_profile as
  select
    pa.id                                                   as party_id,
    pa.name                                                 as party_name,
    count(distinct s.invoice_id)                            as open_receivable_count,
    coalesce(sum(s.open_amount) filter (where s.currency = 'TRY'), 0)                          as open_receivable_amount,
    count(distinct s.invoice_id) filter (where s.days_overdue > 0)   as overdue_count,
    coalesce(sum(s.open_amount) filter (where s.days_overdue > 0 and s.currency = 'TRY'), 0)   as overdue_amount,
    count(distinct s.invoice_id) filter (where s.bad_debt_flagged)   as bad_debt_count,
    coalesce(sum(s.open_amount) filter (where s.bad_debt_flagged and s.currency = 'TRY'), 0)   as bad_debt_amount,
    max(s.days_overdue)                                     as worst_days_overdue,
    max(s.party_avg_days_to_settle)                         as avg_days_to_settle,
    max(s.party_late_ratio)                                 as late_ratio,
    count(distinct s.invoice_id) filter (where s.currency <> 'TRY') as foreign_currency_count
  from public.parties pa
  join public.receivable_collection_signals s on s.party_id = pa.id
  group by pa.id, pa.name;

-- ── #58 party_promise_history: bekleyen söz tutarı yalnız TRY ───────────────────────────────
create or replace view public.party_promise_history as
  select
    p.party_id,
    count(*) filter (where p.status in ('kept', 'broken'))            as resolved_count,
    count(*) filter (where p.status = 'kept')                          as kept_count,
    count(*) filter (where p.status = 'broken')                        as broken_count,
    count(*) filter (where p.status = 'pending')                       as pending_count,
    count(*) filter (where p.status = 'cancelled')                     as cancelled_count,
    coalesce(sum(p.promised_amount) filter (where p.status = 'pending' and p.currency = 'TRY'), 0) as pending_amount,
    case
      when count(*) filter (where p.status in ('kept', 'broken')) = 0 then null
      else round(
        count(*) filter (where p.status = 'kept')::numeric
        / count(*) filter (where p.status in ('kept', 'broken')),
        4)
    end                                                                as kept_ratio,
    max(p.promised_date) filter (where p.status = 'broken')            as last_broken_date,
    count(*) filter (where p.status = 'pending' and p.currency <> 'TRY') as foreign_pending_count
  from public.promise_to_pay p
  group by p.party_id;

-- ── #62 forecast_accuracy: yalnız tahminin para birimindeki satırlar ────────────────────────
create or replace view public.forecast_accuracy as
  select
    f.id                                          as forecast_id,
    f.name                                        as forecast_name,
    f.horizon_kind,
    f.anchor_date,
    l.source_kind,
    count(*)                                      as measured_line_count,
    sum(l.amount)                                 as forecast_total,
    sum(l.actual_amount)                          as actual_total,
    sum(l.actual_amount - l.amount)               as bias_total,
    sum(abs(l.actual_amount - l.amount))          as absolute_error_total,
    case
      when count(*) filter (where l.amount <> 0) = 0 then null
      else round(
        avg(abs(l.actual_amount - l.amount) / abs(l.amount))
          filter (where l.amount <> 0), 4)
    end                                           as mape,
    count(*) filter (where l.amount = 0)          as zero_forecast_lines,
    (select count(*) from public.forecast_lines x
      where x.forecast_id = f.id and x.actual_amount is not null
        and x.version_status in ('approved', 'superseded')
        and x.currency <> f.currency)             as foreign_line_count
  from public.forecast_lines l
  join public.forecasts f on f.id = l.forecast_id
  where l.actual_amount is not null
    and l.version_status in ('approved', 'superseded')
    and l.currency = f.currency
  group by f.id, f.name, f.horizon_kind, f.anchor_date, l.source_kind;

-- ── #16 anomaly_new_payee / anomaly_amount_vs_baseline ─────────────────────────────────────
create or replace view public.anomaly_new_payee as
  select
    p.provider_party_id        as party_id,
    pa.name                    as party_name,
    min(i.due_date)            as first_payment_date,
    count(*)                   as payment_count,
    sum(i.amount) filter (where i.currency = 'TRY') as total_amount,
    count(*) filter (where i.currency <> 'TRY')     as foreign_currency_count
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  left join public.parties pa on pa.id = p.provider_party_id
  where p.provider_party_id is not null and i.amount is not null
  group by p.provider_party_id, pa.name
  having min(i.due_date) > current_date - 90;

create or replace view public.anomaly_amount_vs_baseline as
  with party_baseline as (
    select p.provider_party_id as party_id,
           avg(i.amount)       as avg_amount,
           count(*)            as sample_count
    from public.payment_instances i
    join public.payments p on p.id = i.payment_id
    where i.amount is not null and p.provider_party_id is not null and i.currency = 'TRY'
    group by p.provider_party_id
    having count(*) >= 4
  )
  select
    i.id                       as payment_instance_id,
    pa.name                    as party_name,
    i.amount,
    b.avg_amount,
    b.sample_count,
    round(i.amount / nullif(b.avg_amount, 0), 2) as times_baseline
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  join party_baseline b on b.party_id = p.provider_party_id
  left join public.parties pa on pa.id = p.provider_party_id
  where i.amount is not null
    and i.currency = 'TRY'
    and b.avg_amount > 0
    and i.amount >= b.avg_amount * 3;

-- Grant'lar view yeniden tanımlanınca korunur; fresh DB sıra bağımsızlığı için yinelenir.
grant select on
  public.credit_facility_utilization, public.debt_maturity_ladder,
  public.bank_reconciliation_summary, public.bank_match_conflicts, public.bank_cash_position,
  public.daily_cash_movement, public.liquidity_forecast_daily, public.treasury_cashflow_reconciliation,
  public.invoice_party_summary, public.current_account_summary, public.dso_dpo_components,
  public.working_capital_trend, public.payment_priority_queue, public.payment_calendar_extended,
  public.receivable_collection_signals, public.counterparty_collection_profile,
  public.party_promise_history, public.forecast_accuracy,
  public.anomaly_new_payee, public.anomaly_amount_vs_baseline
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
