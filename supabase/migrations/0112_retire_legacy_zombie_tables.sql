-- 0112 — Eski Zombi Tablo/Görünüm Emekliliği (A4 / F-17) ve
-- Tüm public Görünümlerde %100 security_invoker = true Zorlaması (F-13).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Tüm görünümler WITH (security_invoker = true) taşır.

-- ── 1) facility_drawdowns satırlarını kayıpsız facility_movements tablosuna taşı (varsa) ────────
do $$
begin
  if to_regclass('public.facility_drawdowns') is not null then
    -- Taşıma sırasında drawn_amount zaten 0103 ile hizalandığı için sync/period-lock tetikleyicilerini
    -- geçici kapatıp ardından credit_facilities.drawn_amount değerini net hareketlerden yeniden hesapla.
    alter table public.facility_movements disable trigger user;

    insert into public.facility_movements (
      id,
      facility_id,
      movement_type,
      movement_date,
      amount,
      currency,
      notes,
      created_by,
      created_at
    )
    select
      d.id,
      d.facility_id,
      case when d.movement_type in ('drawdown', 'repayment') then d.movement_type else 'drawdown' end,
      d.movement_date,
      abs(d.amount),
      d.currency,
      d.notes,
      d.created_by,
      d.created_at
    from public.facility_drawdowns d
    where abs(d.amount) > 0
    on conflict (id) do nothing;

    alter table public.facility_movements enable trigger user;

    update public.credit_facilities f
       set drawn_amount = greatest(
         0,
         coalesce((
           select sum(
             case when m.movement_type = 'drawdown' then m.amount else -m.amount end
           )
           from public.facility_movements m
           where m.facility_id = f.id
             and m.currency = f.currency
             and m.movement_type in ('drawdown', 'repayment')
         ), 0)
       );
  end if;
end $$;

-- ── 2) credit_facility_utilization görünümünü yalnız facility_movements üzerinden kur ───────────
create or replace view public.credit_facility_utilization
with (security_invoker = true) as
  with all_movements as (
    select
      m.id,
      m.facility_id,
      m.movement_date,
      m.currency,
      case when m.movement_type = 'drawdown' then m.amount else -m.amount end as signed_amount
    from public.facility_movements m
    where m.movement_type in ('drawdown', 'repayment')
  )
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
    count(d.id) filter (where d.currency <> f.currency) as foreign_drawdown_count
  from public.credit_facilities f
  left join public.parties p on p.id = f.lender_party_id
  left join all_movements d on d.facility_id = f.id
  group by f.id, f.name, f.facility_type, f.currency, f.status, p.name,
           f.limit_amount, f.interest_rate, f.start_date, f.expiry_date, f.review_date;

-- ── 3) Gerçek zombi tablo/görünüm kalıntılarını emekli et (F-17) ───────────────────────────────
drop table if exists public.facility_drawdowns;
drop view if exists public.working_capital_trend_reference;
drop view if exists public.forecast_accuracy_log;
drop table if exists public.forecast_accuracy_log;

-- ── 4) public şemasındaki TÜM görünümlerde security_invoker = true ve 5-katman SELECT izni (F-13)
do $$
declare
  v record;
begin
  for v in
    select c.relname as view_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'v'
     order by c.relname
  loop
    execute format('alter view public.%I set (security_invoker = true)', v.view_name);
    execute format(
      'grant select on public.%I to mas_radar_viewer, mas_radar_finance_operator, '
      || 'mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      v.view_name
    );
  end loop;
end $$;
