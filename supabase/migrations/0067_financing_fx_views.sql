-- Faz 27 — financing and FX read models. VIEWS; no stored balances, no stored gains.
--
-- All arithmetic is numeric end to end. There is deliberately not a single ::float8 in this file:
-- an FX revaluation is a difference between two nearly-equal large numbers, which is the exact
-- shape where binary floating point loses the answer, and `phase17:verify` fails the build if a
-- cast ever appears.

-- ── 1) facility utilisation: limit, drawn, available ───────────────────────────────────
--
-- `drawn` and `available` are computed here and stored nowhere. A stored utilisation column goes
-- stale on the very next drawdown and looks entirely plausible while wrong.
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
    coalesce(sum(d.signed_amount), 0)               as drawn_amount,
    -- Never below zero: an over-drawn line is a data problem to surface, not a negative headroom
    -- to propagate into every downstream sum.
    greatest(0, f.limit_amount - coalesce(sum(d.signed_amount), 0)) as available_amount,
    case
      when f.limit_amount = 0 then null
      else round(coalesce(sum(d.signed_amount), 0) / f.limit_amount, 4)
    end                                             as utilization_ratio,
    -- Surfaced explicitly rather than hidden by the greatest() above.
    (coalesce(sum(d.signed_amount), 0) > f.limit_amount) as over_limit,
    count(d.id)                                     as movement_count,
    max(d.movement_date)                            as last_movement_date,
    case
      when f.expiry_date is null then null
      else (f.expiry_date - current_date)
    end                                             as days_to_expiry
  from public.credit_facilities f
  left join public.parties p on p.id = f.lender_party_id
  left join public.facility_drawdowns d on d.facility_id = f.id
  group by f.id, f.name, f.facility_type, f.currency, f.status, p.name,
           f.limit_amount, f.interest_rate, f.start_date, f.expiry_date, f.review_date;

-- ── 2) debt maturity ladder: 30 / 90 / 180 / 365 days ──────────────────────────────────
--
-- Two genuinely different obligations sit in the same ladder, and they are labelled rather than
-- merged:
--   loan_installment  a dated amount that WILL leave the account.
--   facility_expiry   a limit that must be renewed or repaid. Not a cash outflow by itself — the
--                     drawn balance becomes due, the unused headroom simply disappears.
-- Summing the two into one "amount due" number would overstate the outflow by every unused lira
-- of limit, so the ladder reports them side by side and the exposure column counts only what is
-- actually drawn.
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
           coalesce(sum(u.drawn_amount), 0) as facility_drawn_expiring,
           coalesce(sum(u.limit_amount), 0) as facility_limit_expiring,
           count(u.facility_id)             as facility_count
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
    -- Real cash exposure in the bucket: instalments plus only the DRAWN part of expiring limits.
    (i.installment_due + e.facility_drawn_expiring) as total_cash_exposure
  from bounds b
  join installments i on i.sort_order = b.sort_order
  join expiries e on e.sort_order = b.sort_order;

-- ── 3) latest observed rate per pair ───────────────────────────────────────────────────
--
-- 'tcmb' wins over a hand-typed figure for the same day: the bulletin is the published fact and a
-- manual entry is a stand-in for it. Stated as an explicit ordering rather than left to whichever
-- row the planner returns.
create or replace view public.fx_latest_rates as
  select distinct on (base_currency, quote_currency)
    base_currency,
    quote_currency,
    rate_date,
    rate,
    source,
    fetched_at
  from public.fx_rate_snapshots
  order by base_currency, quote_currency, rate_date desc,
           case source when 'tcmb' then 0 when 'bank' then 1 when 'manual' then 2 else 3 end,
           fetched_at desc;

-- ── 4) revaluation, gain/loss and the stress bands ─────────────────────────────────────
--
-- DETERMINISTIC. Every figure is arithmetic on a recorded rate and a recorded position; there is
-- no model, no volatility estimate and no distribution. The ±5/10/20% bands are exactly that —
-- the same position valued at a rate moved by a fixed percentage — so a reader can reproduce any
-- cell with a calculator, which is the only kind of stress number worth showing an owner.
--
-- A position with no entry_rate yields a NULL gain/loss rather than a zero: we cannot know the
-- gain on an exposure whose entry rate was never recorded, and zero would assert that we do.
create or replace view public.fx_position_revaluation as
  select
    p.id                                     as position_id,
    p.currency,
    p.position_kind,
    p.amount                                 as amount_fx,
    p.entry_rate,
    p.as_of_date,
    r.rate                                   as current_rate,
    r.rate_date                              as rate_date,
    r.source                                 as rate_source,

    -- Book value at the rate the exposure entered at.
    case when p.entry_rate is null then null else round(p.amount * p.entry_rate, 2) end
      as book_value_try,
    -- Value at today's observed rate.
    case when r.rate is null then null else round(p.amount * r.rate, 2) end
      as current_value_try,
    -- Unrealised gain/loss. NULL when either side is unknown — never 0.
    case when p.entry_rate is null or r.rate is null then null
         else round(p.amount * (r.rate - p.entry_rate), 2) end
      as unrealized_gain_loss,

    -- Stress bands: the same position at a rate moved by a fixed percentage. Signed positions
    -- mean a liability automatically produces the opposite sign, which is the correct behaviour
    -- and the reason the position column is signed in the first place.
    case when r.rate is null then null else round(p.amount * r.rate * 1.05, 2) end as stress_up_5,
    case when r.rate is null then null else round(p.amount * r.rate * 0.95, 2) end as stress_down_5,
    case when r.rate is null then null else round(p.amount * r.rate * 1.10, 2) end as stress_up_10,
    case when r.rate is null then null else round(p.amount * r.rate * 0.90, 2) end as stress_down_10,
    case when r.rate is null then null else round(p.amount * r.rate * 1.20, 2) end as stress_up_20,
    case when r.rate is null then null else round(p.amount * r.rate * 0.80, 2) end as stress_down_20,

    -- The worst move for THIS position: a long position suffers when the currency falls, a short
    -- one when it rises. Reporting a single "±20% impact" without regard to sign would tell a
    -- treasurer their biggest liability was their biggest cushion.
    case when r.rate is null then null
         else round(p.amount * r.rate * (case when p.amount >= 0 then -0.20 else 0.20 end), 2) end
      as worst_case_20_delta
  from public.fx_positions p
  left join public.fx_latest_rates r
    on r.base_currency = p.currency and r.quote_currency = 'TRY'
  where p.is_active;

-- ── 5) net exposure per currency ───────────────────────────────────────────────────────
create or replace view public.fx_exposure_summary as
  select
    v.currency,
    count(*)                                          as position_count,
    sum(v.amount_fx)                                  as net_amount_fx,
    sum(v.current_value_try)                          as net_value_try,
    sum(v.unrealized_gain_loss)                       as net_unrealized_gain_loss,
    sum(v.worst_case_20_delta)                        as worst_case_20_delta,
    max(v.rate_date)                                  as rate_date,
    -- How many positions could not be revalued at all, so a summary can never quietly look
    -- complete while resting on missing rates.
    count(*) filter (where v.current_rate is null)    as positions_without_rate,
    count(*) filter (where v.entry_rate is null)      as positions_without_entry_rate
  from public.fx_position_revaluation v
  group by v.currency;

grant select on public.credit_facility_utilization to authenticated;
grant select on public.debt_maturity_ladder to authenticated;
grant select on public.fx_latest_rates to authenticated;
grant select on public.fx_position_revaluation to authenticated;
grant select on public.fx_exposure_summary to authenticated;
