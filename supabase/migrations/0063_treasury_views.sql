-- Faz 26 — treasury read models. VIEWS only; this migration creates no new source data.
--
-- Everything here is derived from tables that already exist: Faz 20's bank_accounts /
-- bank_transactions, the cash_accounts they hang off, the dated obligations (payment_instances,
-- checks, loan_installments, invoices, promise_to_pay), and Faz 4/5's cashflow_months. Treasury
-- is a LENS on that data, not a second ledger — which is also why the reconciliation view at the
-- bottom exists rather than a "corrected" balance column somewhere.
--
-- CURRENCIES ARE NEVER NETTED. Every position is grouped by currency and no view sums across
-- them. There is no FX rate table until Faz 27, so adding TRY to EUR here would require
-- inventing a rate, and a treasury screen that silently invents a rate is worse than one that
-- shows two rows.

-- ── 1) per-account position: BOTH sources, and their difference ────────────────────────
--
-- There are two honest answers to "how much is in this account", and they disagree in practice:
--
--   stated   bank_accounts.available_balance, as of balance_as_of — what the bank told us at the
--            last statement.
--   derived  the running sum of bank_transactions we have actually imported, on top of
--            cash_accounts.opening_balance.
--
-- Picking one silently would be the whole failure mode this phase is warned about. Both are
-- exposed, with the difference and a label, so a screen can show the gap instead of hiding it.
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
    -- Only settled movement counts toward a derived balance. 'ignored' rows are explicitly not
    -- money (0042), and an unmatched row is still a real bank movement, so it DOES count —
    -- matching is about linking it to a document, not about whether it happened.
    coalesce(ca.opening_balance, 0)
      + coalesce(sum(bt.amount) filter (where bt.status <> 'ignored'), 0) as derived_balance,
    count(bt.id) filter (where bt.status <> 'ignored')                    as movement_count,
    max(bt.txn_date)                                                      as last_movement_date,
    case
      when ba.available_balance is null then null
      else ba.available_balance
           - (coalesce(ca.opening_balance, 0)
              + coalesce(sum(bt.amount) filter (where bt.status <> 'ignored'), 0))
    end                                                                   as stated_minus_derived
  from public.cash_accounts ca
  left join public.bank_accounts ba on ba.cash_account_id = ca.id
  left join public.bank_transactions bt on bt.bank_account_id = ba.cash_account_id
  group by ca.id, ca.name, ca.currency, ca.is_active, ba.bank_name, ba.iban,
           ba.available_balance, ba.blocked_balance, ba.overdraft_limit, ba.balance_as_of,
           ca.opening_balance;

-- ── 2) daily movement and running position ─────────────────────────────────────────────
create or replace view public.daily_cash_movement as
  select
    bt.txn_date,
    ca.currency,
    sum(bt.amount) filter (where bt.amount > 0)  as inflow,
    sum(bt.amount) filter (where bt.amount < 0)  as outflow,
    sum(bt.amount)                               as net_movement,
    count(*)                                     as movement_count,
    -- Running position per currency, in date order. A window function rather than a stored
    -- column: the number must never be able to drift from the rows it is computed from.
    sum(sum(bt.amount)) over (partition by ca.currency order by bt.txn_date)
      as running_net
  from public.bank_transactions bt
  join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
  join public.cash_accounts ca on ca.id = ba.cash_account_id
  where bt.status <> 'ignored'
  group by bt.txn_date, ca.currency;

-- ── 3) position summary by currency ────────────────────────────────────────────────────
create or replace view public.treasury_position_summary as
  select
    p.currency,
    count(*)                                        as account_count,
    sum(p.derived_balance)                          as total_derived_balance,
    sum(p.stated_balance)                           as total_stated_balance,
    sum(coalesce(p.blocked_balance, 0))             as total_blocked,
    sum(coalesce(p.overdraft_limit, 0))             as total_overdraft_limit,
    -- Spendable today: derived position less what is blocked, plus committed overdraft.
    sum(p.derived_balance) - sum(coalesce(p.blocked_balance, 0))            as available_now,
    sum(p.derived_balance) - sum(coalesce(p.blocked_balance, 0))
      + sum(coalesce(p.overdraft_limit, 0))                                 as available_with_overdraft,
    count(*) filter (where p.stated_minus_derived is not null
                       and abs(p.stated_minus_derived) > 0.01)              as accounts_with_gap
  from public.bank_cash_position p
  where p.is_active
  group by p.currency;

-- ── 4) dated liquidity forecast ────────────────────────────────────────────────────────
--
-- Every row is a KNOWN, DATED obligation or expectation already recorded somewhere else. This
-- view invents no flows and forecasts no trend — it collects what the database already says is
-- due, which is what makes it reconcilable against cashflow_months rather than a rival opinion.
--
-- `certainty` separates a contractual obligation from a customer's stated intention. A promise
-- to pay is included because a treasurer plans with it, but it must never be summed as if it
-- carried the same weight as a signed instalment, so the column is there to be filtered on.
create or replace view public.liquidity_forecast_daily as
  -- outflow: scheduled payment instances
  select
    pi.due_date                                   as flow_date,
    coalesce(pi.currency, 'TRY')                  as currency,
    'payment_instance'::text                      as source_kind,
    pi.id                                         as source_id,
    -- Outflows are negative so every consumer can simply sum this column.
    -case when pi.direction = 'inflow' then -pi.amount else pi.amount end as amount_signed,
    'contracted'::text                            as certainty
  from public.payment_instances pi
  where pi.status in ('unpaid', 'partial') and pi.due_date is not null and pi.amount is not null

  union all
  select li.due_date, 'TRY', 'loan_installment', li.id, -li.amount, 'contracted'
  from public.loan_installments li
  where li.status in ('unpaid', 'partial') and li.due_date is not null and li.amount is not null

  union all
  -- Checks already carry a signed amount (0009): outflow negative, inflow positive.
  select c.maturity_date, 'TRY', 'check', c.id, c.signed_amount, 'contracted'
  from public.checks c
  where c.status in ('unpaid', 'partial', 'planned')
    and c.maturity_date is not null and c.signed_amount is not null

  union all
  -- Invoices: sales bring money in, purchases take it out. Only the still-open portion.
  select v.due_date, 'TRY', 'invoice', v.id,
         case when v.direction = 'sales'
              then (v.gross_amount - coalesce(v.allocated_amount, 0))
              else -(v.gross_amount - coalesce(v.allocated_amount, 0)) end,
         'contracted'
  from public.invoices v
  where v.status in ('open', 'partial') and v.due_date is not null and v.gross_amount is not null

  union all
  -- Faz 25 promises. NULL amount is excluded rather than counted as zero: an unknown figure
  -- cannot be added to a forecast total, and pretending it is 0,00 would understate nothing
  -- while overstating certainty.
  select p.promised_date, p.currency, 'promise_to_pay', p.id, p.promised_amount, 'expected'
  from public.promise_to_pay p
  where p.status = 'pending' and p.promised_amount is not null;

-- ── 5) liquidity gap against the configured floor ──────────────────────────────────────
--
-- Horizons are 7/30/90 DAYS, per the plan. The month-based horizons of Faz 4/5 (horizonCards)
-- are untouched and still answer their own question; this is the short-horizon treasury view of
-- the same underlying obligations.
create or replace view public.treasury_liquidity_gap as
  with horizons(days) as (values (7), (30), (90)),
  pos as (
    select currency, available_now, available_with_overdraft
    from public.treasury_position_summary
  ),
  floors as (
    -- The configured floor. Only the account-wide policy (cash_account_id is null) applies to a
    -- currency-level total; a per-account floor is checked per account elsewhere.
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
    group by h.days, f.currency
  )
  select
    h.days                                                as horizon_days,
    p.currency,
    p.available_now,
    p.available_with_overdraft,
    coalesce(fl.contracted_net, 0)                        as contracted_net_flow,
    coalesce(fl.all_net, 0)                               as expected_net_flow,
    -- Two projections, deliberately. The conservative one counts only contractual flows; the
    -- optimistic one also believes the promises. A treasurer needs to see both numbers, and a
    -- single blended figure would hide which assumption produced it.
    p.available_now + coalesce(fl.contracted_net, 0)      as projected_contracted,
    p.available_now + coalesce(fl.all_net, 0)             as projected_expected,
    coalesce(fx.threshold_amount, 0)                      as min_cash_floor,
    -- Shortfall is positive when the floor is breached, zero otherwise — never negative, so a
    -- "financing need" column can be summed without filtering.
    greatest(0, coalesce(fx.threshold_amount, 0)
                - (p.available_now + coalesce(fl.contracted_net, 0)))      as financing_need,
    (p.available_now + coalesce(fl.contracted_net, 0)) < coalesce(fx.threshold_amount, 0)
                                                          as breaches_floor
  from horizons h
  cross join pos p
  left join flows fl on fl.days = h.days and fl.currency = p.currency
  left join floors fx on fx.currency = p.currency;

-- ── 6) THE CONSISTENCY VIEW ────────────────────────────────────────────────────────────
--
-- The plan's gate requirement, made into a first-class read model rather than a one-off assertion
-- in a script: the treasury position must never SILENTLY diverge from cashflow_months'
-- closing_balance.
--
-- The two numbers come from genuinely different places — cashflow_months is the reviewed monthly
-- workbook projection, the treasury figure is the sum of imported bank movements — so they CAN
-- differ, and often legitimately will (a month with no statement imported yet will differ by the
-- whole month). This view does not reconcile them, does not average them, and does not prefer
-- one. It puts them side by side with the difference and a reason label, so the divergence is a
-- visible fact rather than a silent one.
--
-- Anything else would be the failure mode CLAUDE.md names directly: inferring final truth from
-- ambiguous rows.
create or replace view public.treasury_cashflow_reconciliation as
  with month_end as (
    select
      date_trunc('month', bt.txn_date)::date          as month_start,
      ca.currency,
      sum(bt.amount)                                   as month_net
    from public.bank_transactions bt
    join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
    join public.cash_accounts ca on ca.id = ba.cash_account_id
    where bt.status <> 'ignored'
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
  order by cm.month_start;

grant select on public.bank_cash_position to authenticated;
grant select on public.daily_cash_movement to authenticated;
grant select on public.treasury_position_summary to authenticated;
grant select on public.liquidity_forecast_daily to authenticated;
grant select on public.treasury_liquidity_gap to authenticated;
grant select on public.treasury_cashflow_reconciliation to authenticated;
