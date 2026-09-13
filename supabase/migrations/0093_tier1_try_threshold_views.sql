-- PHASE 2.2 (T1-c) — Tier 1 SQL: TRY eşiği / TRY limiti yalnız TRY satırlarla karşılaştırılır.
--
-- ═══ UYGULANMADI — DİKKAT ═══
--
-- Bu migration yazıldığı anda HİÇBİR veritabanına uygulanmadı (Docker/DB yoktu). Terfi öncesi
-- tek kullanımlık bir veritabanında `pnpm db:migrate:verify` ile geçmek ZORUNDADIR.
-- Numaralandırma: 0092 ile aynı karar — 0088–0091 `feature/standard-import-v2` dalında.
--
-- ═══ KAPSAM — phase2-currency-scan.md Tier 1 #15 ve #60 ═══
--
-- #15 `anomaly_split_payments` (0078): `sum(i.amount) >= critical_payment_threshold_try`
--     eşiği `_try`; toplam ise para birimine bakmadan alınıyordu. 3 × 40.000 USD aynı gün
--     "120.000 ≥ 100.000 TRY → bölünmüş ödeme" diye alarm üretebilir; 3 × 40.000 TRY + 1 × 30.000
--     USD ise USD'nin gerçek TRY karşılığı eklenmeden yanlış yerde eşiği geçebilirdi.
--     Düzeltme: sayım/toplam/en büyük YALNIZ `currency = 'TRY'`; TRY-dışı kalemler
--     `foreign_currency_count` ile görünür kalır, sessizce düşmez.
--
-- #60 `counterparty_exposure` (0039): `total_exposure` kör toplam; `credit_limit` ise kendi
--     `credit_limit_currency`'siyle. USD limitli bir karşı tarafın TRY maruziyeti "%x kullanım"
--     ve "limit aşıldı" diye raporlanabiliyordu. Düzeltme:
--       - `counterparty_exposure_items` artık `currency` taşır,
--       - `total_exposure` ve `*_amount` toplamları YALNIZ TRY,
--       - limit karşılaştırması YALNIZ `credit_limit_currency = 'TRY'` iken; aksi hâlde
--         `credit_limit_utilization` ve `over_credit_limit` NULL (= bilinmiyor, "aşılmadı" DEĞİL),
--       - `credit_limit_comparable` ve `foreign_currency_count` yeni kolonlar.
--
-- ═══ NEDEN 0039 / 0078 DÜZENLENMİYOR ═══
--
-- Yayımlanmış migration yeniden yazılmaz; forward-only düzeltme (plan §3.5). `create or replace
-- view` mevcut kolonların adını/tipini/sırasını korur, yeni kolonlar SONA eklenir — PostgreSQL'in
-- kuralı budur ve bağımlı view'lar (varsa) kırılmaz.
--
-- ═══ checks / loans PARA BİRİMİ KOLONU — DAL DURUMUNA GÖRE ═══
--
-- `checks.currency` ve `loans.currency` migration 0090 ile gelir ve 0090 şu an yalnız import-v2
-- dalındadır. Bu dosya iki dalda da doğru olmak zorunda: kolon VARSA gerçek kolon okunur, YOKSA
-- tablo yapısal olarak tek para birimlidir ve `'TRY'` yazılır (0063:132'deki gibi "kolon varken
-- literal" DEĞİL — kolon yokken literal, ve kolon gelir gelmez otomatik olarak kolona geçer;
-- birleşmeden sonra yeniden çalıştırma gerekmez çünkü birleşik dalda 0090 < 0093 sırasıyla
-- uygulanır ve o anda kolon vardır).

-- ── 1) anomaly_split_payments — TRY-only bölünmüş ödeme tespiti ──────────────────────────
create or replace view public.anomaly_split_payments as
  with threshold as (
    select coalesce((select (value #>> '{}')::numeric from public.settings
                     where key = 'critical_payment_threshold_try'), 100000) as amount
  )
  select
    p.provider_party_id                                        as party_id,
    pa.name                                                    as party_name,
    i.due_date,
    count(*)      filter (where i.currency = 'TRY')            as payment_count,
    sum(i.amount) filter (where i.currency = 'TRY')            as total_amount,
    max(i.amount) filter (where i.currency = 'TRY')            as largest_single,
    t.amount                                                   as threshold_amount,
    -- PHASE 2.2: aynı gün/aynı karşı tarafta TRY eşiğiyle tartılamayan kalemler. Sıfır değilse
    -- ekran "n kalem TRY-dışı, toplamda yok" demelidir (plan §2.3).
    count(*)      filter (where i.currency <> 'TRY')           as foreign_currency_count
  from public.payment_instances i
  join public.payments p on p.id = i.payment_id
  left join public.parties pa on pa.id = p.provider_party_id
  cross join threshold t
  where i.amount is not null and p.provider_party_id is not null
  group by p.provider_party_id, pa.name, i.due_date, t.amount
  having count(*)      filter (where i.currency = 'TRY') >= 2
     and sum(i.amount) filter (where i.currency = 'TRY') >= t.amount
     and max(i.amount) filter (where i.currency = 'TRY') <  t.amount;

-- ── 2) counterparty_exposure_items — para birimi kolonu ──────────────────────────────────
do $$
declare
  check_cur text := case when exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'checks' and column_name = 'currency')
    then 'c.currency' else '''TRY''::text' end;
  loan_cur text := case when exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'loans' and column_name = 'currency')
    then 'l.currency' else '''TRY''::text' end;
begin
  execute format($v$
    create or replace view public.counterparty_exposure_items as
      select
        coalesce(c.payee_party_id, c.payer_party_id) as party_id,
        'check'::text                                as source,
        c.id                                         as source_id,
        c.direction                                  as direction,
        c.amount                                     as amount,
        c.maturity_date                              as due_date,
        c.status                                     as status,
        %s                                           as currency
      from public.checks c
      where c.archived_at is null
        and c.status in ('planned', 'unknown')
        and coalesce(c.payee_party_id, c.payer_party_id) is not null

      union all

      select
        l.lender_party_id,
        'loan_installment',
        li.id,
        'outflow',
        li.amount,
        li.due_date,
        li.status,
        %s
      from public.loan_installments li
      join public.loans l on l.id = li.loan_id
      where l.archived_at is null
        and li.status in ('planned', 'unpaid', 'partial', 'late')
        and l.lender_party_id is not null

      union all

      select
        p.provider_party_id,
        'payment_instance',
        i.id,
        coalesce(i.direction, 'outflow'),
        i.amount,
        i.due_date,
        i.status,
        i.currency
      from public.payment_instances i
      join public.payments p on p.id = i.payment_id
      where p.archived_at is null
        and i.status in ('unpaid', 'partial', 'planned', 'late')
        and p.provider_party_id is not null
  $v$, check_cur, loan_cur);
end $$;

-- ── 3) counterparty_exposure — TRY-only toplamlar, limitle yalnız TRY'de karşılaştırma ──
create or replace view public.counterparty_exposure as
with items as (
  select * from public.counterparty_exposure_items
),
agg as (
  select
    i.party_id,
    count(*)                                                                    as item_count,
    count(*) filter (where i.amount is null)                                    as unknown_amount_count,
    -- PHASE 2.2: her para toplamı YALNIZ TRY. TRY-dışı kalem toplama girmez; foreign_currency_count sayar.
    coalesce(sum(i.amount) filter (where i.direction = 'outflow' and i.currency = 'TRY'), 0)       as outflow_amount,
    coalesce(sum(i.amount) filter (where i.direction = 'inflow'  and i.currency = 'TRY'), 0)       as inflow_amount,
    coalesce(sum(i.amount) filter (where i.source = 'check' and i.currency = 'TRY'), 0)            as check_amount,
    count(*) filter (where i.source = 'check')                                  as check_count,
    coalesce(sum(i.amount) filter (where i.source = 'loan_installment' and i.currency = 'TRY'), 0) as loan_amount,
    count(*) filter (where i.source = 'loan_installment')                       as loan_installment_count,
    coalesce(sum(i.amount) filter (where i.source = 'payment_instance' and i.currency = 'TRY'), 0) as payment_amount,
    count(*) filter (where i.source = 'payment_instance')                       as payment_count,
    min(i.due_date) filter (where i.amount is not null)                         as earliest_due_date,
    coalesce(sum(i.amount) filter (where i.direction = 'outflow' and i.currency = 'TRY'), 0)       as total_exposure,
    count(*) filter (where i.currency <> 'TRY')                                 as foreign_currency_count
  from items i
  group by i.party_id
)
select
  pa.id                        as party_id,
  pa.name                      as party_name,
  pa.party_type,
  pa.is_active,
  coalesce(a.item_count, 0)            as item_count,
  coalesce(a.unknown_amount_count, 0)  as unknown_amount_count,
  coalesce(a.outflow_amount, 0)        as outflow_amount,
  coalesce(a.inflow_amount, 0)         as inflow_amount,
  coalesce(a.check_amount, 0)          as check_amount,
  coalesce(a.check_count, 0)           as check_count,
  coalesce(a.loan_amount, 0)           as loan_amount,
  coalesce(a.loan_installment_count, 0) as loan_installment_count,
  coalesce(a.payment_amount, 0)        as payment_amount,
  coalesce(a.payment_count, 0)         as payment_count,
  a.earliest_due_date,
  coalesce(a.total_exposure, 0)        as total_exposure,
  case
    when sum(coalesce(a.total_exposure, 0)) over () > 0
      then round(coalesce(a.total_exposure, 0) / sum(coalesce(a.total_exposure, 0)) over (), 6)
  end                                  as exposure_ratio,
  cp.credit_limit,
  cp.credit_limit_currency,
  -- Limit karşılaştırması yalnız limit TRY iken anlamlı: total_exposure TRY-only, limit başka para
  -- birimindeyse oran ve aşım BİLİNMİYOR → null. (0039'daki "limit 0 → oran null" kuralı korunur.)
  case
    when cp.credit_limit is not null and cp.credit_limit > 0 and cp.credit_limit_currency = 'TRY'
      then round(coalesce(a.total_exposure, 0) / cp.credit_limit, 6)
  end                                  as credit_limit_utilization,
  case
    when cp.credit_limit is null then false
    when cp.credit_limit_currency <> 'TRY' then null
    when coalesce(a.total_exposure, 0) > cp.credit_limit then true
    else false
  end                                  as over_credit_limit,
  (select count(*) from public.ibans ib where ib.party_id = pa.id and ib.is_active) as active_iban_count,
  -- PHASE 2.2 — yeni kolonlar (sona eklendi; create or replace view kuralı)
  coalesce(a.foreign_currency_count, 0) as foreign_currency_count,
  (cp.credit_limit is not null and cp.credit_limit_currency = 'TRY') as credit_limit_comparable
from public.parties pa
left join agg a on a.party_id = pa.id
left join public.counterparty_profiles cp on cp.party_id = pa.id;

-- Erişim: 0039/0078'deki grant'lar view yeniden tanımlanınca korunur (aynı nesne). Yine de
-- açıkça yinelenir ki fresh DB'de sıra bağımsız kalsın.
grant select on public.anomaly_split_payments, public.counterparty_exposure_items,
                public.counterparty_exposure
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
