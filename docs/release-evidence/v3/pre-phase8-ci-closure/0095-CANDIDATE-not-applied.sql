-- 0095 (ADAY — repoya YAZILMADI, kullanıcı kararı bekliyor) — PRE-PHASE8 CI CLOSURE CI-4 + CI-6
--
-- CI-4: 0094 `working_capital_trend`'i TRY-only yaparken `v.currency` ve `count(v.id)` ile 0082'nin
-- kapsayan indeksinin dışına çıktı; index-only yol kayboldu (460.627 buffer vs 7.188). Düzeltme:
-- issue_date öncülüklü kapsayan indeks + count(*) (LEFT JOIN'de eşleşmeyen satırlar için filtre NULL →
-- sayılmaz; count(v.id) ile aynı sonuç, ama `id` heap'ten okunmaz). View metni başka hiçbir yerde
-- değişmez; kolon listesi ve sırası 0094 ile birebir.
--
-- CI-6: 0088 import_external_keys'in iki workbook FK'si indekssiz (perf ratchet 116 > 115).
create index if not exists invoices_issue_cover_try
  on public.invoices (issue_date)
  include (direction, status, currency, gross_amount, allocated_amount);

create index if not exists import_external_keys_first_seen_workbook_idx
  on public.import_external_keys (first_seen_workbook_id);
create index if not exists import_external_keys_last_seen_workbook_idx
  on public.import_external_keys (last_seen_workbook_id);

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
      count(*) filter (where v.status <> 'cancelled' and v.currency <> 'TRY') as foreign_currency_count
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

