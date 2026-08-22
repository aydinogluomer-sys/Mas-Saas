-- Faz 25 — collection read models. VIEWS, never stored tables.
--
-- Same reasoning Faz 19/22/23 recorded: a stored score is a second source of truth that goes
-- stale the moment an invoice is settled, and the staleness is invisible because the number
-- still looks like a number. Everything here is computed from promise_to_pay, the Faz 23
-- collection signals, and the invoices themselves, so it cannot disagree with them.

-- ── 1) open promises, with reality attached ────────────────────────────────────────────
create or replace view public.promise_to_pay_open as
  select
    p.id                              as promise_id,
    p.party_id,
    pa.name                           as party_name,
    p.invoice_id,
    p.promised_amount,
    p.currency,
    p.promised_date,
    p.channel,
    p.note,
    p.created_at,
    -- Positive once the promised date has passed. Named `days_late` rather than `days_overdue`
    -- so it can never be confused with an invoice's overdue count in a join — they measure
    -- different things and a collections screen shows both.
    (current_date - p.promised_date)  as days_late,
    (p.promised_date < current_date)  as is_overdue
  from public.promise_to_pay p
  join public.parties pa on pa.id = p.party_id
  where p.status = 'pending';

-- ── 2) per-party promise history ───────────────────────────────────────────────────────
-- Counts every resolved promise. 'cancelled' is deliberately excluded from the kept/broken
-- ratio: a withdrawn promise says nothing about whether the customer pays, and letting it count
-- as either would move a score for a reason no one could explain from the customer's behaviour.
create or replace view public.party_promise_history as
  select
    p.party_id,
    count(*) filter (where p.status in ('kept', 'broken'))            as resolved_count,
    count(*) filter (where p.status = 'kept')                          as kept_count,
    count(*) filter (where p.status = 'broken')                        as broken_count,
    count(*) filter (where p.status = 'pending')                       as pending_count,
    count(*) filter (where p.status = 'cancelled')                     as cancelled_count,
    coalesce(sum(p.promised_amount) filter (where p.status = 'pending'), 0) as pending_amount,
    -- NULL rather than 0 when nothing has resolved yet: a customer who has made no promise is
    -- not a customer who breaks them, and the score below must be able to tell those apart.
    case
      when count(*) filter (where p.status in ('kept', 'broken')) = 0 then null
      else round(
        count(*) filter (where p.status = 'kept')::numeric
        / count(*) filter (where p.status in ('kept', 'broken')),
        4)
    end                                                                as kept_ratio,
    max(p.promised_date) filter (where p.status = 'broken')            as last_broken_date
  from public.promise_to_pay p
  group by p.party_id;

-- ── 3) customer collection score ───────────────────────────────────────────────────────
--
-- DETERMINISTIC AND NAMED, never learned. The score starts at 100 and every deduction is a rule
-- with a name that travels with the number in `score_reasons`. That is the Faz 23 convention and
-- it exists because a collections score gets used to justify a decision to a customer: "82,
-- because two promises were broken and the oldest invoice is 47 days overdue" can be defended,
-- and a bare 82 cannot.
--
-- Arithmetic is numeric throughout — no ::float8 anywhere (Faz 17).
create or replace view public.customer_collection_score as
  with base as (
    select
      pa.id                                        as party_id,
      pa.name                                      as party_name,
      coalesce(cp.open_receivable_count, 0)        as open_receivable_count,
      coalesce(cp.open_receivable_amount, 0)       as open_receivable_amount,
      coalesce(cp.overdue_count, 0)                as overdue_count,
      coalesce(cp.overdue_amount, 0)               as overdue_amount,
      coalesce(cp.bad_debt_count, 0)               as bad_debt_count,
      coalesce(cp.worst_days_overdue, 0)           as worst_days_overdue,
      cp.late_ratio,
      coalesce(ph.resolved_count, 0)               as promise_resolved_count,
      coalesce(ph.kept_count, 0)                   as promise_kept_count,
      coalesce(ph.broken_count, 0)                 as promise_broken_count,
      coalesce(ph.pending_count, 0)                as promise_pending_count,
      coalesce(ph.pending_amount, 0)               as promise_pending_amount,
      ph.kept_ratio                                as promise_kept_ratio
    from public.parties pa
    -- LEFT joins on purpose: a party with promises but no open receivable, or with receivables
    -- but no promises, must still get a score. counterparty_collection_profile inner-joins its
    -- signals, so joining it any other way would drop exactly those parties.
    left join public.counterparty_collection_profile cp on cp.party_id = pa.id
    left join public.party_promise_history ph on ph.party_id = pa.id
  ),
  scored as (
    select
      b.*,
      -- Each term is a named rule. Written as explicit CASE ladders rather than a formula so the
      -- boundary between bands is visible and testable.
      (case when b.worst_days_overdue >= 90 then 30
            when b.worst_days_overdue >= 60 then 20
            when b.worst_days_overdue >= 30 then 12
            when b.worst_days_overdue >= 1  then 5
            else 0 end)                                        as pen_overdue_age,
      (case when b.bad_debt_count > 0 then 25 else 0 end)       as pen_bad_debt,
      -- Promise behaviour only scores once something has actually resolved. A brand-new customer
      -- is not penalised for having no history — absence of evidence is not evidence.
      (case when b.promise_kept_ratio is null then 0
            when b.promise_kept_ratio < 0.34 then 25
            when b.promise_kept_ratio < 0.67 then 15
            when b.promise_kept_ratio < 1.00 then 7
            else 0 end)                                        as pen_broken_promises,
      (case when b.late_ratio is null then 0
            when b.late_ratio >= 0.75 then 15
            when b.late_ratio >= 0.50 then 10
            when b.late_ratio >= 0.25 then 5
            else 0 end)                                        as pen_late_settlement
    from base b
  )
  select
    s.party_id,
    s.party_name,
    s.open_receivable_count,
    s.open_receivable_amount,
    s.overdue_count,
    s.overdue_amount,
    s.bad_debt_count,
    s.worst_days_overdue,
    s.late_ratio,
    s.promise_resolved_count,
    s.promise_kept_count,
    s.promise_broken_count,
    s.promise_pending_count,
    s.promise_pending_amount,
    s.promise_kept_ratio,
    -- Clamped into 0..100 so the number always means the same thing, however many rules fire.
    greatest(0, 100 - (s.pen_overdue_age + s.pen_bad_debt + s.pen_broken_promises + s.pen_late_settlement))
      as collection_score,
    -- The band an operator reads. Thresholds are stated once, here, so a screen cannot invent
    -- its own colouring.
    case
      when greatest(0, 100 - (s.pen_overdue_age + s.pen_bad_debt + s.pen_broken_promises + s.pen_late_settlement)) >= 85 then 'good'
      when greatest(0, 100 - (s.pen_overdue_age + s.pen_bad_debt + s.pen_broken_promises + s.pen_late_settlement)) >= 60 then 'watch'
      when greatest(0, 100 - (s.pen_overdue_age + s.pen_bad_debt + s.pen_broken_promises + s.pen_late_settlement)) >= 35 then 'risk'
      else 'critical'
    end as score_band,
    -- Every rule that actually deducted, by name. An empty array means a clean score of 100 and
    -- says so honestly rather than leaving the reader to infer it.
    array_remove(array[
      case when s.pen_overdue_age     > 0 then 'gecikmis_fatura_yasi'     end,
      case when s.pen_bad_debt        > 0 then 'suepheli_alacak'          end,
      case when s.pen_broken_promises > 0 then 'tutulmayan_odeme_sozu'    end,
      case when s.pen_late_settlement > 0 then 'gec_odeme_aliskanligi'    end
    ], null) as score_reasons
  from scored s;

grant select on public.promise_to_pay_open to authenticated;
grant select on public.party_promise_history to authenticated;
grant select on public.customer_collection_score to authenticated;
